"use strict";

/* The access-level -> CLI-flag mapping IS the security boundary the Options
   UI promises. These tests pin the exact flag combinations so a refactor
   cannot silently re-enable a tool an access level is supposed to deny. */

const test = require("node:test");
const assert = require("node:assert");
const { claudeCliArgs, clampAccess } = require("../bridge.js");

function allowedTools(args) {
  const i = args.indexOf("--allowedTools");
  return i === -1 ? "" : String(args[i + 1] || "");
}
function permissionMode(args) {
  const i = args.indexOf("--permission-mode");
  return i === -1 ? "" : String(args[i + 1] || "");
}

test("read-only denies Edit, Write, and Bash", () => {
  const args = claudeCliArgs({ access: "read-only" });
  assert.strictEqual(permissionMode(args), "dontAsk");
  assert.strictEqual(allowedTools(args), "Read,Glob,Grep");
  assert.ok(!args.join(" ").includes("Bash"), "Bash must not appear in read-only args");
});

test("unspecified access falls back to read-only", () => {
  const args = claudeCliArgs({});
  assert.strictEqual(permissionMode(args), "dontAsk");
  assert.strictEqual(allowedTools(args), "Read,Glob,Grep");
});

test("workspace mode allows edits but not shell by default", () => {
  const args = claudeCliArgs({ access: "workspace" });
  assert.strictEqual(permissionMode(args), "acceptEdits");
  assert.strictEqual(allowedTools(args), "Read,Glob,Grep,Edit,Write");
  assert.ok(!allowedTools(args).includes("Bash"), "Bash must be opt-in");
});

test("shell access requires the explicit opt-in flag, strictly boolean", () => {
  assert.strictEqual(allowedTools(claudeCliArgs({ access: "workspace", shell: true })),
    "Read,Glob,Grep,Edit,Write,Bash");
  // truthy-but-not-true values (a string from a hand-rolled request) do not count
  assert.strictEqual(allowedTools(claudeCliArgs({ access: "workspace", shell: "yes" })),
    "Read,Glob,Grep,Edit,Write");
  // shell without workspace never grants anything beyond read-only
  assert.strictEqual(allowedTools(claudeCliArgs({ access: "read-only", shell: true })),
    "Read,Glob,Grep");
});

test("the desktop-owned ceiling clamps whatever the request body asks for", () => {
  const ro = { access: "read-only", shell: false };
  const ws = { access: "workspace", shell: false };
  const wsShell = { access: "workspace", shell: true };
  // a read-only ceiling denies workspace and shell no matter what is asked
  assert.deepStrictEqual(clampAccess({ access: "workspace", shell: true }, ro),
    { access: "read-only", shell: false });
  // a workspace ceiling without shell denies shell
  assert.deepStrictEqual(clampAccess({ access: "workspace", shell: true }, ws),
    { access: "workspace", shell: false });
  // the full ceiling still only grants what was requested
  assert.deepStrictEqual(clampAccess({ access: "read-only" }, wsShell),
    { access: "read-only", shell: false });
  assert.deepStrictEqual(clampAccess({ access: "workspace", shell: true }, wsShell),
    { access: "workspace", shell: true });
  // shell can never ride along without workspace access
  assert.deepStrictEqual(clampAccess({ access: "read-only", shell: true }, wsShell),
    { access: "read-only", shell: false });
  // no ceiling (standalone dev bridge) trusts the body, as before
  assert.deepStrictEqual(clampAccess({ access: "workspace", shell: true }, null),
    { access: "workspace", shell: true });
});

test("model, system prompt, and session resume flags pass through", () => {
  const args = claudeCliArgs({
    access: "read-only", model: "claude-opus-5",
    system: "be terse", sessionId: "abc123",
  });
  assert.ok(args.includes("--model") && args[args.indexOf("--model") + 1] === "claude-opus-5");
  assert.ok(args.includes("--append-system-prompt"));
  assert.ok(args.includes("--resume") && args[args.indexOf("--resume") + 1] === "abc123");
  assert.strictEqual(claudeCliArgs({ access: "read-only", model: "default" }).includes("--model"), false);
});
