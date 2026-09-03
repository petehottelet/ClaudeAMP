"use strict";

/* The pre-arm halo is what keeps fast clicks on a panel edge from falling
   through to the app behind on macOS (clicks are never forwarded while the
   window ignores the mouse). Pin its geometry and cadence choices. */

const test = require("node:test");
const assert = require("node:assert");
const { ENTER_MARGIN, NEAR_MS, FAR_MS, decide } = require("../electron/mac-hittest.cjs");

const RECTS = [
  { x: 100, y: 100, width: 200, height: 50 },
  { x: 100, y: 150, width: 200, height: 300 }, // welded directly below
];

test("a point inside a panel is over, near, and polled fast", () => {
  const d = decide(RECTS, 150, 120);
  assert.deepStrictEqual(d, { over: true, near: true, cadence: NEAR_MS });
});

test("a point just outside an edge pre-arms without being a strict hit", () => {
  const d = decide(RECTS, 100 - (ENTER_MARGIN - 1), 120);
  assert.strictEqual(d.over, false);
  assert.strictEqual(d.near, true);
  assert.strictEqual(d.cadence, NEAR_MS);
});

test("the halo ends exactly at ENTER_MARGIN", () => {
  // insideRect uses x >= rect.x - pad, so rect.x - ENTER_MARGIN still arms...
  assert.strictEqual(decide(RECTS, 100 - ENTER_MARGIN, 120).near, true);
  // ...and one DIP further out is desktop again, at the relaxed cadence.
  const d = decide(RECTS, 100 - ENTER_MARGIN - 1, 120);
  assert.deepStrictEqual(d, { over: false, near: false, cadence: FAR_MS });
});

test("the halo wraps corners diagonally", () => {
  const d = decide(RECTS, 100 - 5, 100 - 5);
  assert.strictEqual(d.over, false);
  assert.strictEqual(d.near, true);
});

test("a seam between welded panels is a strict hit, not just a halo", () => {
  assert.strictEqual(decide(RECTS, 150, 150).over, true);
});

test("no rects means never interactive, at the relaxed cadence", () => {
  assert.deepStrictEqual(decide([], 0, 0), { over: false, near: false, cadence: FAR_MS });
  assert.deepStrictEqual(decide(null, 0, 0), { over: false, near: false, cadence: FAR_MS });
});

test("a custom margin overrides ENTER_MARGIN", () => {
  assert.strictEqual(decide(RECTS, 100 - 15, 120, 16).near, true);
  assert.strictEqual(decide(RECTS, 100 - 15, 120, 8).near, false);
});

test("the halo grows with cursor speed and stays within its bounds", () => {
  const { MAX_MARGIN, armMargin } = require("../electron/mac-hittest.cjs");
  // stationary or slow: the base halo
  assert.strictEqual(armMargin(0), ENTER_MARGIN);
  assert.strictEqual(armMargin(10), ENTER_MARGIN);
  // a fast approach arms proportionally further out...
  assert.strictEqual(armMargin(40), 60);
  // ...but a wild flick cannot arm the whole desktop
  assert.strictEqual(armMargin(500), MAX_MARGIN);
  // garbage travel values degrade to the base halo, never to zero
  assert.strictEqual(armMargin(NaN), ENTER_MARGIN);
  assert.strictEqual(armMargin(undefined), ENTER_MARGIN);
});

test("shape reports never re-ignore the window, and nothing pauses the poll", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const read = f => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const main = read("electron/main.cjs");
  const native = read("js/native.js");
  const app = read("js/app.js");
  const proofs = read("electron/verify-proof.cjs");
  const pkg = require("../package.json");
  // The bug behind 1.7.3's "clicks fall through after resting": the
  // first-show arming (macSetIgnore(true)) ran on every shape report.
  // maybeShow now arms once and only re-decides afterwards.
  assert.match(main, /if \(macArmed\) \{[\s\S]*macKick\(\);[\s\S]*return;[\s\S]*\}\s*macArmed = true;/);
  assert.equal((main.match(/macSetIgnore\(true\)/g) || []).length, 1,
    "macSetIgnore(true) may appear only in the one-shot first-show arming");
  assert.match(proofs, /macShapeReportKeepsInteractive/);
  // The mac runner also exercises: sustained churn under a setIgnoreMouseEvents
  // spy, the renderer hit-test path, an overflowing popup, the single-stepped
  // poll under a controlled cursor, and (capability-gated, reported) real
  // HID events against the NSWindow flag itself.
  for (const name of ["macRestingCursorSurvivesReports", "macUnchangedShapeNotResent",
    "macRendererHitTestArms", "macPopupInNativeShape", "macPollParkedOnGapIgnores",
    "macPollArmsInOneTick", "macPollFollowsRealCursor", "macNativeIgnoreDropsClick"])
    assert.match(proofs, new RegExp(name));
  assert.match(main, /setMacCursor\(point\)/);
  assert.match(main, /stepMacPoll\(\) \{ return macPollOnce\(\); \}/);
  // Report storm: the ticker wrote `hidden` every frame (a same-value
  // assignment still queues a mutation record), and native.js re-sent an
  // unchanged shape on each; both ends now only act on real change.
  assert.match(app, /if \(mbNoteEl\.hidden !== noteHidden\) mbNoteEl\.hidden = noteHidden;/);
  assert.match(native, /if \(forceReport \|\| key !== lastReport\)/);
  assert.match(native, /setInterval\(\(\) => \{ forceReport = true; scheduleShape\(\); \}, 1000\)/);
  // The poll: no App Nap (plist opt-out), no renderer throttling, not gated
  // on Electron's accidental isVisible(), re-decided on activation/focus.
  assert.strictEqual(pkg.build.mac.extendInfo.NSAppSleepDisabled, true);
  assert.match(main, /backgroundThrottling:\s*false/);
  assert.doesNotMatch(main, /win\.isVisible\(\)\)\s*\{[\s\S]{0,80}getCursorScreenPoint/);
  assert.match(main, /!win\.isMinimized\(\)\)\s*\{/);
  assert.match(main, /app\.on\("did-become-active", \(\) => macKick\(\)\)/);
  assert.match(main, /app\.on\("browser-window-focus", \(\) => macKick\(\)\)/);
  // powerSaveBlocker("prevent-app-suspension") is a no-idle-sleep assertion
  // on macOS (keeps the Mac awake) and does nothing for App Nap: gone.
  assert.doesNotMatch(main, /powerSaveBlocker/);
});
