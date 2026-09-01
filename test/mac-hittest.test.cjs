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

test("the poll is protected from App Nap and renderer throttling", () => {
  // macOS coalesced the 6-16ms cursor poll into multi-second ticks once it
  // judged the transparent overlay idle/occluded; the first click after a
  // pause then fell through to the app behind. The poll IS the input path,
  // so suspension stays off at all three layers.
  const fs = require("node:fs");
  const path = require("node:path");
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  const pkg = require("../package.json");
  assert.match(main, /powerSaveBlocker\.start\("prevent-app-suspension"\)/);
  assert.match(main, /backgroundThrottling:\s*false/);
  assert.strictEqual(pkg.build.mac.extendInfo.NSAppSleepDisabled, true);
  // any wake re-decides immediately instead of waiting out a stretched timer
  assert.match(main, /app\.on\("activate", kick\)/);
  assert.match(main, /app\.on\("browser-window-focus", kick\)/);
});
