"use strict";
/* node-pty 1.1.0 locates its conout worker thread with
 *   __dirname.replace('node_modules.asar', 'node_modules.asar.unpacked')
 * which only works if the app bundles node_modules as its OWN asar named
 * node_modules.asar. electron-builder instead produces a single app.asar,
 * so the replace matches nothing and the worker is loaded from INSIDE
 * app.asar - which worker_threads cannot do, so pty.spawn() hangs forever
 * (both the winpty AND conpty backends go through this same worker).
 *
 * This patch teaches the path resolver about app.asar -> app.asar.unpacked,
 * so the worker loads from the unpacked copy electron-builder emits, AND wraps
 * the conout worker with diagnostics (does the worker file exist? does the
 * worker error, exit, or become ready?) written to a log the app surfaces into
 * its terminal trace - the conout worker going silent is the failure we are
 * chasing on some Windows machines. Runs as a postinstall hook so every
 * `npm ci` re-applies it before packaging. */
const fs = require("fs");
const path = require("path");

const target = path.join(__dirname, "..", "node_modules", "node-pty", "lib", "windowsConoutConnection.js");
const agentTarget = path.join(__dirname, "..", "node_modules", "node-pty", "lib", "windowsPtyAgent.js");
const MARKER = "/* claudeamp-asar-patch */";
const INSTR_MARKER = "/* claudeamp-conout-diag */";
const AGENT_MARKER = "/* claudeamp-agent-diag */";

const SCRIPT_ORIGINAL =
  "var scriptPath = __dirname.replace('node_modules.asar', 'node_modules.asar.unpacked');";
const SCRIPT_REPLACEMENT =
  MARKER + " var scriptPath = __dirname;\n" +
  "        if (scriptPath.indexOf('app.asar') !== -1 && scriptPath.indexOf('app.asar.unpacked') === -1) {\n" +
  "            scriptPath = scriptPath.replace('app.asar', 'app.asar.unpacked');\n" +
  "        }\n" +
  "        scriptPath = scriptPath.replace('node_modules.asar', 'node_modules.asar.unpacked');";

// Instrument the worker so a silent conout pipe explains itself. Logs go to a
// temp file the main process reads back into the on-screen terminal trace.
const WORKER_ORIGINAL =
  "this._worker = new worker_threads_1.Worker(path_1.join(scriptPath, 'worker/conoutSocketWorker.js'), { workerData: workerData });";
const WORKER_REPLACEMENT =
  INSTR_MARKER + "\n" +
  "        var __caDiag = function (m) { try { require('fs').appendFileSync(require('path').join(require('os').tmpdir(), 'claudeamp-conout.log'), m + '\\n'); } catch (e) {} };\n" +
  "        var __caWorkerPath = path_1.join(scriptPath, 'worker/conoutSocketWorker.js');\n" +
  "        try { __caDiag('conout worker path=' + __caWorkerPath + ' exists=' + require('fs').existsSync(__caWorkerPath)); } catch (e) {}\n" +
  "        this._worker = new worker_threads_1.Worker(__caWorkerPath, { workerData: workerData });\n" +
  "        this._worker.on('error', function (err) { __caDiag('conout worker ERROR: ' + (err && err.stack || err)); });\n" +
  "        this._worker.on('exit', function (code) { __caDiag('conout worker EXIT code=' + code); });\n" +
  "        this._worker.on('message', function (m) { __caDiag('conout worker message=' + m); });";

try {
  let src = fs.readFileSync(target, "utf8");
  let changed = false;

  if (!src.includes(MARKER)) {
    if (src.includes(SCRIPT_ORIGINAL)) { src = src.replace(SCRIPT_ORIGINAL, SCRIPT_REPLACEMENT); changed = true; }
    else { console.log("[patch-node-pty] scriptPath line not found (node-pty version changed?)"); }
  }
  if (!src.includes(INSTR_MARKER)) {
    if (src.includes(WORKER_ORIGINAL)) { src = src.replace(WORKER_ORIGINAL, WORKER_REPLACEMENT); changed = true; }
    else { console.log("[patch-node-pty] worker line not found for diagnostics"); }
  }

  if (changed) { fs.writeFileSync(target, src); console.log("[patch-node-pty] patched conout worker (path + diagnostics)"); }
  else { console.log("[patch-node-pty] conout worker already patched"); }
} catch (error) {
  // node-pty is an optionalDependency; a missing file must not fail install.
  console.log("[patch-node-pty] skipped: " + (error && error.message));
}

// Trace the downstream conout socket chain (worker-ready -> connect -> data),
// so we can tell a never-ready worker from a pipe that connects but never
// delivers bytes.
const AGENT_ORIGINAL =
  "        this._conoutSocketWorker.onReady(function () {\n" +
  "            _this._conoutSocketWorker.connectSocket(_this._outSocket);\n" +
  "        });\n" +
  "        this._outSocket.on('connect', function () {\n" +
  "            _this._outSocket.emit('ready_datapipe');\n" +
  "        });";
const AGENT_REPLACEMENT =
  "        " + AGENT_MARKER + "\n" +
  "        var __caDiag2 = function (m) { try { require('fs').appendFileSync(require('path').join(require('os').tmpdir(), 'claudeamp-conout.log'), m + '\\n'); } catch (e) {} };\n" +
  "        this._conoutSocketWorker.onReady(function () {\n" +
  "            __caDiag2('conout worker READY -> connecting out socket');\n" +
  "            _this._conoutSocketWorker.connectSocket(_this._outSocket);\n" +
  "        });\n" +
  "        this._outSocket.on('connect', function () {\n" +
  "            __caDiag2('conout out socket CONNECTED');\n" +
  "            _this._outSocket.emit('ready_datapipe');\n" +
  "        });\n" +
  "        this._outSocket.on('error', function (e) { __caDiag2('conout out socket ERROR: ' + (e && e.message || e)); });\n" +
  "        this._outSocket.once('data', function () { __caDiag2('conout out socket FIRST DATA'); });";

try {
  let asrc = fs.readFileSync(agentTarget, "utf8");
  if (asrc.includes(AGENT_MARKER)) { console.log("[patch-node-pty] agent already patched"); }
  else if (!asrc.includes(AGENT_ORIGINAL)) { console.log("[patch-node-pty] agent onReady block not found"); }
  else { fs.writeFileSync(agentTarget, asrc.replace(AGENT_ORIGINAL, AGENT_REPLACEMENT)); console.log("[patch-node-pty] patched agent conout socket diagnostics"); }
} catch (error) {
  console.log("[patch-node-pty] agent skip: " + (error && error.message));
}

/* node-pty's npm tarball ships the darwin prebuilds' spawn-helper without the
 * executable bit (mode 644). On the arch the CI runner compiled natively this
 * is masked - build/Release wins the loader race - but the OTHER mac arch
 * falls through to its prebuild and posix_spawn of a non-executable helper
 * fails, killing the real terminal (e.g. x64 artifacts built on an arm64
 * runner). Restore the bit so packaged apps carry a runnable helper. */
for (const arch of ["darwin-arm64", "darwin-x64"]) {
  const helper = path.join(__dirname, "..", "node_modules", "node-pty", "prebuilds", arch, "spawn-helper");
  try {
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755);
      console.log("[patch-node-pty] spawn-helper executable bit set (" + arch + ")");
    }
  } catch (error) {
    console.log("[patch-node-pty] spawn-helper chmod skip (" + arch + "): " + (error && error.message));
  }
}
