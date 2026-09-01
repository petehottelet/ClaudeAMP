"use strict";

/* A shell prompt is not a reliable readiness signal: cmd.exe can emit a few
   control bytes before it is capable of handling input. Prove both halves of
   the PTY by writing a unique marker and waiting to read it back. */
const READY_PREFIX = "__CA_READY_";

function readyMarker(random = Math.random) {
  const entropy = String(random()).replace(/[^0-9a-z]/gi, "").slice(0, 8) || Date.now().toString(36).slice(-8);
  return READY_PREFIX + entropy.toUpperCase() + "__";
}

function cmdEscapedMarker(marker) {
  const at = Math.max(1, Math.floor(marker.length / 2));
  return marker.slice(0, at) + "^" + marker.slice(at);
}

function readyProbe(marker, platform = process.platform) {
  // Caret-escape one character so the full marker is absent from cmd's input
  // echo. It only becomes contiguous after cmd executes the command.
  // Do not append \`& cls\`: ConPTY may coalesce the echo and clear-screen into
  // one screen diff, erasing the marker before node-pty can observe it.
  if (platform === "win32") return "echo " + cmdEscapedMarker(marker) + "\r";
  return "printf '\\n" + marker + "\\n'; pwd\r";
}

function readyScreenReset(platform = process.platform) {
  return platform === "win32" ? "cls\r" : "";
}

function hasReadyMarker(output, marker) {
  return String(output || "").includes(marker);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* cmd echoes the probe command and then the marker. Remove both marker lines
   from the initial buffer, but retain cwd/prompt text for xterm to render. */
function stripReadyProbe(output, marker) {
  const signature = [marker, cmdEscapedMarker(marker)].map(escapeRegExp).join("|");
  const lineWithMarker = new RegExp("[^\\r\\n]*(?:" + signature + ")[^\\r\\n]*(?:\\r\\n|\\r|\\n)?", "g");
  return String(output || "").replace(lineWithMarker, "");
}

module.exports = { READY_PREFIX, readyMarker, readyProbe, readyScreenReset,
  hasReadyMarker, stripReadyProbe };
