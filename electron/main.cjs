"use strict";

/* ClaudeAmp native shell.
   A single shared renderer spans the available desktop, while setShape clips
   its native hit region to the visible player panels. Transparent gaps are
   genuine desktop: no browser chrome and no invisible bounding rectangle. */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, screen, shell, utilityProcess } = require("electron");
const { readyMarker, readyProbe, readyScreenReset, hasReadyMarker,
  stripReadyProbe } = require("./terminal-protocol.cjs");
const { resolveLoginShell, loginShellArgs } = require("./terminal-platform.cjs");
const macHittest = require("./mac-hittest.cjs");
const { isNewerVersion } = require("./version-check.cjs");
const https = require("https");

const valueArg = name => {
  const prefix = "--" + name + "=";
  const found = process.argv.find(value => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : "";
};
const smokeReport = valueArg("smoke-report");
const smokeScreenshot = valueArg("smoke-screenshot");
const smokeAbout = process.argv.includes("--smoke-about");
const smokeSettings = process.argv.includes("--smoke-settings");
const smokeSettingsMusic = process.argv.includes("--smoke-settings-music");
const smokeVisualizationResults = process.argv.includes("--smoke-visualization-results");
const verifyReport = valueArg("verify-report");
if (smokeReport || verifyReport)
  app.setPath("userData", path.join(os.tmpdir(), "claudeamp-smoke-" + process.pid));
// CI must never hang on a wedged verify run: hard exit after 140s, leaving a
// failure report behind so the runner log says what happened.
if (verifyReport) setTimeout(() => {
  try {
    if (!fs.existsSync(verifyReport)) {
      fs.mkdirSync(path.dirname(verifyReport), { recursive: true });
      fs.writeFileSync(verifyReport, JSON.stringify(
        { ok: false, platform: process.platform, failures: ["watchdog-timeout"],
          detail: "the app never finished the verify proof within 90s" }, null, 2));
    }
  } catch (_) {}
  try { process.exit(3); } catch (_) {}
}, 140000).unref();

const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();
if (process.platform === "win32") app.setAppUserModelId("com.claudeamp.desktop");

let win = null;
let bridge = null;
let readyToShow = false;
let receivedShape = false;
let smokeStarted = false;
let lastShape = [];
let shapeRevision = 0;
let shapeApplyError = "";
let macPoll = null;
let macIgnoring = null;
const settingsPath = () => path.join(app.getPath("userData"), "desktop-settings.json");

// A taskbar icon must resolve to a real filesystem resource. An icon inside
// app.asar is readable by Electron, but Windows Explorer and its pinned-icon
// cache cannot reliably resolve that virtual path. The installer places this
// dedicated copy beside app.asar; development keeps using the source asset.
function appIconPath() {
  const packagedIcon = path.join(process.resourcesPath, "claw-icon.ico");
  return app.isPackaged && fs.existsSync(packagedIcon)
    ? packagedIcon
    : path.join(__dirname, "..", "assets", "claw-icon.ico");
}

function readDesktopSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), "utf8")); }
  catch (_) { return {}; }
}

function writeDesktopSettings(value) {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(value, null, 2));
  } catch (_) {}
}

// GUI launches often inherit a smaller PATH than a terminal. Include the
// conventional user-level CLI locations before bridge.js probes Claude/Codex.
function widenPath() {
  const home = os.homedir();
  const extra = process.platform === "win32" ? [
    path.join(home, "AppData", "Roaming", "npm"),
    path.join(home, ".local", "bin"),
  ] : [
    "/usr/local/bin", "/opt/homebrew/bin",
    path.join(home, ".local", "bin"), path.join(home, "bin"),
  ];
  const have = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  process.env.PATH = have.concat(extra.filter(item => !have.includes(item))).join(path.delimiter);
}

function desktopBounds() {
  // macOS will not let one window span displays: a union-of-displays rect
  // gets clamped, which both clips the UI mid-screen and skews the cursor
  // hit-test. One display only there; the union is fine on Windows/Linux.
  if (process.platform === "darwin") return screen.getPrimaryDisplay().workArea;
  const areas = screen.getAllDisplays().map(display => display.workArea);
  const left = Math.min(...areas.map(area => area.x));
  const top = Math.min(...areas.map(area => area.y));
  const right = Math.max(...areas.map(area => area.x + area.width));
  const bottom = Math.max(...areas.map(area => area.y + area.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function safeShape(rects) {
  if (!win || win.isDestroyed() || !Array.isArray(rects)) return [];
  const { width: maxWidth, height: maxHeight } = win.getContentBounds();
  return rects.slice(0, 64).map(rect => {
    // True intersection with the content bounds. Clamping x to 0 while
    // leaving the width alone would slide a panel hanging off the left
    // edge back on screen as a phantom clickable strip at x=0.
    const left = Math.floor(Number(rect?.x) || 0);
    const top = Math.floor(Number(rect?.y) || 0);
    const right = Math.min(maxWidth, left + Math.ceil(Number(rect?.width) || 0));
    const bottom = Math.min(maxHeight, top + Math.ceil(Number(rect?.height) || 0));
    const x = Math.max(0, left);
    const y = Math.max(0, top);
    return { x, y, width: right - x, height: bottom - y };
  }).filter(rect => rect.width > 0 && rect.height > 0);
}

/* macOS click-through. Electron cannot clip a native window region on darwin,
   so the full-desktop transparent window would swallow every click. Two
   independent signals decide interactivity, and either one is enough:

   1. RENDERER hit-test (fast path): with forward:true the page receives
      mousemove even while ignoring the mouse; native.js hit-tests the DOM
      under the cursor and streams a boolean via claudeamp:set-interactive.
      This is Electron's documented technique - but the forwarding itself has
      had repeated macOS regressions, and when it silently delivers nothing
      the window would be stuck ignoring forever.

   2. MAIN cursor poll (authority): every 30ms compare
      screen.getCursorScreenPoint() against the panel rects the renderer
      already reports for window shaping. Both the cursor point and
      getContentBounds() are in DIPs on macOS and the rects are CSS px of an
      unzoomed page (also DIPs), so `cursor - contentOrigin` needs NO scale or
      workArea math - the mistake that sank the earlier poll attempt. A
      global cursor query needs no event delivery, so this works even when
      forwarding is dead.

   A pressed button (macHeld, reported by the renderer) pins the window
   interactive so a drag that slips off a panel edge isn't dropped. */
let macRendererOver = false;   // renderer hit-test: cursor over a panel
let macHeld = false;           // renderer: a mouse button is held down
let macPollOver = false;       // main poll: cursor inside a shape rect
let macArmed = false;          // first-show arming done (one-shot, see maybeShow)
let macKick = () => {};        // re-runs the cursor poll now (set by startMacHitTester)
let macKickWired = false;      // activation/focus listeners registered once
let macCursorOverride = null;  // verify proofs: a fake cursor point for the poll
let macPollOnce = () => macHittest.FAR_MS; // one poll decision (set by startMacHitTester)
function macSetIgnore(on) {
  // macOS only. On Windows/Linux setShape clips the native region and the
  // window must never ignore the mouse: through 1.7.4 the window 'blur'
  // handler reached macRecompute on every platform and, with all three mac
  // signals false, flipped Windows to ignore-mouse on the first focus loss.
  // Older builds masked that by re-running setIgnoreMouseEvents(false) on
  // every shape report; the one-shot arming exposed it.
  if (process.platform !== "darwin") return;
  if (!win || win.isDestroyed() || on === macIgnoring) return;
  macIgnoring = on;
  win.setIgnoreMouseEvents(on, { forward: true });
}
function macRecompute() {
  if (process.platform !== "darwin") return;
  macSetIgnore(!(macHeld || macRendererOver || macPollOver));
}
// Decide for a SCREEN point against the reported panel rects. Cursor point,
// getContentBounds() and the CSS rects are all DIPs on macOS, so the origin
// subtraction is the whole trick; the geometry itself lives in
// mac-hittest.cjs (pre-arm halo + poll cadence) so it stays unit-testable.
function screenShapeDecision(px, py, margin) {
  if (!win || win.isDestroyed()) return { over: false, near: false, cadence: macHittest.FAR_MS };
  const b = win.getContentBounds();
  return macHittest.decide(lastShape, px - b.x, py - b.y, margin);
}
function screenPointOverShape(px, py) {
  return screenShapeDecision(px, py).over;
}
function startMacHitTester() {
  if (process.platform !== "darwin" || macPoll) return;
  // This poll IS the app's input path on macOS. App Nap (which could stretch
  // its cadence while the app is in the background) is opted out of with
  // NSAppSleepDisabled in Info.plist; the renderer side is protected by
  // backgroundThrottling:false. Nothing else may pause or override it.
  let lastX = null, lastY = null;
  // CLAUDEAMP_HITTEST_TRACE=1 appends the poll's decisions to
  // userData/hittest.log - one failing click with this log shows whether
  // the poll saw the cursor over a rect (a timing race) or did not
  // (stale or missing shape rects). Lines are written on state changes
  // plus a heartbeat, not every tick.
  const trace = process.env.CLAUDEAMP_HITTEST_TRACE === "1";
  let lastTrace = "", lastTraceAt = 0;
  const traceLine = entry => {
    const key = `${entry.over}|${entry.near}|${entry.ignoring}|${entry.rects}`;
    const now = Date.now();
    if (key === lastTrace && now - lastTraceAt < 250) return;
    lastTrace = key; lastTraceAt = now;
    try {
      fs.appendFile(path.join(app.getPath("userData"), "hittest.log"),
        JSON.stringify(entry) + "\n", () => {});
    } catch (_) {}
  };
  // One decision, returned cadence. Split from the timer so the proofs can
  // single-step it under a controlled cursor (macCursorOverride).
  const pollOnce = () => {
    let cadence = macHittest.FAR_MS;
    // Not gated on win.isVisible(): Electron's macOS implementation compares
    // the occlusion state with == against a bit flag and only reads true
    // by accident. A false reading here would freeze the decision forever.
    if (win && !win.isDestroyed() && !win.isMinimized()) {
      try {
        const p = macCursorOverride || screen.getCursorScreenPoint();
        // The halo grows with cursor speed: a flick covers several fixed
        // halos between two polls, and clicks are never forwarded while
        // ignoring, so a fast approach must pre-arm from further out.
        const travel = lastX === null ? 0 : Math.hypot(p.x - lastX, p.y - lastY);
        lastX = p.x; lastY = p.y;
        const margin = macHittest.armMargin(travel);
        const decision = screenShapeDecision(p.x, p.y, margin);
        macPollOver = decision.near; // the halo pre-arms interactivity
        cadence = decision.cadence;
        if (trace) traceLine({ t: Date.now(), x: p.x, y: p.y, over: decision.over,
          near: decision.near, margin, cadence, rendererOver: macRendererOver,
          held: macHeld, ignoring: macIgnoring, rects: lastShape.length });
      } catch (_) { macPollOver = false; }
      macRecompute();
    }
    return cadence;
  };
  macPollOnce = pollOnce;
  const tick = () => { macPoll = setTimeout(tick, pollOnce()); };
  // Re-decide NOW instead of waiting out the cadence: on a new shape report
  // (a panel may have appeared under a resting cursor), when the app
  // becomes active, and when the window gains focus. No-op while a proof
  // has frozen the poll (macPoll === null) so deterministic checks are not
  // raced by a tick.
  const kick = () => {
    if (!macPoll) return;
    clearTimeout(macPoll);
    macPoll = setTimeout(tick, 0);
  };
  macKick = kick;
  if (!macKickWired) {
    macKickWired = true;
    app.on("did-become-active", () => macKick());
    app.on("browser-window-focus", () => macKick());
  }
  macPoll = setTimeout(tick, macHittest.FAR_MS);
}

function maybeShow() {
  if (!win || win.isDestroyed() || !readyToShow || !receivedShape) return;
  if (macArmed) {
    // Every later shape report lands here too (the update-shape handler
    // calls maybeShow so the FIRST report can show the window). Only
    // re-decide against the new rects. Never repeat the arming below:
    // through 1.7.3 it ran on every report, flipping the window to
    // click-through under a resting cursor until the next poll tick - and
    // reports arrive on every DOM mutation, so a click made after the
    // cursor came to rest was a coin flip while quick successive clicks
    // (each mouse event recomputes) always landed.
    if (process.platform === "darwin") macKick();
    return;
  }
  macArmed = true;
  if (process.platform === "darwin") {
    // macOS can't clip a window's shape, so the full-desktop window starts
    // ignoring the mouse; the renderer hit-test and the main-process cursor
    // poll (see above) then flip interactivity ON over panels and OFF over
    // the gaps, so clicks fall through the gaps to the apps behind while
    // every panel stays fully clickable.
    macSetIgnore(true);
    startMacHitTester();
  } else {
    // Windows/Linux: setShape already clips the native region to the visible
    // panels, so the window itself stays interactive and the gaps are real
    // desktop.
    win.setIgnoreMouseEvents(false);
    macIgnoring = false;
  }
  if (!win.isVisible()) win.show();
  if (smokeReport && !smokeStarted) {
    smokeStarted = true;
    setTimeout(() => runSmokeProof(win), 250);
  }
  if (verifyReport && !smokeStarted) {
    smokeStarted = true;
    setTimeout(() => runVerifyProof(win), 400);
  }
}

/* Strict cross-platform proof, run on real macOS/Windows machines in CI:
   the window exists and is visible, click-through is decided correctly for
   the platform, a synthesized click actually lands on a control, the PTY
   spawns a real shell, and the bridge serves the app. The report is written
   as JSON; scripts/verify-app.js asserts it. */
const createProofs = require("./verify-proof.cjs");
const { runVerifyProof, runSmokeProof } = createProofs({
  verifyReport, smokeReport, smokeScreenshot, smokeAbout, smokeSettings,
  smokeSettingsMusic, smokeVisualizationResults,
  macHittest, resolveLoginShell, screenPointOverShape, screenShapeDecision,
  get screen() { return screen; },
  get app() { return app; },
  get lastShape() { return lastShape; },
  get shapeApplyError() { return shapeApplyError; },
  get shapeRevision() { return shapeRevision; },
  get macIgnoring() { return macIgnoring; },
  get bridge() { return bridge; },
  freezeMacPoll() { if (macPoll) { clearTimeout(macPoll); macPoll = null; } },
  get macPollRunning() { return !!macPoll; },
  setMacCursor(point) { macCursorOverride = point || null; },
  stepMacPoll() { return macPollOnce(); },
  resumeMacPoll() { startMacHitTester(); },
  setMacState(partial) {
    if ("rendererOver" in partial) macRendererOver = partial.rendererOver;
    if ("pollOver" in partial) macPollOver = partial.pollOver;
    if ("held" in partial) macHeld = partial.held;
    macRecompute();
  },
});


function updateDesktopBounds() {
  if (!win || win.isDestroyed()) return;
  win.setBounds(desktopBounds());
  win.webContents.send("claudeamp:bounds-changed");
}



/* Native menu bar, rendered from the same spec as the in-app hamburger
   (js/menu-spec.js). Commands flow main -> renderer over
   claudeamp:menu-command into the renderer's MENU_COMMANDS map; state
   (window visibility, mode, zoom, sign-in) flows renderer -> main over
   claudeamp:menu-state and rebuilds the template so the native
   checkmarks stay honest. On Windows/Linux the same template installs
   with the menu bar hidden purely so the accelerators work. */
const menuSpec = require("../js/menu-spec.js");
let menuState = { windows: {}, mode: "chat", zoom: 1.5, termAvailable: false,
  signedIn: false, account: "" };
function sendMenuCommand(id) {
  if (win && !win.isDestroyed()) win.webContents.send("claudeamp:menu-command", id);
}
function specMenu(name) {
  return (menuSpec.find(section => section.menu === name) || { items: [] }).items;
}
function specItems(name) {
  return specMenu(name).map(item => {
    if (item.type === "separator") return { type: "separator" };
    const built = { id: item.id, label: item.label, click: () => sendMenuCommand(item.id) };
    if (item.accelerator) built.accelerator = item.accelerator;
    if (item.kind === "check" || item.kind === "radio") {
      built.type = "checkbox"; // checkbox even for radio: zoom/mode manage exclusivity
      built.checked = item.kind === "radio"
        ? (item.group === "zoom" ? "zoom-" + String(menuState.zoom) === item.id
                                 : "mode-" + menuState.mode === item.id)
        : !!menuState.windows[item.id.replace("toggle-", "")];
    }
    if (item.id === "toggle-win-term" || item.id === "mode-shell" || item.id === "show-terminal")
      built.enabled = menuState.termAvailable;
    return built;
  });
}
function nativeMenuTemplate() {
  const appItems = specItems("app");
  const template = [];
  template.push({
    label: "ClaudeAmp",
    submenu: process.platform === "darwin" ? [
      ...appItems,
      { type: "separator" },
      // Hand-built instead of the stock application-menu role ON PURPOSE:
      // that role inserts the macOS Services menu, which this app has no
      // services for ("No Services Apply").
      { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
      { type: "separator" },
      { label: "Quit ClaudeAmp", accelerator: "CmdOrCtrl+Q", click: () => sendMenuCommand("quit") },
    ] : [
      ...appItems,
      { type: "separator" },
      { label: "Quit ClaudeAmp", accelerator: "CmdOrCtrl+Q", click: () => sendMenuCommand("quit") },
    ],
  });
  template.push({ label: "File", submenu: specItems("File") });
  template.push({ role: "editMenu" });
  template.push({ label: "View", submenu: specItems("View") });
  if (menuState.signedIn) template.push({
    label: "Account",
    submenu: [{ label: menuState.account || "Signed in", enabled: false }, ...specItems("Account")],
  });
  template.push({ role: "windowMenu" });
  template.push({ label: "Help", submenu: specItems("Help") });
  return template;
}
function applyNativeMenu() {
  try { Menu.setApplicationMenu(Menu.buildFromTemplate(nativeMenuTemplate())); } catch (_) {}
}
ipcMain.on("claudeamp:menu-state", (event, state) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  if (!state || typeof state !== "object") return;
  menuState = {
    windows: state.windows && typeof state.windows === "object" ? state.windows : {},
    mode: state.mode === "shell" ? "shell" : "chat",
    zoom: Number(state.zoom) || 1.5,
    termAvailable: !!state.termAvailable,
    signedIn: !!state.signedIn,
    account: typeof state.account === "string" ? state.account.slice(0, 120) : "",
  };
  applyNativeMenu();
});

function createWindow(port) {
  const area = desktopBounds();
  readyToShow = false;
  receivedShape = false;
  macArmed = false;
  lastShape = [];
  shapeRevision = 0;
  shapeApplyError = "";
  win = new BrowserWindow({
    x: area.x, y: area.y, width: area.width, height: area.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    fullscreenable: false,
    roundedCorners: false,
    autoHideMenuBar: true,
    // Register the very first mouse-down even when the window isn't key, so a
    // click on a panel doesn't get eaten just to activate the window (matters
    // for the transparent click-through desktop shell on macOS).
    acceptFirstMouse: true,
    title: "ClaudeAmp",
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Tell the renderer when the self-verification harness is driving, so
      // the terminal opens a bare shell (deterministic on machines where the
      // provider CLI happens to be installed). Sandboxed preloads read these
      // from process.argv - the documented channel for exactly this.
      additionalArguments: verifyReport ? ["--claudeamp-verify"] : [],
      // Electron otherwise defaults to allowing media to autoplay without a
      // user gesture, so the YouTube embed would start on launch. Match
      // browser behaviour: nothing plays until the user presses Play.
      autoplayPolicy: "document-user-activation-required",
      // The transparent overlay reads as occluded to Chromium, which would
      // throttle the renderer's shape re-report and forwarded-mousemove
      // hit-test after idle - on macOS that turned into clicks falling
      // through to the app behind once the user paused for a while.
      backgroundThrottling: false,
    },
  });
  applyNativeMenu();
  win.setMenuBarVisibility(false); // hamburger stays the visible UI off-mac; accelerators still fire
  if (process.platform === "darwin") {
    app.setAboutPanelOptions({ applicationName: "ClaudeAmp", applicationVersion: app.getVersion() });
    app.dock?.setMenu(Menu.buildFromTemplate(
      (menuSpec.find(section => section.menu === "dock") || { items: [] }).items.map(item =>
        item.type === "separator" ? { type: "separator" }
          : { label: item.label, click: () => sendMenuCommand(item.id) })));
    // The desktop overlay follows the user across Spaces instead of living
    // only on the Space it launched in; never over full-screen apps.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  }
  win.setIgnoreMouseEvents(true);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  win.once("ready-to-show", () => { readyToShow = true; maybeShow(); });
  // Losing focus mid-drag would otherwise leave macHeld pinned true forever
  // (macRecompute is a no-op off macOS; see macSetIgnore).
  win.on("blur", () => { macHeld = false; macRecompute(); });
  win.on("closed", () => { win = null; });
  win.loadURL("http://127.0.0.1:" + port + "/");
}

/* Wrapped terminal: a real PTY, streamed to the xterm.js panel over IPC.
   Every platform tries an isolated utilityProcess first. Besides protecting
   Windows from a wedged ConPTY spawn, this keeps macOS's native PTY lifecycle
   outside the Electron main loop and lets us require a real input/output
   readiness round trip before exposing the terminal. Unix retains one direct
   node-pty fallback. One session at a time; reopening after exit spawns a fresh
   login shell in the CLI workspace. */
let ptyHost = null;   // the utilityProcess backing the LIVE terminal session
let inprocPty = null; // an in-process node-pty (real PTY, main-process conout)
function killPtyHost() {
  if (ptyHost) { try { ptyHost.kill(); } catch (_) {} ptyHost = null; }
  if (inprocPty) { try { inprocPty.kill(); } catch (_) {} inprocPty = null; }
}
// The host script must live on the real filesystem (a worker/native module
// path inside app.asar is exactly the class of bug we are escaping), so when
// packaged, load it from app.asar.unpacked (electron/pty-host.cjs is unpacked
// via the build config).
function ptyHostScriptPath() {
  let p = path.join(__dirname, "pty-host.cjs");
  if (p.indexOf("app.asar") !== -1 && p.indexOf("app.asar.unpacked") === -1)
    p = p.replace("app.asar", "app.asar.unpacked");
  return p;
}
/* Terminal diagnostics: every open attempt is narrated to the renderer (the
   panel paints the trace until real shell output arrives - a black panel
   with no explanation must be impossible) and appended to a log file the
   user can share. */
const termLogPath = () => path.join(app.getPath("userData"), "terminal.log");
// node-pty's conout worker (patched in scripts/patch-node-pty.cjs) writes its
// own lifecycle here; we fold it into the trace so a silent shell explains why.
const conoutLogPath = () => path.join(os.tmpdir(), "claudeamp-conout.log");
function termTrace(line) {
  try { fs.appendFileSync(termLogPath(), new Date().toISOString() + " " + line + "\n"); } catch (_) {}
  if (win && !win.isDestroyed()) win.webContents.send("claudeamp:term-debug", line);
}
// Surface whatever node-pty's conout worker logged for this attempt.
function traceConoutDiag() {
  let text = "";
  try { text = fs.readFileSync(conoutLogPath(), "utf8"); } catch (_) {}
  const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
  if (!lines.length) { termTrace("  conout worker: (no diagnostics logged)"); return; }
  for (const l of lines.slice(-6)) termTrace("  " + l);
}
// A crashing conout worker (or any stray async error) must never take the whole
// app down mid-terminal-spawn: log it into the trace and keep running so the
// fallback chain can proceed.
process.on("uncaughtException", error => {
  try { termTrace("uncaught: " + (error && error.stack || error)); } catch (_) {}
});
process.on("unhandledRejection", reason => {
  try { termTrace("unhandled rejection: " + (reason && reason.stack || reason)); } catch (_) {}
});

/* Spawn one (backend, shell) attempt in a fresh isolated host. Resolves
   { ok:true, initialData } once the shell echoes a unique readiness probe (the host is then
   adopted as the live `ptyHost`), or { ok:false, error } on any failure
   mode: the spawn call hanging, throwing, the shell exiting instantly, or
   failing the input/output round trip. A hung spawn can only be detected out-of-process,
   which is the whole point of the host. */
function spawnAttempt(backend, shell, args, spawnOptions) {
  return new Promise(resolve => {
    let host = null;
    termTrace("  forking isolated pty host...");
    try {
      host = utilityProcess.fork(ptyHostScriptPath(), [], {
        serviceName: "claudeamp-pty",
        stdio: "ignore",
        env: Object.assign({}, process.env, { CLAUDEAMP_PTY_HOST: "1" }),
      });
    } catch (error) {
      termTrace("  fork threw: " + (error.message || error));
      resolve({ ok: false, error: "pty host failed to start: " + (error.message || error) });
      return;
    }
    let settled = false;   // the probe promise has resolved
    let live = false;      // this host became the live terminal
    let ready = false;     // pty.spawn() returned inside the host
    let initialData = "";  // held until invoke() can return it deterministically
    let markerSeen = false;
    let resetSent = false;
    let settleTimer = null;
    let dataTimer = null;
    const marker = readyMarker();
    const options = Object.assign({}, spawnOptions,
      process.platform === "win32" ? { useConpty: backend === "conpty" } : {});

    // pty.spawn() must RETURN within this window; if it doesn't, it is the
    // synchronous ConPTY/PowerShell hang and the host is wedged - kill it. The
    // host is isolated, so this can never freeze the main app - the timeout
    // fires and we can try the next real PTY backend.
    const readyTimer = setTimeout(() => {
      if (!ready) fail(backend + "+" + shell + " spawn hung (no response in 6s)");
    }, 6000);

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(readyTimer); clearTimeout(dataTimer); clearTimeout(settleTimer);
      // Dump node-pty's conout worker lifecycle (it ran inside the host, but
      // logs to the shared temp file) so we see WHY it stayed silent.
      traceConoutDiag();
      try { host.kill(); } catch (_) {}
      resolve({ ok: false, error });
    }

    function succeed() {
      if (settled || !markerSeen) return;
      live = true;
      settled = true;
      clearTimeout(readyTimer); clearTimeout(dataTimer); clearTimeout(settleTimer);
      adoptHost(host);
      // Preserve the real clear-screen/home sequences emitted by the
      // second-stage reset; they put xterm's visible cursor on the true prompt.
      const clean = stripReadyProbe(initialData, marker);
      termTrace("  readiness round trip complete (" + initialData.length + " bytes)");
      resolve({ ok: true, initialData: clean });
    }

    host.on("message", msg => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "trace") { termTrace("  " + msg.line); return; }
      if (msg.type === "ptyReady") {
        ready = true;
        clearTimeout(readyTimer);
        termTrace("  shell spawned; sending readiness probe");
        try { host.postMessage({ type: "input", data: readyProbe(marker) }); }
        catch (error) { fail("could not write terminal readiness probe: " + (error.message || error)); }
        dataTimer = setTimeout(() => {
          fail(backend + "+" + shell + " failed its readiness round trip in 12s");
        }, 12000);
        return;
      }
      if (msg.type === "spawn-error") {
        fail(backend + "+" + shell + " spawn failed: " + msg.error);
        return;
      }
      if (msg.type === "data") {
        if (!live) {
          initialData += String(msg.data || "");
          if (initialData.length > 65536) {
            fail(backend + "+" + shell + " exceeded readiness buffer without answering");
            return;
          }
          if (hasReadyMarker(initialData, marker)) markerSeen = true;
          if (!markerSeen) return;
          // Clear only after the marker has crossed the PTY. The old single
          // command (\`echo marker & cls\`) let ConPTY erase the marker before
          // node-pty observed it, so every launch fell into a non-TUI pipe.
          if (process.platform === "win32" && !resetSent) {
            resetSent = true;
            try { host.postMessage({ type: "input", data: readyScreenReset() }); }
            catch (error) {
              fail("could not reset terminal after readiness: " + (error.message || error));
              return;
            }
          }
          // ConPTY can emit one last screen repaint immediately after the
          // marker. Briefly coalesce that tail so probe artifacts cannot leak
          // through a later IPC event after the sanitized initial buffer.
          clearTimeout(settleTimer);
          settleTimer = setTimeout(succeed, 180);
          return;
        }
        // Some ConPTY builds repaint the startup screen again after readiness.
        // Sanitize late copies too so the private probe never appears in UI.
        const clean = stripReadyProbe(msg.data, marker);
        if (clean && win && !win.isDestroyed()) win.webContents.send("claudeamp:term-data", clean);
        return;
      }
      if (msg.type === "exit") {
        if (!live) {
          fail(backend + "+" + shell + " exited immediately (code " + msg.code + ")");
        } else {
          if (ptyHost === host) ptyHost = null;
          if (win && !win.isDestroyed()) win.webContents.send("claudeamp:term-exit", { code: msg.code });
          try { host.kill(); } catch (_) {}
        }
      }
    });
    host.on("exit", code => {
      clearTimeout(readyTimer); clearTimeout(dataTimer);
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: backend + "+" + shell + " host exited before output (" + code + ")" });
      } else if (live && ptyHost === host) {
        // The live host died unexpectedly - tell the renderer the shell ended.
        ptyHost = null;
        if (win && !win.isDestroyed()) win.webContents.send("claudeamp:term-exit", { code });
      }
    });
    // utilityProcess is ready to receive once it has spawned.
    host.once("spawn", () => {
      termTrace("  host process up; requesting " + shell);
      try { host.postMessage({ type: "spawn", backend, shell, args, options }); }
      catch (error) { fail("could not reach pty host: " + (error.message || error)); }
    });
  });
}

// Promote a probing host to the live terminal, retiring any previous one.
function adoptHost(host) {
  if (ptyHost && ptyHost !== host) { try { ptyHost.kill(); } catch (_) {} }
  ptyHost = host;
}

ipcMain.handle("claudeamp:term-open", async (event, size) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents)
    return { ok: false, error: "no window" };
  try { fs.writeFileSync(termLogPath(), ""); } catch (_) {}
  try { fs.writeFileSync(conoutLogPath(), ""); } catch (_) {}
  killPtyHost();
  // Optional env overlay from the renderer (e.g. an API key for the CLI the
  // shell auto-runs). Uppercase env-style names only, string values, few.
  const extraEnv = {};
  if (size && size.env && typeof size.env === "object") {
    for (const [key, value] of Object.entries(size.env)) {
      if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(key)) continue;
      if (Object.keys(extraEnv).length >= 8) break;
      extraEnv[key] = value;
    }
  }
  const ptyEnv = Object.assign({}, process.env, extraEnv);
  // Finder/Dock launches inherit no locale, so the shell would run in the C
  // locale: multibyte input and TUI box-drawing degrade. Terminal.app and
  // VS Code both inject a UTF-8 locale on macOS; do the same.
  if (process.platform === "darwin" && !ptyEnv.LANG) {
    const locale = String(app.getLocale() || "").replace(/-/g, "_");
    ptyEnv.LANG = (/^[a-z]{2,3}_[A-Z]{2}$/.test(locale) ? locale : "en_US") + ".UTF-8";
  }
  // Without COLORTERM, truecolor TUIs (Claude Code's orange included)
  // quantize to the 256-color palette. xterm.js renders 24-bit color fine.
  if (!ptyEnv.COLORTERM) ptyEnv.COLORTERM = "truecolor";
  const spawnOptions = {
    name: "xterm-256color",
    cols: Math.max(20, Math.min(500, Number(size?.cols) || 80)),
    rows: Math.max(5, Math.min(200, Number(size?.rows) || 24)),
    cwd: process.env.CLAUDEAMP_WORKSPACE || os.homedir(),
    env: ptyEnv,
  };
  // Spawn order on Windows: a real ConPTY cmd.exe in the ISOLATED HOST first.
  // node-pty must NOT run in the main process - on some machines its post-spawn
  // work wedges the event loop (the trace freezes right after pty.spawn with no
  // output and no fallback). Isolated in a utilityProcess, a wedge just gets the
  // host killed on timeout and we move on. WinPTY is a second real-terminal
  // attempt; a plain stdio pipe is deliberately not accepted because it cannot
  // run interactive TUI programs. PowerShell is never auto-spawned
  // (its launch can block behind security software); cmd is enough for the CLIs.
  // On macOS/Linux, resolve the account's real login shell (Directory Services
  // beats a stale Finder/Dock $SHELL on macOS), isolate it first, and retain a
  // direct node-pty fallback. This follows the lifecycle lesson from native
  // terminals such as Macterm without importing its Ghostty-specific UI stack.
  const winShell = "cmd.exe";
  const unixShell = process.platform === "win32" ? "" : resolveLoginShell();
  const args = loginShellArgs();
  const attempts = process.platform === "win32"
    ? [["host", "conpty", winShell], ["host", "winpty", winShell]]
    : [["host", "pty", unixShell], ["inproc", "pty", unixShell]];
  let lastError = "";
  for (const [method, backend, shell] of attempts) {
    termTrace((method === "host" ? "isolated " : "") + "spawning " + shell + " via " + backend + "...");
    const outcome = method === "host"
      ? await spawnAttempt(backend, shell, args, spawnOptions)
      : await spawnInProcess(backend, shell, args, spawnOptions);
    if (outcome.ok) {
      termTrace("  shell is talking (" + backend + " + " + shell + ")");
      return { ok: true, shell, backend: backend + (method === "host" ? "-host" : ""),
        initialData: outcome.initialData || "" };
    }
    lastError = outcome.error;
    termTrace("  " + lastError);
  }
  termTrace("every backend failed; log: " + termLogPath());
  return { ok: false, error: lastError || "no real PTY backend worked", log: termLogPath() };
});

/* In-process Unix PTY fallback. The isolated host is authoritative; this path
   exists for unusual utilityProcess/native-module packaging failures. A
   synchronous native spawn cannot be timed out, so Windows never enters it. */
function spawnInProcess(backend, shell, args, spawnOptions) {
  return new Promise(resolve => {
    let pty;
    try { pty = require("node-pty"); }
    catch (error) { resolve({ ok: false, error: "node-pty load failed: " + (error.message || error) }); return; }
    termTrace("  loading in-process node-pty ok; calling spawn...");
    let proc = null;
    try {
      proc = pty.spawn(shell, args, Object.assign({}, spawnOptions, { useConpty: backend === "conpty" }));
    } catch (error) {
      resolve({ ok: false, error: backend + "+" + shell + " threw: " + (error.message || error) });
      return;
    }
    termTrace("  in-process pty.spawn returned (pid " + proc.pid + ")");
    // Read the conout worker's constructor-time log RIGHT NOW (synchronously),
    // so even if something wedges the loop after this point the trace still
    // shows the worker path + whether the worker file exists.
    traceConoutDiag();
    inprocPty = proc;
    let settled = false;
    const done = value => { if (!settled) { settled = true; resolve(value); } };
    proc.onData(data => {
      if (!settled) { done({ ok: true, initialData: String(data || "") }); return; }
      if (win && !win.isDestroyed()) win.webContents.send("claudeamp:term-data", data);
    });
    proc.onExit(({ exitCode }) => {
      if (!settled) done({ ok: false, error: backend + "+" + shell + " exited (" + exitCode + ")" });
      if (inprocPty === proc) inprocPty = null;
      if (win && !win.isDestroyed()) win.webContents.send("claudeamp:term-exit", { code: exitCode });
    });
    setTimeout(() => { if (!settled) { try { proc.write("\r"); } catch (_) {} } }, 1500);
    setTimeout(() => {
      if (!settled) {
        // Still nothing - dump the worker's async lifecycle (error / ready /
        // socket connect / first data) so the trace shows WHERE it broke.
        traceConoutDiag();
        try { proc.kill(); } catch (_) {} if (inprocPty === proc) inprocPty = null;
        done({ ok: false, error: backend + "+" + shell + " produced no output in 4s" });
      }
    }, 4000);
  });
}

ipcMain.on("claudeamp:term-input", (event, data) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  if (ptyHost) { try { ptyHost.postMessage({ type: "input", data: String(data) }); } catch (_) {} }
  else if (inprocPty) { try { inprocPty.write(String(data)); } catch (_) {} }
});
ipcMain.on("claudeamp:term-resize", (event, size) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  const cols = Math.max(20, Math.min(500, Number(size?.cols) || 0));
  const rows = Math.max(5, Math.min(200, Number(size?.rows) || 0));
  if (!cols || !rows) return;
  if (ptyHost) { try { ptyHost.postMessage({ type: "resize", cols, rows }); } catch (_) {} }
  else if (inprocPty) { try { inprocPty.resize(cols, rows); } catch (_) {} }
});
ipcMain.on("claudeamp:term-close", event => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  killPtyHost();
});

ipcMain.on("claudeamp:set-interactive", (event, on) => {
  // Only macOS drives interactivity from the renderer; elsewhere the native
  // window shape already handles click-through.
  if (process.platform !== "darwin") return;
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  macRendererOver = !!on;   // true = cursor is over a panel
  macRecompute();
});
ipcMain.on("claudeamp:set-held", (event, on) => {
  if (process.platform !== "darwin") return;
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  macHeld = !!on;           // a button is down: pin interactive during drags
  macRecompute();
});
ipcMain.on("claudeamp:quit", () => app.quit());
ipcMain.on("claudeamp:minimize", () => { if (win) win.minimize(); });
ipcMain.on("claudeamp:close", () => { if (win) win.close(); });
ipcMain.on("claudeamp:update-shape", (event, rects) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  const shape = safeShape(rects);
  if (!shape.length) return;
  if (process.platform === "win32" || process.platform === "linux") {
    try { win.setShape(shape); shapeApplyError = ""; }
    catch (error) { shapeApplyError = error.message || String(error); }
  }
  lastShape = shape;
  shapeRevision++;
  receivedShape = true;
  maybeShow();
});
ipcMain.handle("claudeamp:bridge-token", event => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return "";
  return bridge ? bridge.getToken() : "";
});

ipcMain.handle("claudeamp:set-access", (event, value) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return false;
  const access = value?.access === "workspace" ? "workspace" : "read-only";
  const shell = value?.shell === true;
  writeDesktopSettings({ ...readDesktopSettings(), access, shell });
  if (bridge) bridge.setAccessCeiling({ access, shell });
  return true;
});

/* API keys, encrypted at rest through the OS keychain (safeStorage). The
   renderer migrates its legacy localStorage copies in and clears them;
   when encryption is unavailable it falls back to localStorage as before. */
const SECRET_PROVIDERS = new Set(["claude", "openai", "gemini"]);
const secretsPath = () => path.join(app.getPath("userData"), "secure-keys.json");
function readSecretsFile() {
  try { return JSON.parse(fs.readFileSync(secretsPath(), "utf8")) || {}; } catch (_) { return {}; }
}
ipcMain.handle("claudeamp:get-keys", event => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return null;
  const stored = readSecretsFile();
  // Nothing stored: answer without touching the OS keychain at all. On
  // macOS even isEncryptionAvailable() unlocks the app's keychain entry,
  // which shows a scary access prompt at every launch - pointless when
  // there is nothing to decrypt. The keychain is first touched when a key
  // is actually saved (set-key) or actually stored here.
  if (![...SECRET_PROVIDERS].some(provider => stored[provider])) return {};
  if (!safeStorage.isEncryptionAvailable()) return null;
  const keys = {};
  for (const provider of SECRET_PROVIDERS) {
    try {
      keys[provider] = stored[provider]
        ? safeStorage.decryptString(Buffer.from(stored[provider], "base64")) : "";
    } catch (_) { keys[provider] = ""; }
  }
  return keys;
});
ipcMain.handle("claudeamp:set-key", (event, payload) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return false;
  if (!safeStorage.isEncryptionAvailable()) return false;
  const provider = String(payload?.provider || "");
  if (!SECRET_PROVIDERS.has(provider)) return false;
  const value = typeof payload?.value === "string" ? payload.value : "";
  const stored = readSecretsFile();
  if (value) stored[provider] = safeStorage.encryptString(value).toString("base64");
  else delete stored[provider];
  try {
    fs.writeFileSync(secretsPath(), JSON.stringify(stored), { mode: 0o600 });
    return true;
  } catch (_) { return false; }
});

ipcMain.handle("claudeamp:choose-workspace", async () => {
  if (!win || !bridge) return "";
  const selected = await dialog.showOpenDialog(win, {
    title: "Choose ClaudeAmp CLI workspace",
    properties: ["openDirectory", "createDirectory"],
  });
  if (selected.canceled || !selected.filePaths[0]) return "";
  const workspace = bridge.setWorkspaceRoot(selected.filePaths[0]);
  // term-open reads this env var for the shell's cwd; without updating it,
  // new terminals keep opening in the old workspace until the app restarts.
  process.env.CLAUDEAMP_WORKSPACE = workspace;
  writeDesktopSettings({ ...readDesktopSettings(), workspace });
  return workspace;
});
function launchMacLoginTerminal({ heading, command }, report) {
  const stamp = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  const dir = path.join(os.tmpdir(), "claudeamp-login");
  fs.mkdirSync(dir, { recursive: true });
  const exitFile = path.join(dir, stamp + ".exit");
  const scriptFile = path.join(dir, stamp + ".command");
  const script = [
    "#!/bin/bash",
    // Terminal.app is a separate process tree: it never sees the PATH this
    // app rebuilt (widenPath/augmentPath), so nvm/Homebrew-installed CLIs
    // would be "command not found" there. Hand our resolved PATH down.
    "export PATH='" + String(process.env.PATH || "").replace(/'/g, "'\\''") + "'",
    "clear",
    "echo 'CLAUDEAMP - " + heading + "'",
    "echo 'Complete the browser/device prompts, then this window can be closed.'",
    "echo ''",
    command,
    "status=$?",
    "echo $status > " + JSON.stringify(exitFile),
    "if [ $status -eq 0 ]; then echo; echo 'LOGIN COMPLETE - RETURN TO CLAUDEAMP'; else echo; echo 'LOGIN DID NOT COMPLETE'; fi",
    "exit $status",
  ].join("\n") + "\n";
  fs.writeFileSync(scriptFile, script, { mode: 0o755 });
  const opener = spawn("open", ["-a", "Terminal", scriptFile], { stdio: "ignore" });
  opener.once("error", error => report({ ok: false, error: error.message || String(error) }));
  opener.unref();
  const startedAt = Date.now();
  const poll = setInterval(() => {
    let code = null;
    try { code = parseInt(fs.readFileSync(exitFile, "utf8").trim(), 10); } catch (_) {}
    if (code !== null && !Number.isNaN(code)) {
      clearInterval(poll);
      try { fs.unlinkSync(exitFile); } catch (_) {}
      try { fs.unlinkSync(scriptFile); } catch (_) {}
      report({ ok: code === 0, code });
    } else if (Date.now() - startedAt > 15 * 60 * 1000) {
      clearInterval(poll);
      report({ ok: false, error: "Login timed out" });
    }
  }, 2000);
}

function registerCliLogin({ ipcName, eventName, heading, command, promptName }) {
  ipcMain.handle(ipcName, () => {
    try {
      if (process.platform !== "win32" && process.platform !== "darwin")
        return { ok: false, error: "This login launcher requires Windows or macOS" };
      if (process.platform === "darwin") {
        let reported = false;
        launchMacLoginTerminal({ heading, command }, result => {
          if (reported) return;
          reported = true;
          if (win && !win.isDestroyed()) win.webContents.send(eventName, result);
        });
        return { ok: true };
      }
      const loginScript = [
        "$Host.UI.RawUI.WindowTitle = 'ClaudeAmp - " + promptName + " Login'",
        "Write-Host 'CLAUDEAMP - " + heading + "' -ForegroundColor Cyan",
        "Write-Host 'Complete the browser/device prompts. This window accepts any requested code.'",
        "Write-Host ''",
        "& " + command,
        "$loginExit = $LASTEXITCODE",
        "if ($loginExit -eq 0) { Write-Host ''; Write-Host 'LOGIN COMPLETE - RETURNING TO CLAUDEAMP' -ForegroundColor Green; Start-Sleep -Seconds 2 } else { Write-Host ''; Write-Host 'LOGIN DID NOT COMPLETE' -ForegroundColor Red; Read-Host 'Press Enter to close' }",
        "exit $loginExit",
      ].join("; ");
      const encodedLogin = Buffer.from(loginScript, "utf16le").toString("base64");
      const launcher = [
        "$login = Start-Process -FilePath 'powershell.exe'",
        "-ArgumentList @('-NoLogo','-NoProfile','-EncodedCommand','" + encodedLogin + "')",
        "-WindowStyle Normal -PassThru -Wait",
      ].join(" ") + "; exit $login.ExitCode";
      const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive",
        "-WindowStyle", "Hidden", "-Command", launcher], {
        stdio: "ignore",
        windowsHide: true,
        env: process.env,
      });
      let reported = false;
      const report = result => {
        if (reported) return;
        reported = true;
        if (win && !win.isDestroyed()) win.webContents.send(eventName, result);
      };
      child.once("error", error => report({ ok: false, error: error.message || String(error) }));
      child.once("exit", code => report({ ok: code === 0, code }));
      child.unref();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });
}
registerCliLogin({
  ipcName: "claudeamp:open-claude-login",
  eventName: "claudeamp:claude-login-complete",
  heading: "CLAUDE LOGIN",
  promptName: "Claude",
  // No logout first: it would sign the user's claude CLI out machine-wide
  // even when this login attempt is aborted or fails. An already-signed-in
  // CLI just reports success, which is the right outcome.
  command: "claude auth login",
});
registerCliLogin({
  ipcName: "claudeamp:open-codex-login",
  eventName: "claudeamp:codex-login-complete",
  heading: "CODEX LOGIN",
  promptName: "Codex",
  command: "codex login",
});

/* Passive update check: ask GitHub for the latest release once at startup
   and daily after, and let the renderer weave "vX.Y.Z available" into the
   ticker. No downloading, no prompting - autoUpdater proper waits on
   notarization. */
function checkForUpdates() {
  const request = https.get({
    hostname: "api.github.com",
    path: "/repos/petehottelet/ClaudeAMP/releases/latest",
    headers: { "user-agent": "ClaudeAmp/" + app.getVersion(), accept: "application/vnd.github+json" },
    timeout: 10000,
  }, response => {
    let body = "";
    response.on("data", chunk => { if (body.length < 65536) body += chunk; });
    response.on("end", () => {
      try {
        const release = JSON.parse(body);
        const latest = String(release.tag_name || "").replace(/^v/, "");
        if (isNewerVersion(latest, app.getVersion()) && win && !win.isDestroyed()) {
          win.webContents.send("claudeamp:update-available",
            { version: latest, url: release.html_url || "https://www.claudeamp.com" });
        }
      } catch (_) { /* offline or rate-limited - try again tomorrow */ }
    });
  });
  request.on("error", () => {});
  request.on("timeout", () => request.destroy());
}

function startLocalBridge(preferredPort) {
  const listen = port => {
    bridge.startBridge(port, actualPort => {
      writeDesktopSettings({ ...readDesktopSettings(), port: actualPort });
      createWindow(actualPort);
      setTimeout(checkForUpdates, 15000);
      setInterval(checkForUpdates, 24 * 60 * 60 * 1000).unref();
    }, error => {
      if (error?.code === "EADDRINUSE" && port !== 0) {
        setImmediate(() => listen(0));
        return;
      }
      dialog.showErrorBox("ClaudeAmp could not start", error?.message || String(error));
      app.quit();
    });
  };
  listen(preferredPort);
}

if (hasInstanceLock) app.whenReady().then(() => {
  widenPath();
  const saved = readDesktopSettings();
  const fallback = app.getPath("documents");
  const workspace = saved.workspace && fs.existsSync(saved.workspace) ? saved.workspace : fallback;
  process.env.CLAUDEAMP_WORKSPACE = workspace;
  bridge = require("../bridge");
  // The renderer gets the bearer token over IPC, never from /bridge/status,
  // and the CLI access ceiling the user chose is enforced bridge-side.
  bridge.setEmbedded(true);
  bridge.setAccessCeiling({ access: saved.access, shell: saved.shell });
  try { bridge.setWorkspaceRoot(workspace); } catch (_) {}
  screen.on("display-added", updateDesktopBounds);
  screen.on("display-removed", updateDesktopBounds);
  screen.on("display-metrics-changed", updateDesktopBounds);
  startLocalBridge(Number.isInteger(saved.port) ? saved.port : 8014);
});

app.on("second-instance", () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.on("activate", () => {
  // A minimized window counts as "all windows", so a Dock click would
  // otherwise do nothing on macOS — restore it like second-instance does.
  if (win && !win.isDestroyed() && win.isMinimized()) { win.restore(); win.focus(); return; }
  if (BrowserWindow.getAllWindows().length === 0 && bridge?.server?.listening)
    createWindow(bridge.server.address().port);
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  if (macPoll) { clearTimeout(macPoll); macPoll = null; }
  killPtyHost();
  if (bridge) bridge.stopBridge();
});
