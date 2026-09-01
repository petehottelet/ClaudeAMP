"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

if (process.platform !== "win32") {
  console.log("Packaged smoke test skipped: Windows is required");
  process.exit(0);
}

const root = path.resolve(__dirname, "..");
const executable = path.join(root, "dist", "win-unpacked", "ClaudeAmp.exe");
const sourceIcon = path.join(root, "assets", "claw-icon.ico");
const installedIcon = path.join(root, "dist", "win-unpacked", "resources", "claw-icon.ico");
const reportPath = path.join(os.tmpdir(), "claudeamp-packaged-verify-" + process.pid + ".json");

if (!fs.existsSync(executable)) {
  console.error("Packaged executable not found: " + executable);
  process.exit(1);
}
if (!fs.existsSync(installedIcon) ||
    !fs.readFileSync(installedIcon).equals(fs.readFileSync(sourceIcon))) {
  console.error("Packaged taskbar icon is missing or differs from the source ICO: " + installedIcon);
  process.exit(1);
}

try { fs.rmSync(reportPath, { force: true }); } catch (_) {}

const run = spawnSync(executable, ["--verify-report=" + reportPath], {
  cwd: root,
  stdio: "inherit",
  timeout: 240000,
  env: Object.assign({}, process.env, { ELECTRON_ENABLE_LOGGING: "1" }),
});

let report = null;
try { report = JSON.parse(fs.readFileSync(reportPath, "utf8")); }
catch (_) {}
try { fs.rmSync(reportPath, { force: true }); } catch (_) {}

if (run.error) {
  console.error("Packaged verification failed to launch: " + (run.error.message || run.error));
  process.exit(1);
}
if (run.status !== 0) {
  console.error("Packaged verification exited with status " + run.status);
  process.exit(1);
}
if (!report) {
  console.error("Packaged app did not write a verification report");
  process.exit(1);
}
if (!report.ok || (report.failures && report.failures.length)) {
  console.error("Packaged verification failed: " + (report.failures || ["unknown"]).join(", "));
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}
for (const proof of [
  "onboardingArrowCompact", "onboardingArrowPointsAtMenu", "onboardingArrowInNativeShape",
  "sourceAwareMusicSearch", "visualizationDefaultsToRain", "itunesPreviewPlaylistDefault",
  "itunesDefaultMusicChoice", "itunesDefaultPlaylistHydrates",
  "visualizationUsesPlaylistScrollbar", "addedButtonTextFits", "providerIconsPackaged",
  "itunesPreviewHydrates", "itunesPreviewPlays",
  "terminalRendersOutput", "terminalUsesRealPty", "terminalHasConsoleDevice",
  "terminalOverlayHidden", "terminalAcceptsInput",
  "terminalMenuShowsRealMode", "terminalUsesPlaylistScrollbar",
  "restoredTerminalStarts", "terminalSnapsToMainTop", "terminalHidesDiagnostics", "terminalUsesBlockFont",
  "restoredTerminalUsesRealPty", "terminalCursorOnPrompt", "restoredTerminalAcceptsInput",
]) {
  if (report[proof] !== true) {
    console.error("Packaged verification is missing required proof: " + proof);
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }
}

console.log("Packaged verification passed: visible interactive terminal, bridge, window input, and desktop shape");
