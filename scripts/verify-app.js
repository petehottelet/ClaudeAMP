#!/usr/bin/env node
/* Launches the real ClaudeAmp Electron app with --verify-report and asserts
   the report: window shown, click-through decided correctly per platform,
   synthesized clicks captured, PTY working, bridge serving. Exits non-zero
   on any failure so CI blocks the release. */
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const reportPath = path.join(os.tmpdir(), "claudeamp-verify-" + process.pid + ".json");
const electron = require("electron"); // path to the electron binary

console.log("[verify] launching ClaudeAmp on " + process.platform + " ...");
const run = spawnSync(electron, [".", "--verify-report=" + reportPath], {
  cwd: path.join(__dirname, ".."),
  stdio: "inherit",
  timeout: 200000,
  env: Object.assign({}, process.env, { ELECTRON_ENABLE_LOGGING: "1" }),
});

let report = null;
try { report = JSON.parse(fs.readFileSync(reportPath, "utf8")); }
catch (_) {}

console.log("[verify] exit status:", run.status, run.signal || "");
if (run.error) console.error("[verify] spawn error:", run.error.message || run.error);
console.log("[verify] report:\n" + JSON.stringify(report, null, 2));

if (!report) {
  console.error("[verify] FAIL: the app never wrote a verify report (crashed or hung).");
  process.exit(1);
}
if (run.status !== 0) {
  console.error("[verify] FAIL: the app exited with status " + run.status +
    (run.signal ? " (signal " + run.signal + ")" : ""));
  process.exit(1);
}
if (!report.ok || (report.failures && report.failures.length)) {
  console.error("[verify] FAIL: " + (report.failures || ["unknown"]).join(", "));
  process.exit(1);
}
console.log("[verify] PASS: the app works normally on " + process.platform +
  " (window, click capture, click-through decisions, PTY, bridge).");
