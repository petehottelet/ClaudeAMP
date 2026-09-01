/* ClaudeAmp — AI providers: Claude, OpenAI, Gemini, local CLIs, and Ollama.
   Browser fetch + SSE streaming, a loopback desktop bridge, and a demo engine.
   Prices are public list prices per 1M tokens, used only for the estimate LCD. */
"use strict";

const ClaudeAPI = (() => {
  let bridgeToken = "";
  const PROVIDERS = {
    claude: {
      label: "CLAUDE", lamp: "CLA", keyPlaceholder: "sk-ant-...",
      models: [
        { id: "claude-fable-5",   name: "CLAUDE FABLE 5",   short: "FAB5", ctx: 1000000, inPrice: 10,   outPrice: 50 },
        { id: "claude-opus-5",    name: "CLAUDE OPUS 5",    short: "OPUS", ctx: 1000000, inPrice: 5,    outPrice: 25 },
        { id: "claude-sonnet-5",  name: "CLAUDE SONNET 5",  short: "SONN", ctx: 1000000, inPrice: 3,    outPrice: 15 },
        { id: "claude-haiku-4-5", name: "CLAUDE HAIKU 4.5", short: "HAIK", ctx: 200000,  inPrice: 1,    outPrice: 5 },
      ],
    },
    openai: {
      label: "OPENAI", lamp: "OAI", keyPlaceholder: "sk-...",
      models: [
        { id: "gpt-5.6-sol",   name: "GPT-5.6 SOL",   short: "SOL",  ctx: 1050000, inPrice: 5,   outPrice: 30 },
        { id: "gpt-5.6-terra", name: "GPT-5.6 TERRA", short: "TERR", ctx: 1050000, inPrice: 2,   outPrice: 12 },
        { id: "gpt-5.6-luna",  name: "GPT-5.6 LUNA",  short: "LUNA", ctx: 1050000, inPrice: 0.2, outPrice: 1.2 },
      ],
    },
    gemini: {
      label: "GEMINI", lamp: "GEM", keyPlaceholder: "AIza...",
      models: [
        { id: "gemini-3-pro-preview",  name: "GEMINI 3 PRO",   short: "3PRO", ctx: 1000000, inPrice: 2,    outPrice: 12 },
        { id: "gemini-2.5-pro",        name: "GEMINI 2.5 PRO", short: "25P",  ctx: 1000000, inPrice: 1.25, outPrice: 10 },
        { id: "gemini-2.5-flash",      name: "GEMINI 2.5 FLASH", short: "25F", ctx: 1000000, inPrice: 0.3, outPrice: 2.5 },
        { id: "gemini-2.5-flash-lite", name: "GEMINI 2.5 LITE",  short: "LITE", ctx: 1000000, inPrice: 0.1, outPrice: 0.4 },
      ],
    },
    // Subscription routes: replies come from your locally installed CLI via
    // bridge.js (node bridge.js), never from raw keys. Cost shows $0 because
    // usage bills to the subscription, not per token.
    "claude-cli": {
      label: "CLAUDE CODE", lamp: "CC", cli: "claude",
      models: [
        { id: "default", name: "CLAUDE CODE (YOUR DEFAULT)", short: "DFLT", ctx: 200000, inPrice: 0, outPrice: 0 },
        { id: "opus",    name: "CLAUDE CODE OPUS",   short: "OPUS", ctx: 200000, inPrice: 0, outPrice: 0 },
        { id: "sonnet",  name: "CLAUDE CODE SONNET", short: "SONN", ctx: 200000, inPrice: 0, outPrice: 0 },
        { id: "haiku",   name: "CLAUDE CODE HAIKU",  short: "HAIK", ctx: 200000, inPrice: 0, outPrice: 0 },
      ],
    },
    "codex-cli": {
      label: "CODEX CLI", lamp: "CDX", cli: "codex",
      models: [
        { id: "default",       name: "CODEX (YOUR DEFAULT)", short: "DFLT", ctx: 1050000, inPrice: 0, outPrice: 0 },
        { id: "gpt-5.6-sol",   name: "GPT-5.6 SOL",          short: "SOL",  ctx: 1050000, inPrice: 0, outPrice: 0 },
        { id: "gpt-5.6-terra", name: "GPT-5.6 TERRA",        short: "TERR", ctx: 1050000, inPrice: 0, outPrice: 0 },
        { id: "gpt-5.6-luna",  name: "GPT-5.6 LUNA",         short: "LUNA", ctx: 1050000, inPrice: 0, outPrice: 0 },
      ],
    },
    ollama: {
      label: "OLLAMA LOCAL", lamp: "OLL", local: "ollama",
      models: [
        { id: "", name: "NO LOCAL MODELS", short: "NONE", ctx: 131072, inPrice: 0, outPrice: 0 },
      ],
    },
  };
  const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
  const OPENAI_EFFORTS = ["low", "low", "medium", "high", "high"];

  function pct(v, lo, hi) { return lo + v * (hi - lo); }
  function level10(v) { return Math.round(v * 10); }
  function effortZone(v) { return Math.min(4, Math.floor(v * 5)); }
  function modelFor(s) {
    const p = PROVIDERS[s.provider] || PROVIDERS.claude;
    return p.models[Math.min(s.modelIndex, p.models.length - 1)];
  }

  /* Build the personality system prompt from the EQ + balance. */
  function buildSystem(s) {
    const lines = [
      "You are an AI assistant playing inside ClaudeAmp, a retro 90s " +
      "music-player-style interface. The chat renders plain monospaced green " +
      "text: reply in plain text only, no markdown syntax (no **, #, backticks " +
      "or tables) and no ASCII rules or dividers. Just answer conversationally.",
    ];
    const bal = s.balance; // 0 left(analytical) .. 1 right(creative)
    if (bal <= 0.25) lines.push("Balance is panned analytical: precise, structured, logical.");
    else if (bal >= 0.75) lines.push("Balance is panned creative: playful associations, vivid imagery.");
    const dial = (name, v, lo, hi) => {
      const n = level10(v);
      if (n <= 3) lines.push(`${name} ${n}/10: ${lo}`);
      else if (n >= 7) lines.push(`${name} ${n}/10: ${hi}`);
    };
    dial("Verbosity",  s.bands.VRB, "answer in as few words as possible.", "give thorough, expansive answers.");
    dial("Formality",  s.bands.FRM, "totally casual, like a friend on IRC.", "polished and professional.");
    return lines.join(" ");
  }

  function historySlice(s, history) {
    const keep = Math.max(1, Math.round(pct(s.bands.CTX, 1, 41)));
    const sliced = history.slice(-keep);
    // The Messages API needs the history to start with a user turn and to
    // strictly alternate roles; failed turns can also leave consecutive
    // user messages behind. Trim the head and merge same-role neighbors.
    while (sliced.length && sliced[0].role !== "user") sliced.shift();
    const out = [];
    for (const m of sliced) {
      const last = out[out.length - 1];
      if (last && last.role === m.role) {
        last.content += "\n\n" + m.content;
        if (m.images && m.images.length) last.images = (last.images || []).concat(m.images);
      } else {
        out.push({ role: m.role, content: m.content,
                   images: m.images && m.images.length ? m.images.slice() : undefined });
      }
    }
    return out;
  }

  // dataURL -> raw base64 payload
  function imgB64(im) {
    const s = String(im && im.dataUrl || "");
    const c = s.indexOf(",");
    return c >= 0 ? s.slice(c + 1) : s;
  }
  // Anthropic Messages content: string, or blocks when images are attached.
  function claudeContent(m) {
    if (!m.images || !m.images.length) return m.content;
    const blocks = [];
    if (m.content) blocks.push({ type: "text", text: m.content });
    for (const im of m.images)
      blocks.push({ type: "image", source: { type: "base64", media_type: im.mime || "image/png", data: imgB64(im) } });
    return blocks;
  }
  // OpenAI Responses input content: string, or typed parts when images attached.
  function openaiContent(m) {
    if (!m.images || !m.images.length) return m.content;
    const parts = [];
    if (m.content) parts.push({ type: "input_text", text: m.content });
    for (const im of m.images) parts.push({ type: "input_image", image_url: im.dataUrl });
    return parts;
  }
  // Gemini parts: text plus inline image data.
  function geminiParts(m) {
    const parts = [];
    if (m.content) parts.push({ text: m.content });
    if (m.images) for (const im of m.images)
      parts.push({ inlineData: { mimeType: im.mime || "image/png", data: imgB64(im) } });
    if (!parts.length) parts.push({ text: "" });
    return parts;
  }

  /* ---------------- Claude (Anthropic Messages API) ---------------- */
  function buildClaude(s, history) {
    const model = modelFor(s);
    const isHaiku = model.id === "claude-haiku-4-5";
    const effort = EFFORTS[effortZone(s.bands.EFF)];
    const maxTokens = Math.round(pct(Math.pow(s.bands.TOK, 1.5), 512, 16384));
    const body = {
      model: model.id,
      max_tokens: maxTokens,
      stream: true,
      system: buildSystem(s),
      messages: historySlice(s, history).map(m => ({ role: m.role, content: claudeContent(m) })),
    };
    const thk = s.bands.THK;
    if (isHaiku) {
      // Haiku 4.5 still uses budget_tokens; no effort parameter.
      if (thk >= 0.2) {
        const budget = Math.min(Math.round(pct(thk, 1024, 16000)), maxTokens - 1024);
        if (budget >= 1024) body.thinking = { type: "enabled", budget_tokens: budget };
      }
    } else {
      body.output_config = { effort };
      if (thk < 0.2) {
        // Low THK: no thinking where the model accepts it. Fable 5 never
        // accepts disabled; Opus 5 only at effort high or lower.
        const canDisable =
          model.id === "claude-sonnet-5" ||
          (model.id === "claude-opus-5" && ["low", "medium", "high"].includes(effort));
        if (canDisable) body.thinking = { type: "disabled" };
      } else if (thk >= 0.75) {
        body.thinking = { type: "adaptive", display: "summarized" };
      }
      // mid-range: omit -> adaptive default
    }
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": s.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body, maxTokens,
    };
  }

  /* ---------------- OpenAI (Responses API) ---------------- */
  function buildOpenAI(s, history) {
    const model = modelFor(s);
    const maxTokens = Math.round(pct(Math.pow(s.bands.TOK, 1.5), 512, 16384));
    const body = {
      model: model.id,
      stream: true,
      instructions: buildSystem(s),
      input: historySlice(s, history).map(m => ({ role: m.role, content: openaiContent(m) })),
      max_output_tokens: Math.max(1024, maxTokens),
      reasoning: { effort: OPENAI_EFFORTS[effortZone(s.bands.EFF)] },
    };
    return {
      url: "https://api.openai.com/v1/responses",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + s.apiKey,
      },
      body, maxTokens,
    };
  }

  /* ---------------- Gemini (Generative Language API) ---------------- */
  function buildGemini(s, history) {
    const model = modelFor(s);
    const maxTokens = Math.round(pct(Math.pow(s.bands.TOK, 1.5), 512, 16384));
    const body = {
      systemInstruction: { parts: [{ text: buildSystem(s) }] },
      contents: historySlice(s, history).map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: geminiParts(m),
      })),
      generationConfig: { maxOutputTokens: maxTokens },
    };
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:streamGenerateContent?alt=sse`,
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": s.apiKey,
      },
      body, maxTokens,
    };
  }

  /* ---------------- CLI bridge (bridge.js relaying to claude / codex) ---------------- */
  function buildBridge(s, history) {
    const model = modelFor(s);
    const maxTokens = Math.round(pct(Math.pow(s.bands.TOK, 1.5), 512, 16384));
    return {
      url: "/bridge/chat",
      headers: {
        "content-type": "application/json",
        "x-claudeamp-token": bridgeToken,
      },
      body: {
        cli: PROVIDERS[s.provider].cli || PROVIDERS[s.provider].local,
        model: model.id,
        system: buildSystem(s),
        messages: historySlice(s, history).map(m => ({
          role: m.role, content: m.content,
          images: m.images && m.images.length ? m.images : undefined,
        })),
        maxTokens,
        access: s.cliAccess === "workspace" ? "workspace" : "read-only",
        shell: s.cliAccess === "workspace" && s.cliShell === true,
        sessionId: s.cliSessionId || "",
        temperature: pct(s.balance, 0.1, 1.2),
        think: s.bands.THK >= 0.5,
      },
      maxTokens,
      bridge: true,
    };
  }

  function buildRequest(s, history) {
    if (s.provider === "openai") return buildOpenAI(s, history);
    if (s.provider === "gemini") return buildGemini(s, history);
    if (PROVIDERS[s.provider] && (PROVIDERS[s.provider].cli || PROVIDERS[s.provider].local))
      return buildBridge(s, history);
    return buildClaude(s, history);
  }

  /* ---------------- SSE streaming, one reader, three dialects ----------------
     Handlers: onStart(usage), onThinking(txt), onText(txt), onUsage(partial),
     onDone(info), onError(err). Returns AbortController. */
  function send(provider, req, h) {
    const ctrl = new AbortController();
    (async () => {
      let resp;
      try {
        resp = await fetch(req.url, {
          method: "POST",
          signal: ctrl.signal,
          headers: req.headers,
          body: JSON.stringify(req.body),
        });
      } catch (e) {
        if (e.name !== "AbortError") h.onError("Network error: " + e.message);
        else h.onDone({ aborted: true });
        return;
      }
      if (!resp.ok) {
        let msg = "HTTP " + resp.status;
        try {
          const j = await resp.json();
          const err = Array.isArray(j) ? j[0] && j[0].error : j.error;
          if (err && err.message) msg = err.message;
        } catch (_) {}
        h.onError(msg);
        return;
      }
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "", stopReason = null, usage = {}, started = false, chars = 0;
      const estUsage = () => { usage.output = Math.round(chars / 4); h.onUsage(usage); };
      const begin = inTok => {
        if (!started) { started = true; usage.input = inTok || 0; h.onStart(usage); }
      };
      const handle = ev => {
        if (req.bridge) {
          switch (ev.type) {
            case "text":
              begin(0); h.onText(ev.text || ""); chars += (ev.text || "").length; estUsage(); break;
            case "thinking":
              if (ev.text) h.onThinking(ev.text); break;
            case "status":
              if (ev.text && h.onStatus) h.onStatus(ev.text); break;
            case "session":
              if (ev.id && h.onSession) h.onSession(ev.id); break;
            case "done":
              if (ev.usage) {
                usage.input = ev.usage.input || usage.input;
                usage.output = ev.usage.output || usage.output;
                h.onUsage(usage);
              }
              stopReason = ev.stopReason || "end_turn";
              break;
            case "error":
              throw { api: ev.message || "bridge error" };
          }
        } else if (provider === "claude") {
          switch (ev.type) {
            case "message_start":
              begin(ev.message.usage ? ev.message.usage.input_tokens : 0); break;
            case "content_block_delta":
              if (ev.delta.type === "text_delta") h.onText(ev.delta.text);
              else if (ev.delta.type === "thinking_delta" && ev.delta.thinking)
                h.onThinking(ev.delta.thinking);
              break;
            case "message_delta":
              if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
              if (ev.usage) { usage.output = ev.usage.output_tokens; h.onUsage(usage); }
              break;
            case "error":
              throw { api: ev.error ? ev.error.message : "stream error" };
          }
        } else if (provider === "openai") {
          switch (ev.type) {
            case "response.created": begin(0); break;
            case "response.output_text.delta":
              begin(0); h.onText(ev.delta || ""); chars += (ev.delta || "").length; estUsage(); break;
            case "response.reasoning_summary_text.delta":
              if (ev.delta) h.onThinking(ev.delta); break;
            case "response.completed": {
              const r = ev.response || {};
              if (r.usage) {
                usage.input = r.usage.input_tokens || usage.input;
                usage.output = r.usage.output_tokens || usage.output;
                h.onUsage(usage);
              }
              stopReason = r.status === "incomplete" &&
                r.incomplete_details && r.incomplete_details.reason === "max_output_tokens"
                ? "max_tokens" : "end_turn";
              break;
            }
            case "response.incomplete": stopReason = "max_tokens"; break;
            case "response.failed":
              throw { api: (ev.response && ev.response.error && ev.response.error.message) || "response failed" };
            case "error":
              throw { api: ev.message || (ev.error && ev.error.message) || "stream error" };
          }
        } else { // gemini
          const cand = ev.candidates && ev.candidates[0];
          if (cand) {
            begin(0);
            const parts = (cand.content && cand.content.parts) || [];
            for (const p of parts) {
              if (!p.text) continue;
              if (p.thought) h.onThinking(p.text);
              else { h.onText(p.text); chars += p.text.length; }
            }
            estUsage();
            if (cand.finishReason === "MAX_TOKENS") stopReason = "max_tokens";
            else if (cand.finishReason === "SAFETY" || cand.finishReason === "PROHIBITED_CONTENT")
              stopReason = "refusal";
            else if (cand.finishReason === "STOP") stopReason = "end_turn";
          }
          if (ev.usageMetadata) {
            usage.input = ev.usageMetadata.promptTokenCount || usage.input;
            usage.output = (ev.usageMetadata.candidatesTokenCount || 0) +
                           (ev.usageMetadata.thoughtsTokenCount || 0) || usage.output;
            h.onUsage(usage);
          }
        }
      };
      // SSE frames end in a blank line, but the line terminator may be \n or
      // \r\n (Gemini streams CRLF), and the very last event of a stream may
      // arrive with no trailing blank line at all - so split on either
      // framing and drain whatever is left in the buffer after the reader
      // finishes (including the decoder's final flush).
      const handleFrame = part => {
        for (const line of part.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let ev;
          try { ev = JSON.parse(payload); } catch (_) { continue; }
          handle(ev);
        }
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split(/\r?\n\r?\n/);
          buf = parts.pop();
          for (const part of parts) handleFrame(part);
        }
        buf += dec.decode();
        if (buf.trim()) handleFrame(buf);
        h.onDone({ stopReason, usage });
      } catch (e) {
        if (e && e.api) h.onError(e.api);
        else if (e && e.name === "AbortError") h.onDone({ aborted: true, usage });
        else h.onError("Stream error: " + (e && e.message ? e.message : e));
      }
    })();
    return ctrl;
  }

  /* ------------------------- demo mode ------------------------- */
  const DEMO_OPENERS = [
    "Signal locked. ",
    "*tape hiss* ",
    "Now playing on channel AI: ",
    "Buffering vibes... done. ",
    "",
    "",
  ];
  const DEMO_BODIES = [
    "You're in DEMO MODE, so I'm a local tape loop, not a real model. Drop a " +
    "provider API key in Options (the O on the left edge, or right-click) and " +
    "the real thing takes the stage.",
    "This deck is running without an API key for the selected provider, so " +
    "consider me the in-store demo track. The EQ still works though - slide " +
    "MODEL to pick the model, EFF for effort, and WORDS for length.",
    "No key in the deck, so you get the bundled demo loop. Fun fact: the " +
    "balance knob pans between analytical and creative, and a real model " +
    "actually obeys it.",
    "I heard \"%Q\" - great track title. In demo mode I can only nod along in " +
    "green phosphor, but plug in an API key and a real model will riff on it " +
    "properly.",
    "Demo loop 7 of 7: \"%Q\" would make a solid album name. For an answer " +
    "with an actual model, feed the deck an API key via Options.",
  ];
  function demoReply(prompt, s) {
    const q = (prompt || "").slice(0, 48);
    return DEMO_OPENERS[Math.floor(Math.random() * DEMO_OPENERS.length)] +
      DEMO_BODIES[Math.floor(Math.random() * DEMO_BODIES.length)].replaceAll("%Q", q);
  }

  function setBridgeToken(value) { bridgeToken = String(value || ""); }

  function setOllamaModels(items) {
    // Keep the list short and stable: the 5 most-recently-modified local models.
    // A user can have dozens pulled, which turned the EQ MODEL slider into an
    // illegible, jittery pile as it was dragged - five recent ones is plenty.
    const sorted = (Array.isArray(items) ? items.slice() : [])
      .filter(item => String(item.id || item.name || "").trim())
      .sort((a, b) => String(b.modified || "").localeCompare(String(a.modified || "")))
      .slice(0, 5);
    const models = sorted.map(item => {
      const id = String(item.id || item.name || "").trim();
      const base = id.split(":")[0].replace(/[^a-z0-9]/gi, "").toUpperCase();
      return {
        id,
        name: String(item.name || id).toUpperCase().slice(0, 40),
        short: (base || "LOCAL").slice(0, 4),
        ctx: 131072,
        inPrice: 0,
        outPrice: 0,
      };
    });
    PROVIDERS.ollama.models = models.length ? models :
      [{ id: "", name: "NO LOCAL MODELS", short: "NONE", ctx: 131072, inPrice: 0, outPrice: 0 }];
  }

  return { PROVIDERS, EFFORTS, buildRequest, buildSystem, send, demoReply, modelFor,
    setBridgeToken, setOllamaModels };
})();
