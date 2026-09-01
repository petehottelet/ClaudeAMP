"use strict";

/* End-to-end test of the CLI relay: a real bridge on an ephemeral port, a
   stubbed `claude` CLI on PATH emitting canned stream-json, and assertions
   over the security boundary (token, origin, access ceiling) and the SSE
   stream a chat client actually receives. */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudeamp-stub-"));
const argvLog = path.join(stubDir, "argv.json");

// The stub speaks just enough of the claude CLI's surface: --version,
// `auth status --json`, and a -p chat run emitting stream-json. It records
// its argv so the test can assert exactly which flags the bridge passed.
fs.writeFileSync(path.join(stubDir, "claude.js"), `
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.5.0 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, account: { email: "stub@example.com" } })); process.exit(0); }
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args));
process.stdin.resume();
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "system", session_id: "stub-session-1" }));
  console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "HELLO FROM STUB" } } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", usage: { input_tokens: 7, output_tokens: 3 }, stop_reason: "end_turn" }));
  process.exit(0);
});
`);
fs.writeFileSync(path.join(stubDir, "claude"),
  '#!/bin/sh\nexec node "$(dirname "$0")/claude.js" "$@"\n', { mode: 0o755 });
fs.writeFileSync(path.join(stubDir, "claude.cmd"),
  '@node "%~dp0claude.js" %*\r\n');

process.env.PATH = stubDir + path.delimiter + process.env.PATH;

const bridge = require("../bridge.js");

let port = 0;
const base = () => "http://127.0.0.1:" + port;

async function chat(body, headers = {}) {
  const response = await fetch(base() + "/bridge/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-claudeamp-token": bridge.getToken(),
      ...headers,
    },
    body: JSON.stringify({
      cli: "claude", model: "default", maxTokens: 1024,
      messages: [{ role: "user", content: "ping" }],
      ...body,
    }),
  });
  return response;
}

async function readSse(response) {
  const events = [];
  const text = await response.text();
  for (const part of text.split(/\r?\n\r?\n/)) {
    for (const line of part.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        try { events.push(JSON.parse(line.slice(5).trim())); } catch (_) { /* keepalive */ }
      }
    }
  }
  return events;
}

test("bridge integration", async t => {
  await new Promise(resolve => bridge.startBridge(0, resolve));
  port = bridge.server.address().port;
  await bridge.refreshAvailability();
  t.after(() => new Promise(resolve => bridge.stopBridge(resolve)));

  await t.test("the stub CLI probes as installed, authenticated, and new enough", () => {
    const status = bridge.availabilitySnapshot();
    assert.equal(status.claude.installed, true);
    assert.equal(status.claude.ready, true, status.claude.error);
    assert.match(status.claude.version, /2\.5\.0/);
    assert.equal(status.claude.account, "stub@example.com");
  });

  await t.test("a provably old CLI is refused at probe time with an upgrade hint", () => {
    assert.equal(bridge.claudeVersionSupported("1.0.128 (Claude Code)").ok, false);
    assert.equal(bridge.claudeVersionSupported("2.1.251 (Claude Code)").ok, true);
    assert.equal(bridge.claudeVersionSupported("mystery build").ok, true);
  });

  await t.test("chat without the bearer token is rejected", async () => {
    const response = await chat({}, { "x-claudeamp-token": "wrong" });
    assert.equal(response.status, 403);
  });

  await t.test("chat from a foreign web origin is rejected even with the token", async () => {
    const response = await chat({}, { origin: "https://evil.example" });
    assert.equal(response.status, 403);
  });

  await t.test("the status payload never leaks the token in embedded mode", async () => {
    bridge.setEmbedded(true);
    try {
      const status = await (await fetch(base() + "/bridge/status")).json();
      assert.equal(status.token, undefined);
      assert.equal(status.path, undefined);
      assert.ok(status.claude);
    } finally {
      bridge.setEmbedded(false);
    }
  });

  await t.test("a full chat round trip streams session, text, and done", async () => {
    bridge.setAccessCeiling(null);
    const events = await readSse(await chat({ access: "read-only" }));
    const types = events.map(event => event.type);
    assert.ok(types.includes("session"), "expected a session event: " + types.join(","));
    assert.equal(events.find(event => event.type === "session").id, "stub-session-1");
    assert.equal(events.filter(event => event.type === "text").map(event => event.text).join(""),
      "HELLO FROM STUB");
    const done = events.find(event => event.type === "done");
    assert.ok(done, "expected a done event: " + types.join(","));
    assert.deepEqual(done.usage, { input: 7, output: 3 });
    const argv = JSON.parse(fs.readFileSync(argvLog, "utf8"));
    assert.ok(argv.includes("dontAsk"), "read-only must use dontAsk: " + argv.join(" "));
    assert.equal(argv[argv.indexOf("--allowedTools") + 1], "Read,Glob,Grep");
  });

  await t.test("the desktop ceiling overrides what the request body asks for", async () => {
    bridge.setAccessCeiling({ access: "read-only", shell: false });
    try {
      const events = await readSse(await chat({ access: "workspace", shell: true }));
      assert.ok(events.some(event => event.type === "done"));
      const argv = JSON.parse(fs.readFileSync(argvLog, "utf8"));
      assert.equal(argv[argv.indexOf("--allowedTools") + 1], "Read,Glob,Grep",
        "ceiling must clamp to read-only tools: " + argv.join(" "));
      assert.ok(!argv.join(" ").includes("Bash"));
    } finally {
      bridge.setAccessCeiling(null);
    }
  });
});
