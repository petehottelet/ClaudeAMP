"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { READY_PREFIX, readyMarker, readyProbe, readyScreenReset, hasReadyMarker, stripReadyProbe } =
  require("../electron/terminal-protocol.cjs");
const { resolveLoginShell, loginShellArgs, isRealTerminalBackend } =
  require("../electron/terminal-platform.cjs");

test("terminal readiness probe proves a Windows shell round trip", () => {
  const marker = readyMarker(() => 0.123456789);
  assert.match(marker, new RegExp("^" + READY_PREFIX));
  const probe = readyProbe(marker, "win32");
  assert.match(probe, /\^/);
  assert.doesNotMatch(probe, /& cd/);
  assert.doesNotMatch(probe, /cls/i);
  assert.equal(readyScreenReset("win32"), "cls\r");
  assert.equal(probe.includes(marker), false, "input echo must not satisfy readiness");
  const first = "\u001b[?25hC:\\Users\\Pete>" + probe + "\r\n";
  const second = marker + "\r\n\u001b[9;1HC:\\Users\\Pete>";
  assert.equal(hasReadyMarker(first, marker), false);
  assert.equal(hasReadyMarker(first + second, marker), true);
  const clean = stripReadyProbe(first + second, marker);
  assert.doesNotMatch(clean, new RegExp(marker));
  assert.match(clean, /\u001b\[9;1H/);
  assert.match(clean, /C:\\Users\\Pete/);
});

test("macOS resolves the account login shell before an inherited SHELL", () => {
  const executable = new Set(["/opt/homebrew/bin/fish", "/bin/zsh"]);
  const shell = resolveLoginShell({
    platform: "darwin",
    env: { SHELL: "/bin/zsh" },
    username: "pete",
    execFileSync: () => "UserShell: /opt/homebrew/bin/fish\n",
    accessSync: file => { if (!executable.has(file)) throw new Error("missing"); },
  });
  assert.equal(shell, "/opt/homebrew/bin/fish");
  assert.deepEqual(loginShellArgs("darwin"), ["-l"]);
});

test("macOS safely falls back when Directory Services is unavailable", () => {
  const shell = resolveLoginShell({
    platform: "darwin",
    env: { SHELL: "/bin/zsh" },
    username: "pete",
    execFileSync: () => { throw new Error("dscl unavailable"); },
    accessSync: file => { if (file !== "/bin/zsh") throw new Error("missing"); },
  });
  assert.equal(shell, "/bin/zsh");
});

test("real PTY backend verification is platform-aware", () => {
  assert.equal(isRealTerminalBackend("win32", "conpty-host"), true);
  assert.equal(isRealTerminalBackend("win32", "winpty-host"), true);
  assert.equal(isRealTerminalBackend("darwin", "pty-host"), true);
  assert.equal(isRealTerminalBackend("darwin", "pty"), true);
  assert.equal(isRealTerminalBackend("darwin", "piped"), false);
  assert.equal(isRealTerminalBackend("win32", "pty-host"), false);
});
