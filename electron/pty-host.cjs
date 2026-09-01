"use strict";

/* ClaudeAmp PTY host.

   node-pty runs here, in an isolated Electron utilityProcess, NOT in the main
   process. This is the single most important robustness decision for the
   terminal: on some real Windows machines the ConPTY spawn of PowerShell
   blocks *synchronously* (security software that inspects every powershell.exe
   launch can stall CreateProcess, and ConPTY can deadlock draining its conout
   pipe). A synchronous block inside pty.spawn() cannot be timed out by the
   caller - the call never returns - so if it ran in the main process it would
   freeze the whole app on a black terminal panel, which is exactly what users
   hit. Running it out-of-process means the main process stays responsive and
   can simply kill this host and fall back to another shell/backend.

   This mirrors how VS Code (its "pty host") and Tabby isolate PTYs.

   Protocol (main <-> host), one shell per host instance:
     main -> host : { type: "spawn", shell, args, options }
                    { type: "input", data }
                    { type: "resize", cols, rows }
                    { type: "kill" }
     host -> main : { type: "trace", line }           // step-by-step diagnostics
                    { type: "ptyReady", pid }          // pty.spawn() returned
                    { type: "spawn-error", error }     // pty.spawn() threw
                    { type: "data", data }             // shell output
                    { type: "exit", code }             // shell process ended
*/

const port = process.parentPort;
if (!port) process.exit(1);

let nodePty = null;
let proc = null;

function post(msg) {
  try { port.postMessage(msg); } catch (_) {}
}
function trace(line) { post({ type: "trace", line: "host: " + line }); }

port.on("message", event => {
  const msg = event && event.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "spawn") {
    // Retire any previous shell before starting a new one.
    if (proc) { try { proc.kill(); } catch (_) {} proc = null; }
    if (!nodePty) {
      trace("loading node-pty");
      try { nodePty = require("node-pty"); }
      catch (error) {
        post({ type: "spawn-error", error: "node-pty failed to load: " + (error && error.message || error) });
        return;
      }
      trace("node-pty loaded");
    }
    let spawned;
    trace("calling pty.spawn(" + msg.shell + ", useConpty=" + !!(msg.options && msg.options.useConpty) + ")");
    try {
      spawned = nodePty.spawn(msg.shell, msg.args || [], msg.options || {});
    } catch (error) {
      // A thrown spawn is a clean failure the main process can fall back from.
      post({ type: "spawn-error", error: String(error && error.message || error) });
      return;
    }
    proc = spawned;
    // pty.spawn() returned without hanging - tell the main process it is safe.
    trace("pty.spawn returned (pid " + proc.pid + ")");
    post({ type: "ptyReady", pid: proc.pid });
    let sawData = false;
    proc.onData(data => {
      if (!sawData) { sawData = true; trace("first output (" + data.length + " bytes)"); }
      post({ type: "data", data });
    });
    proc.onExit(({ exitCode }) => {
      trace("pty exited (code " + exitCode + ")");
      post({ type: "exit", code: exitCode });
      proc = null;
    });
    return;
  }

  if (!proc) return;
  if (msg.type === "input") {
    try { proc.write(String(msg.data)); } catch (_) {}
  } else if (msg.type === "resize") {
    const cols = Math.max(1, Number(msg.cols) || 0);
    const rows = Math.max(1, Number(msg.rows) || 0);
    if (cols && rows) { try { proc.resize(cols, rows); } catch (_) {} }
  } else if (msg.type === "kill") {
    try { proc.kill(); } catch (_) {}
    proc = null;
  }
});
