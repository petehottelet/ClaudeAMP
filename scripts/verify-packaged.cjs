#!/usr/bin/env node
/* Launches a PACKAGED ClaudeAmp binary (unpacked dir build, .app binary, or
   AppImage) with --verify-report and asserts the report the same way
   verify-app.js does for the dev build. Used by release CI so installers
   never publish without the packaged app - asar, unpacked node-pty,
   terminal and bridge included - having proven itself on that platform.

     node scripts/verify-packaged.cjs <binary> [extra electron args...]     */
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const [, , binary, ...extraArgs] = process.argv;
if (!binary || !fs.existsSync(binary)) {
  console.error("usage: verify-packaged.cjs <path-to-packaged-binary> [args]");
  process.exit(2);
}

const reportPath = path.join(os.tmpdir(), "claudeamp-packaged-verify-" + process.pid + ".json");
console.log("[verify-packaged] launching " + binary + " on " + process.platform + " ...");
const run = spawnSync(binary, [...extraArgs, "--verify-report=" + reportPath], {
  stdio: "inherit",
  timeout: 240000,
  env: Object.assign({}, process.env, { ELECTRON_ENABLE_LOGGING: "1" }),
});

let report = null;
try { report = JSON.parse(fs.readFileSync(reportPath, "utf8")); }
catch (_) {}

console.log("[verify-packaged] exit status:", run.status, run.signal || "");
if (run.error) console.error("[verify-packaged] spawn error:", run.error.message || run.error);
if (!report) {
  console.error("[verify-packaged] FAIL: the packaged app never wrote a verify report (crashed or hung).");
  process.exit(1);
}
if (!report.ok || (report.failures && report.failures.length)) {
  console.error("[verify-packaged] FAIL: " + (report.failures || ["unknown"]).join(", "));
  console.error(JSON.stringify(report, null, 2).slice(0, 4000));
  process.exit(1);
}
console.log("[verify-packaged] PASS: the packaged app works normally on " + process.platform +
  " (window, click decisions, PTY, bridge).");
