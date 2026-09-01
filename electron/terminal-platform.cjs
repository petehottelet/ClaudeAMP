"use strict";

/* Cross-platform terminal choices kept outside Electron's main process so the
   macOS rules can be unit-tested on Windows. Finder/Dock launches do not
   guarantee that $SHELL describes the account's configured login shell, so on
   macOS ask Directory Services first and use the inherited value as fallback. */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

function executable(file, accessSync = fs.accessSync) {
  if (!file || !path.isAbsolute(file)) return false;
  try { accessSync(file, fs.constants.X_OK); return true; }
  catch (_) { return false; }
}

function macAccountShell(options = {}) {
  const exec = options.execFileSync || execFileSync;
  const username = options.username || os.userInfo().username;
  if (!username) return "";
  try {
    const output = exec("/usr/bin/dscl", [".", "-read", "/Users/" + username, "UserShell"], {
      encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
    });
    return String(output || "").match(/UserShell:\s*(\S+)/)?.[1] || "";
  } catch (_) { return ""; }
}

function resolveLoginShell(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const accessSync = options.accessSync || fs.accessSync;
  const candidates = [];
  if (platform === "darwin") candidates.push(macAccountShell(options));
  candidates.push(String(env.SHELL || ""));
  if (platform === "darwin") candidates.push("/bin/zsh", "/bin/bash");
  else candidates.push("/bin/bash", "/bin/sh");
  return candidates.find(file => executable(file, accessSync)) ||
    (platform === "darwin" ? "/bin/zsh" : "/bin/sh");
}

function loginShellArgs(platform = process.platform) {
  return platform === "win32" ? [] : ["-l"];
}

function isRealTerminalBackend(platform, backend) {
  return platform === "win32"
    ? /^(?:conpty|winpty)-host$/.test(String(backend || ""))
    : /^(?:pty|pty-host)$/.test(String(backend || ""));
}

module.exports = { macAccountShell, resolveLoginShell, loginShellArgs, isRealTerminalBackend };
