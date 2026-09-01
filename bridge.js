#!/usr/bin/env node
/* ClaudeAmp local bridge: static app server, Claude Code / Codex relay,
   and the minibrowser's YouTube search adapter. */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, execFile, execFileSync } = require("child_process");

/* macOS/Linux GUI apps launched from Finder/Dock inherit a stripped PATH
   (/usr/bin:/bin:/usr/sbin:/sbin) that omits Homebrew, nvm, npm-global,
   volta, ~/.local/bin, etc. - so the bridge can't find `claude`/`codex`
   even though the user logged in fine from Terminal. Rebuild PATH from
   the user's login shell (authoritative) plus the usual install dirs. */
function augmentPath() {
  if (process.platform === "win32") return;
  const parts = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const add = dir => { if (dir && !parts.includes(dir)) parts.push(dir); };
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const out = execFileSync(shell, ["-lic", "printf %s \"$PATH\""],
      { timeout: 4000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const dir of String(out).split(path.delimiter)) add(dir.trim());
  } catch (_) { /* fall back to the static list below */ }
  const home = os.homedir();
  for (const dir of [
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, "bin"),
  ]) { if (fs.existsSync(dir)) add(dir); }
  process.env.PATH = parts.join(path.delimiter);
}
augmentPath();

const ROOT = __dirname;
let workspaceRoot = process.env.CLAUDEAMP_WORKSPACE ? path.resolve(process.env.CLAUDEAMP_WORKSPACE) : ROOT;
const DEFAULT_PORT = 8014;
const OLLAMA_HOST = "127.0.0.1";
const OLLAMA_PORT = 11434;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_ACTIVE_RUNS = 2;
const RUN_TIMEOUT = 5 * 60 * 1000;
const TOKEN = crypto.randomBytes(32).toString("hex");
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".png": "image/png",
  ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

let listenPort = null;
let activeRuns = 0;
let probing = null;
const availability = {
  claude: { installed: false, ready: false, version: "", account: "", error: "checking CLI" },
  codex: { installed: false, ready: false, version: "", account: "", error: "checking CLI" },
  ollama: { installed: false, ready: false, version: "", models: [], error: "checking Ollama" },
};

function firstLine(value) {
  return String(value || "").trim().split(/\r?\n/)[0].slice(0, 240);
}

function cliInvocation(command, args) {
  if (process.platform !== "win32") return { command, args };
  const directories = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const cleanDirectory = directory.replace(/^"|"$/g, "");
    const executable = path.join(cleanDirectory, command + ".exe");
    if (fs.existsSync(executable)) return { command: executable, args };
    const script = path.join(cleanDirectory, command + ".cmd");
    if (fs.existsSync(script)) {
      return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", script, ...args] };
    }
  }
  return { command, args };
}

function execResult(command, args, timeout = 8000) {
  return new Promise(resolve => {
    try {
      const invocation = cliInvocation(command, args);
      execFile(invocation.command, invocation.args, { cwd: workspaceRoot, timeout, windowsHide: true }, (error, stdout, stderr) => {
        resolve({ ok: !error, error, stdout: String(stdout || ""), stderr: String(stderr || "") });
      });
    } catch (error) {
      resolve({ ok: false, error, stdout: "", stderr: error.message || String(error) });
    }
  });
}

function spawnCli(command, args, options) {
  const invocation = cliInvocation(command, args);
  return spawn(invocation.command, invocation.args, options);
}

async function probeOne(name) {
  const status = availability[name];
  const version = await execResult(name, ["--version"]);
  status.installed = version.ok;
  status.version = version.ok ? firstLine(version.stdout || version.stderr) : "";
  if (!version.ok) {
    status.ready = false;
    status.error = name + " CLI is not installed or not on PATH";
    return;
  }

  if (name === "claude") {
    const support = claudeVersionSupported(status.version);
    if (!support.ok) {
      status.ready = false;
      status.account = "";
      status.error = "Claude Code " + support.version + " is too old - the chat relay needs v" +
        MIN_CLAUDE_MAJOR + "+ (npm i -g @anthropic-ai/claude-code)";
      return;
    }
    const auth = await execResult("claude", ["auth", "status", "--json"]);
    if (!auth.ok) {
      status.ready = false;
      status.account = "";
      status.error = firstLine(auth.stderr || auth.stdout) || "Claude Code is not authenticated";
      return;
    }
    try {
      const parsed = JSON.parse(auth.stdout);
      status.ready = !!parsed.loggedIn;
      status.account = accountLabel(parsed);
      status.error = status.ready ? "" : "Claude Code is not authenticated";
    } catch (_) {
      status.ready = false;
      status.account = "";
      status.error = "Claude Code returned an unreadable authentication status";
    }
    return;
  }

  const auth = await execResult("codex", ["login", "status"]);
  status.ready = auth.ok;
  status.account = auth.ok ? accountFromText(auth.stdout) : "";
  status.error = auth.ok ? "" : (firstLine(auth.stderr || auth.stdout) || "Codex CLI is not authenticated");
}

/* The relay's flags (--permission-mode, --allowedTools, auth status --json)
   are version-sensitive; fail loudly at probe time with an upgrade hint
   rather than mid-chat with an opaque CLI error. An unparseable version
   string does not block - only a provably old one does. */
const MIN_CLAUDE_MAJOR = 2;
function claudeVersionSupported(versionLine) {
  const match = String(versionLine || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return { ok: true, version: "" };
  return { ok: Number(match[1]) >= MIN_CLAUDE_MAJOR, version: match[0] };
}

// Pull a human label (email / account / org) out of an auth-status payload.
function accountLabel(parsed) {
  if (!parsed || typeof parsed !== "object") return "";
  const account = parsed.account || parsed.user || parsed;
  const value = account.email || account.emailAddress || parsed.email ||
    account.name || account.login || account.organizationName || parsed.organization || "";
  return String(value || "").trim().slice(0, 80);
}
function accountFromText(text) {
  const line = String(text || "");
  const email = line.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (email) return email[0].slice(0, 80);
  const named = line.match(/(?:logged in as|account|user)[:\s]+([^\n]+)/i);
  return named ? named[1].trim().slice(0, 80) : "";
}

async function logoutCli(name) {
  const status = availability[name];
  const attempts = name === "claude"
    ? [["auth", "logout"], ["logout"]]
    : [["logout"], ["auth", "logout"]];
  let result;
  for (const args of attempts) {
    result = await execResult(name, args, 15000);
    if (result.ok) break;
  }
  await refreshAvailability();
  return { ok: !status.ready, error: status.ready ? "logout did not clear the session" : "" };
}

function ollamaJson(method, apiPath, payload, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? "" : JSON.stringify(payload);
    const request = http.request({
      hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: apiPath, method,
      headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {},
    }, response => {
      let body = "", bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes <= MAX_BODY) body += chunk.toString();
      });
      response.on("end", () => {
        if (bytes > MAX_BODY) { reject(new Error("Ollama response was too large")); return; }
        let value;
        try { value = body ? JSON.parse(body) : {}; }
        catch (_) { reject(new Error("Ollama returned invalid JSON")); return; }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(value.error || "Ollama returned " + response.statusCode)); return;
        }
        resolve(value);
      });
    });
    request.setTimeout(timeout, () => request.destroy(new Error("Ollama did not respond")));
    request.on("error", reject);
    request.end(data);
  });
}

async function probeOllama() {
  const status = availability.ollama;
  try {
    const value = await ollamaJson("GET", "/api/tags");
    status.installed = true;
    status.version = "LOCAL";
    status.models = (Array.isArray(value.models) ? value.models : []).map(item => ({
      id: String(item.model || item.name || "").slice(0, 200),
      name: String(item.name || item.model || "").slice(0, 200),
      size: Number(item.size) || 0,
      modified: String(item.modified_at || "").slice(0, 40),
      family: String(item.details?.family || "").slice(0, 80),
      parameters: String(item.details?.parameter_size || "").slice(0, 40),
      quantization: String(item.details?.quantization_level || "").slice(0, 40),
    })).filter(item => item.id);
    status.ready = status.models.length > 0;
    status.error = status.ready ? "" : "Ollama is running; pull a local model first";
  } catch (_) {
    status.installed = false;
    status.ready = false;
    status.models = [];
    status.error = "Ollama is not running on 127.0.0.1:11434";
  }
}

function refreshAvailability() {
  if (!probing) {
    probing = Promise.all([probeOne("claude"), probeOne("codex"), probeOllama()])
      .finally(() => { probing = null; });
  }
  return probing;
}
refreshAvailability();

function availabilitySnapshot() {
  const snapshot = {
    claude: { ...availability.claude }, codex: { ...availability.codex },
    ollama: { ...availability.ollama, models: availability.ollama.models.map(model => ({ ...model })) },
    workspace: workspaceRoot,
  };
  if (!embedded) { snapshot.token = TOKEN; snapshot.path = process.env.PATH; }
  return snapshot;
}

/* Embedded mode (set by the Electron main process): the renderer receives
   the bearer token over IPC instead of the status payload, so a local
   process curling /bridge/status learns neither the token nor PATH. In
   standalone `node bridge.js` dev mode the token stays in the payload -
   the page has no other way to get it. */
let embedded = false;
function setEmbedded(value) { embedded = !!value; }
function getToken() { return TOKEN; }

/* The access ceiling is OWNED by the desktop shell (persisted in its own
   settings file and pushed here over an in-process call), so a request
   body can never grant itself more than the user chose in Options. A null
   ceiling (standalone dev mode) trusts the body, as before. */
let accessCeiling = null;
function setAccessCeiling(value) {
  if (!value || typeof value !== "object") { accessCeiling = null; return; }
  accessCeiling = {
    access: value.access === "workspace" ? "workspace" : "read-only",
    shell: value.shell === true,
  };
}
function clampAccess(body, ceiling) {
  const requestedAccess = body.access === "workspace" ? "workspace" : "read-only";
  const requestedShell = body.shell === true;
  if (!ceiling) return { access: requestedAccess, shell: requestedShell };
  const access = ceiling.access === "workspace" ? requestedAccess : "read-only";
  return { access, shell: requestedShell && ceiling.shell === true && access === "workspace" };
}

function localHostname(value) {
  return value === "localhost" || value === "127.0.0.1" || value === "[::1]";
}

function sameOrigin(req) {
  let host;
  try { host = new URL("http://" + (req.headers.host || "")); }
  catch (_) { return false; }
  if (!localHostname(host.hostname)) return false;
  const requestPort = Number(host.port || 80);
  const actualPort = Number(listenPort || req.socket.localPort || DEFAULT_PORT);
  if (requestPort !== actualPort) return false;

  const origin = req.headers.origin;
  if (!origin) return !req.headers["sec-fetch-site"] || req.headers["sec-fetch-site"] === "same-origin";
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && localHostname(parsed.hostname) &&
      Number(parsed.port || 80) === actualPort;
  } catch (_) { return false; }
}

function hasToken(req) {
  const supplied = String(req.headers["x-claudeamp-token"] || "");
  if (supplied.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(TOKEN));
}

function json(res, code, body) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

// Pasted screenshots arrive as base64 data URLs. The CLIs read files, not
// inline image bytes, so write each into a folder under the workspace (which
// the CLI can open) and reference the paths in the prompt.
function saveMessageImages(message, dir, written) {
  if (!message.images || !message.images.length) return "";
  const paths = [];
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  for (const im of message.images) {
    try {
      const data = String(im.dataUrl || "");
      const comma = data.indexOf(",");
      const b64 = comma >= 0 ? data.slice(comma + 1) : data;
      if (!b64) continue;
      const ext = ((im.mime || "").split("/")[1] || "png").replace(/[^a-z0-9]/gi, "") || "png";
      const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const file = path.join(dir, "paste-" + stamp + "." + ext);
      fs.writeFileSync(file, Buffer.from(b64, "base64"));
      paths.push(file);
      if (written) written.push(file);
    } catch (_) {}
  }
  if (!paths.length) return "";
  return "\n[The user attached " + (paths.length > 1 ? paths.length + " images" : "an image") +
    ". Read " + (paths.length > 1 ? "these files" : "this file") + " to see " +
    (paths.length > 1 ? "them" : "it") + ": " + paths.join(", ") + "]";
}

function flatten(messages, system, forCodex, written) {
  // A dotfolder under the workspace, as the comment above promises: the CLI
  // can read it in every access mode, and the run deletes its files when it
  // finishes (see execution's release()).
  const dir = path.join(workspaceRoot, ".claudeamp-images");
  const lines = [];
  if (forCodex && system) lines.push("[Style instructions: " + system + "]\n");
  if (messages.length > 1) {
    lines.push("Conversation so far:");
    for (const message of messages.slice(0, -1)) {
      lines.push((message.role === "user" ? "USER: " : "ASSISTANT: ") + message.content +
        saveMessageImages(message, dir, written));
    }
    lines.push("");
  }
  lines.push("Reply to this user message (reply with the message content only):");
  const last = messages[messages.length - 1];
  lines.push(last.content + saveMessageImages(last, dir, written));
  return lines.join("\n");
}

function sse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    "connection": "keep-alive",
    "x-content-type-options": "nosniff",
  });
  return event => {
    if (!res.writableEnded && !res.destroyed) res.write("data: " + JSON.stringify(event) + "\n\n");
  };
}

function killChild(child) {
  if (!child || child.killed || !child.pid) return;
  try {
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
    } else child.kill("SIGTERM");
  } catch (_) {}
}

function jsonLineReader(stream, onEvent) {
  let buffer = "";
  const parseLine = line => {
    if (!line.trim()) return;
    try { onEvent(JSON.parse(line)); } catch (_) {}
  };
  const consume = flush => {
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      parseLine(line);
    }
    if (flush && buffer.trim()) parseLine(buffer);
    if (flush) buffer = "";
  };
  stream.on("data", chunk => { buffer += chunk.toString(); consume(false); });
  return () => consume(true);
}

function execution(body, res, req, cliName) {
  const send = sse(res);
  const maxTokens = Math.max(128, Math.min(32768, Number(body.maxTokens) || 4096));
  const maxChars = maxTokens * 4;
  let outputChars = 0;
  let hitLimit = false;
  let child = null;
  let released = false;
  let timer = null;
  let heartbeat = null;
  let timedOut = false;

  const cleanupFiles = [];
  const release = () => {
    if (released) return;
    released = true;
    activeRuns = Math.max(0, activeRuns - 1);
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    for (const file of cleanupFiles) { try { fs.unlinkSync(file); } catch (_) {} }
  };
  let lastOutputAt = Date.now();
  const emitText = text => {
    if (hitLimit || !text) return;
    lastOutputAt = Date.now();
    const room = maxChars - outputChars;
    const piece = String(text).slice(0, Math.max(0, room));
    if (piece) { outputChars += piece.length; send({ type: "text", text: piece }); }
    if (String(text).length > room || outputChars >= maxChars) {
      hitLimit = true;
      killChild(child);
    }
  };
  const emitStatus = text => {
    const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, 240);
    if (clean) send({ type: "status", text: clean });
  };
  const attach = process => {
    child = process;
    const startedAt = Date.now();
    // Only speak up when the CLI has been genuinely silent for the whole
    // interval - a reply that is streaming (or a run that just started)
    // needs no "started"/"waiting" chatter interleaved into the chat.
    heartbeat = setInterval(() => {
      if (Date.now() - lastOutputAt < 15000) return;
      const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      emitStatus("Waiting for " + cliName + " (" + seconds + "s)");
    }, 15000);
    timer = setTimeout(() => {
      timedOut = true;
      emitStatus(cliName + " timed out and was stopped");
      killChild(child);
    }, RUN_TIMEOUT);
    res.on("close", () => {
      if (!res.writableEnded) killChild(child);
      release();
    });
    return process;
  };
  // Thinking deltas go through send() directly; they count as activity so
  // the silence heartbeat stays quiet while the model is visibly reasoning.
  const sendEvent = event => {
    if (event && (event.type === "text" || event.type === "thinking")) lastOutputAt = Date.now();
    send(event);
  };
  return {
    send: sendEvent, emitText, emitStatus, attach, release, cleanupFiles,
    get hitLimit() { return hitLimit; },
    get timedOut() { return timedOut; },
  };
}

/* Claude Code permission flags from the requested access level. Exported so
   the mapping is unit-testable (test/bridge-security.test.cjs): the UI's
   promises live or die on these exact flag combinations. */
function claudeCliArgs(body) {
  const args = ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--max-turns", "12"];
  if (body.model && body.model !== "default") args.push("--model", body.model);
  if (body.system) args.push("--append-system-prompt", body.system);
  if (body.sessionId) args.push("--resume", String(body.sessionId));
  if (body.access === "workspace") {
    // Edits are folder-scoped by the CLI, but an auto-approved Bash tool is
    // not confined to the workspace - so shell access is a separate opt-in.
    // (Codex needs no such switch: its --sandbox is OS-enforced.)
    const tools = body.shell === true
      ? "Read,Glob,Grep,Edit,Write,Bash"
      : "Read,Glob,Grep,Edit,Write";
    args.push("--permission-mode", "acceptEdits", "--allowedTools", tools);
  } else {
    // Read-only must actually be read-only: dontAsk alone only suppresses
    // prompts, leaving Edit/Write/Bash enabled. Whitelist the read tools so
    // anything else is denied instead of silently allowed (Codex gets the
    // same guarantee from its real --sandbox read-only below).
    args.push("--permission-mode", "dontAsk", "--allowedTools", "Read,Glob,Grep");
  }
  return args;
}

function runClaude(body, res, req) {
  const run = execution(body, res, req, "Claude Code");
  const args = claudeCliArgs(body);

  const child = run.attach(spawnCli("claude", args, { cwd: workspaceRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }));
  const promptMessages = body.sessionId ? body.messages.slice(-1) : body.messages;
  let sawDelta = false, stderr = "", resultSeen = false;
  child.stdin.end(flatten(promptMessages, null, false, run.cleanupFiles));
  const flush = jsonLineReader(child.stdout, event => {
    if (event.session_id) run.send({ type: "session", id: event.session_id });
    if (event.type === "stream_event" && event.event) {
      const inner = event.event;
      if (inner.type === "content_block_start" && inner.content_block && inner.content_block.type === "tool_use") {
        run.emitStatus("Claude tool: " + (inner.content_block.name || "tool"));
      } else if (inner.type === "content_block_delta" && inner.delta) {
        if (inner.delta.type === "text_delta") { sawDelta = true; run.emitText(inner.delta.text); }
        else if (inner.delta.type === "thinking_delta" && inner.delta.thinking) {
          run.send({ type: "thinking", text: inner.delta.thinking });
        }
      }
    } else if (event.type === "assistant" && !sawDelta && event.message && event.message.content) {
      for (const block of event.message.content) {
        if (block.type === "text" && block.text) run.emitText(block.text);
        else if (block.type === "tool_use") run.emitStatus("Claude tool: " + (block.name || "tool"));
      }
    } else if (event.type === "result") {
      resultSeen = true;
      const usage = event.usage || {};
      if (event.subtype && event.subtype !== "success") {
        run.send({ type: "error", message: "Claude stopped: " + event.subtype.replace(/^error_/, "").replace(/_/g, " ") });
      } else {
        run.send({ type: "done", usage: {
          input: usage.input_tokens || 0, output: usage.output_tokens || 0,
        }, stopReason: run.hitLimit ? "max_tokens" : (event.stop_reason || "end_turn") });
      }
    }
  });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-16000); });
  child.on("close", code => {
    flush();
    if (run.hitLimit) run.send({ type: "done", usage: {}, stopReason: "max_tokens" });
    else if (run.timedOut) run.send({ type: "error", message: "Claude Code did not respond within 5 minutes" });
    else if (!resultSeen && code !== 0) run.send({ type: "error", message: firstLine(stderr) || "Claude Code exited " + code });
    else if (!resultSeen) run.send({ type: "done", usage: {}, stopReason: "end_turn" });
    if (!res.writableEnded) res.end();
    run.release();
  });
  child.on("error", error => {
    run.send({ type: "error", message: "Claude Code: " + error.message });
    if (!res.writableEnded) res.end();
    run.release();
  });
}

function codexItemStatus(item) {
  if (!item) return "";
  if (item.type === "command_execution") return (item.status === "completed" ? "Command complete: " : "Command: ") + (item.command || "shell command");
  if (item.type === "file_change") {
    const files = (item.changes || []).map(change => change.path).filter(Boolean).slice(0, 4);
    return "Files changed: " + (files.join(", ") || "workspace files");
  }
  if (item.type === "mcp_tool_call") return "MCP tool: " + (item.tool || item.name || "tool");
  if (item.type === "web_search") return "Web search: " + (item.query || "searching");
  if (item.type === "plan") return "Plan updated";
  if (item.type === "error") return "Codex notice: " + (item.message || "runtime notice");
  return "";
}

function runCodex(body, res, req) {
  const run = execution(body, res, req, "Codex");
  const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", body.access === "workspace" ? "workspace-write" : "read-only"];
  if (body.model && body.model !== "default") args.push("--model", body.model);
  if (body.sessionId) args.push("resume", String(body.sessionId), "-");
  else args.push("-");

  const child = run.attach(spawnCli("codex", args, { cwd: workspaceRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }));
  const promptMessages = body.sessionId ? body.messages.slice(-1) : body.messages;
  child.stdin.end(flatten(promptMessages, body.system, true, run.cleanupFiles));
  let stderr = "", fatal = "", messageCount = 0;
  const usage = { input: 0, output: 0 };
  const flush = jsonLineReader(child.stdout, event => {
    if (event.type === "thread.started" && event.thread_id) run.send({ type: "session", id: event.thread_id });
    if (event.type === "item.started") run.emitStatus(codexItemStatus(event.item));
    if (event.type === "item.completed" && event.item) {
      const item = event.item;
      if (item.type === "agent_message" && item.text) {
        if (messageCount++) run.emitText("\n");
        run.emitText(item.text);
      } else if ((item.type === "reasoning" || item.type === "agent_reasoning") && (item.text || item.summary)) {
        run.send({ type: "thinking", text: item.text || item.summary });
      } else run.emitStatus(codexItemStatus(item));
    } else if (event.type === "turn.completed") {
      const reported = event.usage || {};
      usage.input = reported.input_tokens || usage.input;
      usage.output = reported.output_tokens || usage.output;
    } else if (event.type === "turn.failed") {
      fatal = (event.error && event.error.message) || "Codex turn failed";
    } else if (event.type === "error") {
      fatal = event.message || (event.error && event.error.message) || fatal;
    }

    const legacy = event.msg || event;
    if (legacy.type === "agent_message_delta" && legacy.delta) run.emitText(legacy.delta);
    else if (legacy.type === "agent_message" && legacy.message) run.emitText(legacy.message);
    else if (legacy.type === "agent_reasoning_delta" && legacy.delta) run.send({ type: "thinking", text: legacy.delta });
    else if (legacy.type === "token_count") {
      const info = legacy.info || legacy;
      const total = info.total_token_usage || info.last_token_usage || info;
      usage.input = total.input_tokens || usage.input;
      usage.output = total.output_tokens || usage.output;
    }
  });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-16000); });
  child.on("close", code => {
    flush();
    if (run.hitLimit) run.send({ type: "done", usage, stopReason: "max_tokens" });
    else if (run.timedOut) run.send({ type: "error", message: "Codex did not respond within 5 minutes" });
    else if (fatal || code !== 0) run.send({ type: "error", message: firstLine(fatal || stderr) || "Codex exited " + code });
    else run.send({ type: "done", usage, stopReason: "end_turn" });
    if (!res.writableEnded) res.end();
    run.release();
  });
  child.on("error", error => {
    run.send({ type: "error", message: "Codex CLI: " + error.message });
    if (!res.writableEnded) res.end();
    run.release();
  });
}

function runOllama(body, res, req) {
  const send = sse(res);
  const available = new Set(availability.ollama.models.map(model => model.id));
  const model = available.has(body.model) ? body.model : availability.ollama.models[0]?.id;
  if (!model) { send({ type: "error", message: "Pull an Ollama model before starting chat" }); res.end(); activeRuns--; return; }
  const messages = [];
  if (body.system) messages.push({ role: "system", content: String(body.system).slice(0, 20000) });
  messages.push(...body.messages.map(message => ({ role: message.role, content: message.content })));
  const maxTokens = Math.max(128, Math.min(32768, Number(body.maxTokens) || 4096));
  const upstream = http.request({
    hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: "/api/chat", method: "POST",
    headers: { "content-type": "application/json" },
  });
  let released = false, terminal = false, errorText = "";
  const release = () => {
    if (released) return;
    released = true;
    activeRuns = Math.max(0, activeRuns - 1);
  };
  const timer = setTimeout(() => upstream.destroy(new Error("Ollama timed out after 5 minutes")), RUN_TIMEOUT);
  res.on("close", () => { if (!res.writableEnded) upstream.destroy(); release(); });
  upstream.on("response", response => {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.on("data", chunk => { errorText = (errorText + chunk.toString()).slice(-8000); });
      response.on("end", () => {
        let message = "Ollama returned " + response.statusCode;
        try { message = JSON.parse(errorText).error || message; } catch (_) {}
        send({ type: "error", message }); res.end(); clearTimeout(timer); release();
      });
      return;
    }
    const flush = jsonLineReader(response, event => {
      if (event.error) { terminal = true; send({ type: "error", message: event.error }); return; }
      const message = event.message || {};
      if (message.thinking) send({ type: "thinking", text: message.thinking });
      if (message.content) send({ type: "text", text: message.content });
      if (event.done) {
        terminal = true;
        send({ type: "done", usage: {
          input: event.prompt_eval_count || 0, output: event.eval_count || 0,
        }, stopReason: event.done_reason === "length" ? "max_tokens" : "end_turn" });
      }
    });
    response.on("end", () => {
      flush();
      if (!terminal) send({ type: "done", usage: {}, stopReason: "end_turn" });
      if (!res.writableEnded) res.end();
      clearTimeout(timer); release();
    });
  });
  upstream.on("error", error => {
    send({ type: "error", message: error.message || "Ollama connection failed" });
    if (!res.writableEnded) res.end();
    clearTimeout(timer); release();
  });
  upstream.end(JSON.stringify({
    model, messages, stream: true, think: !!body.think,
    options: {
      num_predict: maxTokens,
      temperature: Math.max(0, Math.min(2, Number(body.temperature) || 0.7)),
    },
  }));
}

const createMusicRoutes = require("./bridge-music.cjs");
const { handleSpotifyRoute, handleAppleRoute, handleYouTubeRoute } =
  createMusicRoutes({ json, hasToken, getListenPort: () => listenPort, DEFAULT_PORT });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  // The OAuth callback is a top-level cross-site redirect from Spotify, so it
  // can never pass the same-origin gate; its one-time `state` value is the
  // authentication instead (checked inside the handler).
  if (url.pathname === "/bridge/spotify/callback") {
    await handleSpotifyRoute(url, req, res);
    return;
  }
  if (url.pathname.startsWith("/bridge/") && !sameOrigin(req)) {
    json(res, 403, { error: "origin rejected" }); return;
  }
  if (url.pathname.startsWith("/bridge/spotify/")) {
    await handleSpotifyRoute(url, req, res);
    return;
  }
  if (url.pathname.startsWith("/bridge/apple/")) {
    await handleAppleRoute(url, req, res);
    return;
  }

  if (url.pathname === "/bridge/status" && req.method === "GET") {
    if (url.searchParams.get("refresh") === "1") await refreshAvailability();
    json(res, 200, availabilitySnapshot());
    return;
  }

  if (url.pathname === "/bridge/logout" && req.method === "POST") {
    if (!hasToken(req)) { json(res, 403, { error: "bridge token rejected" }); return; }
    const cli = String(url.searchParams.get("cli") || "");
    if (cli !== "claude" && cli !== "codex") { json(res, 400, { error: "unknown cli" }); return; }
    try { json(res, 200, await logoutCli(cli)); }
    catch (error) { json(res, 500, { error: error.message || "logout failed" }); }
    return;
  }

  if (url.pathname.startsWith("/bridge/youtube/")) {
    if (await handleYouTubeRoute(url, req, res)) return;
  }

  if (url.pathname === "/bridge/chat" && req.method === "POST") {
    if (!hasToken(req)) { json(res, 403, { error: "bridge token rejected" }); return; }
    if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      json(res, 415, { error: "application/json required" }); return;
    }
    if (activeRuns >= MAX_ACTIVE_RUNS) { json(res, 429, { error: "Two brain jobs are already running" }); return; }
    let data = "", bytes = 0, tooLarge = false;
    req.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY) tooLarge = true;
      else data += chunk.toString();
    });
    req.on("end", () => {
      if (tooLarge) { json(res, 413, { error: "request is too large" }); return; }
      let body;
      try { body = JSON.parse(data); } catch (_) { json(res, 400, { error: "invalid JSON" }); return; }
      if (!Array.isArray(body.messages) || !body.messages.length ||
          body.messages.some(message => !message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string")) {
        json(res, 400, { error: "valid messages are required" }); return;
      }
      const granted = clampAccess(body, accessCeiling);
      body.access = granted.access;
      body.shell = granted.shell;
      if (body.cli === "ollama" && availability.ollama.ready) { activeRuns++; runOllama(body, res, req); return; }
      if (body.cli === "codex" && availability.codex.ready) { activeRuns++; runCodex(body, res, req); return; }
      if (body.cli === "claude" && availability.claude.ready) { activeRuns++; runClaude(body, res, req); return; }
      const status = availability[body.cli];
      const send = sse(res);
      send({ type: "error", message: status && status.error || (body.cli || "CLI") + " is not ready" });
      res.end();
    });
    return;
  }

  if (url.pathname.startsWith("/bridge/")) { json(res, 404, { error: "not found" }); return; }

  let requestPath;
  try { requestPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname); }
  catch (_) { res.writeHead(400); res.end("bad path"); return; }
  const file = path.resolve(ROOT, "." + requestPath);
  const relative = path.relative(ROOT, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "x-content-type-options": "nosniff",
    });
    res.end(data);
  });
});

function startBridge(port = DEFAULT_PORT, callback, errorCallback) {
  if (server.listening) {
    if (callback) callback(server.address().port);
    return server;
  }
  const onListening = () => {
    server.removeListener("error", onError);
    listenPort = server.address().port;
    console.log("ClaudeAmp bridge on http://localhost:" + listenPort + "/");
    for (const name of ["claude", "codex", "ollama"]) {
      const status = availability[name];
      console.log("  " + name.padEnd(6) + (name === "ollama" ? " local: " : " CLI: ") +
        (status.ready ? "ready" : status.error));
    }
    if (callback) callback(listenPort);
  };
  const onError = error => {
    server.removeListener("listening", onListening);
    if (errorCallback) { errorCallback(error); return; }
    // Standalone `node bridge.js` with the port taken must explain itself,
    // not die with an unhandled 'error' event.
    if (error && error.code === "EADDRINUSE") {
      console.error("Port " + port + " is already in use - another ClaudeAmp (or its desktop app)");
      console.error("is probably running. Stop it, or pass another port: node bridge.js 8020");
    } else {
      console.error("The bridge could not start: " + (error && error.message || error));
    }
    process.exit(1);
  };
  server.once("listening", onListening);
  server.once("error", onError);
  server.listen(port, "127.0.0.1");
  return server;
}

function stopBridge(callback) {
  if (!server.listening) { if (callback) callback(); return; }
  server.close(callback);
}

function setWorkspaceRoot(directory) {
  const resolved = path.resolve(String(directory || ""));
  if (!fs.statSync(resolved).isDirectory()) throw new Error("Workspace must be a folder");
  workspaceRoot = resolved;
  return workspaceRoot;
}

module.exports = {
  startBridge, stopBridge, server, refreshAvailability, availabilitySnapshot,
  setWorkspaceRoot, claudeCliArgs, clampAccess, setAccessCeiling, setEmbedded, getToken,
  claudeVersionSupported,
};

if (require.main === module) {
  const raw = process.argv[2];
  const requested = raw === undefined ? DEFAULT_PORT : Number(raw);
  startBridge(Number.isInteger(requested) && requested >= 0 ? requested : DEFAULT_PORT);
}
