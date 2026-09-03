/* ClaudeAmp — main application: state, canvas rendering, controls, chat, music. */
"use strict";

(() => {
  /* ================================ state ================================ */
  // Six bands, each with a real job (personality dials that overlapped the
  // balance knob, plus emoji/humor, were cut).
  const BANDS = ["EFF", "THK", "TOK", "CTX", "VRB", "FRM"];
  const BAND_LABELS = {
    EFF: "EFF", THK: "THINK", TOK: "TOKEN", CTX: "MEM",
    VRB: "WORDS", FRM: "FORM",
  };
  const BAND_TIPS = {
    EFF: "Effort: how hard the model works (API effort level)",
    THK: "Thinking: off / adaptive / show thinking summaries",
    TOK: "Tokens: max reply length",
    CTX: "Memory: how much history is sent with each message",
    VRB: "Words: terse vs expansive replies",
    FRM: "Formal: casual vs professional tone",
  };
  const FLAT_BANDS = { EFF: 0.6, THK: 0.5, TOK: 0.5, CTX: 1, VRB: 0.5,
                       FRM: 0.5 };

  const S = {
    volume: 0.7, balance: 0.5, modelIndex: 0,
    provider: "claude",
    keys: { claude: "", openai: "", gemini: "" },
    bands: Object.assign({}, FLAT_BANDS),
    eqOn: true, eqAuto: false, shuffle: false, repeat: false,
    zoom: 1.5, lcdMode: "time", visMode: 0, cliAccess: "read-only", cliShell: false, videoFilter: false,
    chatMode: "chat", // "chat" = AI chat window, "shell" = real terminal in its place
    // The visualization opens on the Smythe rain screensaver. Users can switch
    // to filtered/HD video or any other FX from the control below the window.
    fxOn: true, fxMode: 5,
    videoShownV1: true,     // one-time migration flag (see loadAll)
    rainDefaultV1: false,
    musicService: "itunes", // "itunes" previews, "youtube" embeds, or "spotify" remote control
    itunesDefaultV1: false,
    spotifyClientId: "",
  };

  let convos = [];          // {name, msgs:[{role,content}], turns:[{in,out,model,demo}]}
  let cur = 0;
  let chatBusy = false;     // a reply is streaming or still typing out
  let streamCtrl = null;
  let liveTurn = null;
  let genStart = 0, genElapsed = 0;
  let tps = 0, lastUsageT = 0, lastUsageOut = 0;
  let maxTokensReq = 4096;
  let tw = null, twThink = null;
  let seekDrag = null;      // 0..1 while user drags the seek bar
  let seekSettle = null;    // {target,until} — pin the thumb after release until playback catches up

  const $ = id => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } },
    raw(k) { try { return localStorage.getItem(k) || ""; } catch (_) { return ""; } },
    setRaw(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
  };

  /* ============================ persistence ============================ */
  /* API keys prefer the OS keychain (safeStorage over IPC) in the desktop
     app; localStorage remains the browser-dev fallback and the migration
     source. secureKeys flips once the keychain has adopted the keys. */
  let secureKeys = false;
  function persistKey(provider, value) {
    S.keys[provider] = value;
    if (secureKeys) {
      // Clear the plaintext copy only once the keychain write actually
      // succeeded; if it fails (no OS keyring), fall back to localStorage
      // so the key survives a restart instead of living only in memory.
      window.claudeAmpDesktop.setKey({ provider, value }).then(ok => {
        if (ok) { store.setRaw("claudeamp.key." + provider, ""); return; }
        secureKeys = false;
        store.setRaw("claudeamp.key." + provider, value);
      }).catch(() => { store.setRaw("claudeamp.key." + provider, value); });
    } else {
      store.setRaw("claudeamp.key." + provider, value);
    }
  }
  function syncAccessCeiling() {
    const desktop = window.claudeAmpDesktop;
    if (desktop && desktop.setAccess)
      desktop.setAccess({ access: S.cliAccess, shell: S.cliShell }).catch(() => {});
  }
  async function adoptSecureState() {
    const desktop = window.claudeAmpDesktop;
    if (!desktop) return;
    syncAccessCeiling();
    if (!desktop.getKeys) return;
    const secure = await desktop.getKeys().catch(() => null);
    if (!secure) return; // OS encryption unavailable - localStorage stays
    secureKeys = true;
    for (const p of ["claude", "openai", "gemini"]) {
      if (secure[p]) {
        S.keys[p] = secure[p];
        store.setRaw("claudeamp.key." + p, "");
      } else if (S.keys[p]) {
        // migrate the legacy plaintext copy in, then clear it
        const ok = await desktop.setKey({ provider: p, value: S.keys[p] }).catch(() => false);
        if (ok) store.setRaw("claudeamp.key." + p, "");
      }
    }
    drawEqFace(); drawInfo(); renderChat();
  }

  function saveSettings() {
    store.set("claudeamp.settings", {
      volume: S.volume, balance: S.balance, modelIndex: S.modelIndex,
      provider: S.provider, bands: S.bands, eqOn: S.eqOn, eqAuto: S.eqAuto,
      shuffle: S.shuffle, repeat: S.repeat,
      zoom: S.zoom, zoomV4: true, zoomV5: true, lcdMode: S.lcdMode, visMode: S.visMode,
      cliAccess: S.cliAccess, cliShell: S.cliShell, videoFilter: S.videoFilter, chatMode: S.chatMode,
      fxOn: S.fxOn, fxMode: S.fxMode, videoShownV1: S.videoShownV1,
      rainDefaultV1: S.rainDefaultV1,
      musicService: S.musicService, itunesDefaultV1: S.itunesDefaultV1,
      spotifyClientId: S.spotifyClientId,
    });
  }
  let convoSaveWarned = false;
  function saveConvos() {
    if (store.set("claudeamp.convos", { convos, cur })) { convoSaveWarned = false; return; }
    // A silent quota failure here means chat history quietly stops
    // persisting - say so once, with the likely cause and the way out.
    if (!convoSaveWarned) {
      convoSaveWarned = true;
      try {
        msgDiv("system", null, "[STORAGE FULL - THIS CHAT CAN'T BE SAVED. " +
          "ATTACHED IMAGES TAKE THE MOST ROOM: /CLEAR THIS CHAT OR REMOVE OLD IMAGE TURNS.]");
      } catch (_) { /* called before the chat log exists; the next save retries */ }
    }
  }
  function loadAll() {
    const s = store.get("claudeamp.settings", null);
    if (s) Object.assign(S, s, { bands: Object.assign({}, S.bands, s.bands) });
    // A clean profile opens at 1.5x. Existing profiles retain their saved zoom.
    if (!s) S.zoom = 1.5;
    if (!s || !s.zoomV5) S.zoomV5 = true;
    if (![1, 1.5, 2, 2.5, 3].includes(S.zoom)) S.zoom = S.zoom > 3 ? 2 : 1; // new zoom range
    if (!ClaudeAPI.PROVIDERS[S.provider]) S.provider = "claude";
    S.cliShell = S.cliShell === true; // shell stays opt-in for old profiles too
    if (S.chatMode !== "shell") S.chatMode = "chat";
    if (!["itunes", "spotify", "youtube"].includes(S.musicService)) S.musicService = "itunes";
    // Establish iTunes previews as the built-in default once. Preserve an
    // explicitly connected Spotify choice; old YouTube defaults migrate.
    if (!s || !s.itunesDefaultV1) {
      if (S.musicService !== "spotify") S.musicService = "itunes";
      S.itunesDefaultV1 = true;
    }
    S.spotifyClientId = typeof S.spotifyClientId === "string" ? S.spotifyClientId : "";
    S.fxOn = !!S.fxOn;
    S.fxMode = Math.min(5, Math.max(0, S.fxMode | 0));
    // One-time flip to the visible YouTube player: existing installs that were
    // defaulting to the rain FX (which covered the video) get switched to the
    // visible HD video once. After that the user's own FX/video choice sticks.
    if (!s || !s.videoShownV1) { S.fxOn = false; S.videoFilter = false; S.videoShownV1 = true; }
    // One release migration establishes Rain as the visualization default,
    // then leaves every later user choice alone.
    if (!s || !s.rainDefaultV1) { S.fxOn = true; S.fxMode = 5; S.rainDefaultV1 = true; }
    S.keys.claude = store.raw("claudeamp.key.claude") || store.raw("claudeamp.apikey");
    S.keys.openai = store.raw("claudeamp.key.openai");
    S.keys.gemini = store.raw("claudeamp.key.gemini");
    const c = store.get("claudeamp.convos", null);
    if (c && Array.isArray(c.convos) && c.convos.length) {
      convos = c.convos; cur = Math.min(c.cur || 0, convos.length - 1);
      convos.forEach(item => { if (!item.sessions) item.sessions = {}; });
    } else {
      convos = [{ name: "Untitled Jam", msgs: [], turns: [], sessions: {} }];
      cur = 0;
    }
  }

  const convo = () => convos[cur];
  const provider = () => ClaudeAPI.PROVIDERS[S.provider];
  const model = () => ClaudeAPI.modelFor(S);
  const apiKey = () => S.keys[S.provider] || "";
  const bridgeStatus = {
    claude: { ready: false, error: "bridge not checked" },
    codex: { ready: false, error: "bridge not checked" },
    ollama: { ready: false, models: [], error: "Ollama not checked" },
    token: "",
  };
  const isCli = () => !!provider().cli;
  const isLocal = () => !!provider().local;
  const demoMode = () => {
    if (isCli()) return !bridgeStatus[provider().cli].ready;
    if (isLocal()) return !bridgeStatus[provider().local].ready || !model().id;
    return !apiKey();
  };

  async function refreshBridgeStatus(force) {
    try {
      const response = await fetch("/bridge/status" + (force ? "?refresh=1" : ""), { cache: "no-store" });
      if (!response.ok) throw new Error("local bridge returned " + response.status);
      const value = await response.json();
      for (const name of ["claude", "codex", "ollama"]) {
        const state = value[name];
        bridgeStatus[name] = typeof state === "boolean" ?
          { installed: state, ready: state, version: "", models: [], error: state ? "" : name + " not found" } :
          Object.assign({ installed: false, ready: false, version: "", models: [], error: name + " not ready" }, state || {});
      }
      // Keep the whole app (slider AND the settings/wizard dropdown) on the same
      // 5 most-recently-modified local models, so model indices never disagree.
      if (Array.isArray(bridgeStatus.ollama.models)) {
        bridgeStatus.ollama.models = bridgeStatus.ollama.models.slice()
          .sort((a, b) => String(b.modified || "").localeCompare(String(a.modified || "")))
          .slice(0, 5);
      }
      ClaudeAPI.setOllamaModels(bridgeStatus.ollama.models);
      // Desktop mode: the status payload deliberately omits the token; it
      // arrives over IPC instead (and only ever to this window).
      if (value.token) bridgeStatus.token = value.token;
      else if (!bridgeStatus.token && window.claudeAmpDesktop && window.claudeAmpDesktop.bridgeToken)
        bridgeStatus.token = (await window.claudeAmpDesktop.bridgeToken().catch(() => "")) || "";
      bridgeStatus.workspace = value.workspace || "";
      ClaudeAPI.setBridgeToken(bridgeStatus.token);
      MusicService.setToken(bridgeStatus.token);
      Music.hydrateAppleTracks();
      syncMusicService();
      renderChat();
      return true;
    } catch (_) {
      bridgeStatus.claude = { ready: false, error: "start ClaudeAmp through the desktop app or node bridge.js" };
      bridgeStatus.codex = { ready: false, error: "start ClaudeAmp through the desktop app or node bridge.js" };
      bridgeStatus.ollama = { ready: false, models: [], error: "start ClaudeAmp and Ollama to use local models" };
      ClaudeAPI.setOllamaModels([]);
      return false;
    }
  }
  refreshBridgeStatus(false);

  function convoTokens(c) {
    return (c.turns || []).reduce((a, t) => a + (t.in || 0) + (t.out || 0), 0);
  }
  function fmtTok(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1000) return Math.round(n / 1000) + "K";
    return String(n);
  }
  function fmtNum(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
  }

  /* ========================= canvas: time LCD ========================= */
  const cvTime = $("cv-time").getContext("2d");
  function drawTime() {
    cvTime.clearRect(0, 0, 66, 13); // transparent: panel dot-matrix shows through
    const musicActive = ["playing", "paused", "loading"].includes(Music.mode);
    const blinkOff = Music.mode === "paused" && (performance.now() % 1000) < 500;
    if (blinkOff) return;
    const GREEN = "#00E800", GHOST = "#0A2E0A";
    if (S.lcdMode === "tokens") {
      const tot = convos.reduce((a, c) => a + convoTokens(c), 0) + (liveTurn ? (liveTurn.out || 0) : 0);
      let str, suffix = "";
      if (tot >= 1e7) { str = String(Math.round(tot / 1e6)); suffix = "M"; }
      else if (tot >= 1e4) { str = String(Math.round(tot / 1e3)); suffix = "K"; }
      else str = String(tot);
      str = str.padStart(4, " ");
      const xs = [8, 20, 36, 48];
      for (let i = 0; i < 4; i++) PixelFont.drawDigit(cvTime, str[i], xs[i], 0, GREEN, GHOST);
      if (suffix) PixelFont.drawText(cvTime, suffix, 60, 7, GREEN);
      return;
    }
    const sec = musicActive ? Music.time().t : genElapsed;
    const s = Math.floor(sec);
    const mm = String(Math.min(99, Math.floor(s / 60))).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    PixelFont.drawDigit(cvTime, mm[0], 8, 0, GREEN, GHOST);
    PixelFont.drawDigit(cvTime, mm[1], 20, 0, GREEN, GHOST);
    cvTime.fillStyle = GREEN;
    cvTime.fillRect(31, 3, 1, 1); cvTime.fillRect(31, 9, 1, 1);
    PixelFont.drawDigit(cvTime, ss[0], 36, 0, GREEN, GHOST);
    PixelFont.drawDigit(cvTime, ss[1], 48, 0, GREEN, GHOST);
  }

  /* ========================= canvas: ticker ========================= */
  const cvTicker = $("cv-ticker").getContext("2d");
  let tickerX = 0, tickerText = "", lastTickerStep = 0;
  let updateNotice = ""; // set by the desktop shell's passive release check
  function tickerString() {
    if (chatBusy) {
      const c = convo();
      return `${model().name} - ${(c.name || "JAM").toUpperCase()}  ***  ` + updateNotice;
    }
    const t = Music.tracks[Music.idx];
    if (t) {
      const d = Music.time().d || t.dur;
      return `${Music.idx + 1}. ${t.title.toUpperCase()} (${fmtTime(d)})  ***  ` + updateNotice;
    }
    return "PLAYLIST EMPTY - ADD MP3 / WAV / FLAC FILES  ***  " + updateNotice;
  }
  function drawTicker(now) {
    const txt = tickerString();
    if (txt !== tickerText) { tickerText = txt; tickerX = 0; }
    if (now - lastTickerStep > 60) {
      tickerX = (tickerX + 1) % (PixelFont.textWidth(tickerText) + PixelFont.ADV);
      lastTickerStep = now;
    }
    cvTicker.fillStyle = "#000";
    cvTicker.fillRect(0, 0, 147, 6);
    const w = PixelFont.textWidth(tickerText) + PixelFont.ADV;
    PixelFont.drawText(cvTicker, tickerText, -tickerX, 0, "#00E800");
    PixelFont.drawText(cvTicker, tickerText, w - tickerX, 0, "#00E800");
  }

  /* ========================= canvas: info row ========================= */
  const cvInfo = $("cv-info").getContext("2d");
  function drawInfo() {
    cvInfo.clearRect(0, 0, 158, 12);
    const GREEN = "#00E800", INACTIVE = "#858698", WHITE = "#D8D8E6";
    // black inset slots, beveled like the other displays, with breathing
    // room above and below the digits
    const slot = (x, w) => {
      cvInfo.fillStyle = "#16182A";                       // bevel-lo: top + left
      cvInfo.fillRect(x, 0, w, 1); cvInfo.fillRect(x, 0, 1, 12);
      cvInfo.fillStyle = "#63658E";                       // bevel-hi: bottom + right
      cvInfo.fillRect(x, 11, w, 1); cvInfo.fillRect(x + w - 1, 0, 1, 12);
      cvInfo.fillStyle = "#000";
      cvInfo.fillRect(x + 1, 1, w - 2, 10);
    };
    slot(0, 20); slot(44, 27);
    PixelFont.drawText(cvInfo, String(Math.round(tps)).padStart(3, " "), 1, 3, GREEN);
    PixelFont.drawText(cvInfo, "TPS", 23, 3, WHITE);
    const used = contextUsed();
    PixelFont.drawText(cvInfo, String(Math.round(used / 1000)).padStart(4, " "), 46, 3, GREEN);
    PixelFont.drawText(cvInfo, "KCTX", 74, 3, WHITE);
    // One channel label at a time, centered in the space right of KCTX.
    // The player is always stereo today; mono would render dim if it ever
    // becomes a real state. The lit label breathes like the button lamps,
    // a bit more prominently: a stepped green halo under a brightening core.
    const chan = "stereo";
    const chanX = 97 + Math.round((158 - 97 - PixelFont.textWidth(chan)) / 2);
    if (chan === "stereo") {
      const ph = Math.floor(performance.now() / 300) % 4;
      const halo = ["#003C00", "#006200", "#008A00", "#006200"][ph];
      const core = ["#00C000", "#00E800", "#8CFF8C", "#00E800"][ph];
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]])
        PixelFont.drawText(cvInfo, chan, chanX + dx, 3 + dy, halo);
      PixelFont.drawText(cvInfo, chan, chanX, 3, core);
    } else {
      PixelFont.drawText(cvInfo, chan, chanX, 3, INACTIVE);
    }
  }
  function contextUsed() {
    // The latest turn's input already contains the resent history, so the
    // context estimate is just the most recent turn, not a sum of all turns.
    const c = convo();
    const t = liveTurn || c.turns[c.turns.length - 1];
    return t ? (t.in || 0) + (t.out || 0) : 0;
  }

  /* ===================== canvas: main visualizer ===================== */
  // classic-style visualization palette: red top -> orange -> yellow -> green
  const VISCOLORS = [
    [239,49,16],[206,41,16],[214,90,0],[214,102,0],[214,115,0],[198,123,8],
    [222,165,24],[214,181,33],[189,222,41],[148,222,33],[41,206,16],[50,190,16],
    [57,181,16],[49,156,8],[41,148,0],[24,132,8],
  ];
  const cvVis = $("cv-vis").getContext("2d");
  const bars = new Float32Array(19), peaks = new Float32Array(19), peakVel = new Float32Array(19);
  const oscBuf = new Float32Array(76);
  function pumpVis(energy) {
    for (let i = 0; i < 19; i++) {
      const shape = 1 - Math.abs(i - 7) / 14;
      if (Math.random() < 0.55) {
        bars[i] = Math.max(bars[i], Math.random() * energy * 16 * (0.4 + shape));
      }
    }
  }
  function drawVis() {
    cvVis.fillStyle = "#000";
    cvVis.fillRect(0, 0, 76, 16);
    // dot grid continuous with the display panel's matrix (3px pitch,
    // phase-aligned to the panel dots behind this canvas)
    cvVis.fillStyle = "#123016";
    for (let y = 2; y < 16; y += 3)
      for (let x = 1; x < 76; x += 3) cvVis.fillRect(x, y, 1, 1);
    if (S.visMode === 2) return;
    const musicOn = Music.mode === "playing";
    if (musicOn) pumpVis(0.75 + 0.25 * Math.abs(Math.sin(performance.now() / 441)));
    if (S.visMode === 0) {
      for (let i = 0; i < 19; i++) {
        bars[i] *= 0.86;
        const h = Math.min(16, Math.round(bars[i]));
        for (let r = 0; r < h; r++) {
          const y = 15 - r;
          const c = VISCOLORS[15 - Math.min(15, r)];
          cvVis.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
          cvVis.fillRect(i * 4, y, 3, 1);
        }
        if (h >= peaks[i]) { peaks[i] = h; peakVel[i] = 0; }
        else { peakVel[i] += 0.05; peaks[i] = Math.max(h, peaks[i] - peakVel[i]); }
        if (peaks[i] > 0.5) {
          cvVis.fillStyle = "rgb(150,150,150)";
          cvVis.fillRect(i * 4, 15 - Math.round(peaks[i]), 3, 1);
        }
      }
    } else {
      const active = musicOn ? 1 : chatBusy ? Math.min(1, tps / 40 + 0.2) : 0.05;
      for (let i = 0; i < 75; i++) oscBuf[i] = oscBuf[i + 1];
      oscBuf[75] = (Math.random() * 2 - 1) * active *
        (0.4 + 0.6 * Math.abs(Math.sin(performance.now() / 120)));
      cvVis.fillStyle = "rgb(148,222,33)";
      for (let x = 0; x < 76; x++) {
        const y = Math.round(8 + oscBuf[x] * 7);
        cvVis.fillRect(x, Math.max(0, Math.min(15, y)), 1, 1);
      }
    }
  }

  /* ======================= canvas: EQ face + graph ======================= */
  const eqFace = $("cv-eqface").getContext("2d");
  const eqGraph = $("cv-eqgraph").getContext("2d");
  const SL_TOP = 28, SL_TRAVEL = 46;
  const PRE_X = 21, BAND_X0 = 76, BAND_DX = 34;
  const EQ_FACE_H = 108;

  function sliderCols() {
    const cols = [{ key: "MODEL", x: PRE_X }];
    BANDS.forEach((b, i) => cols.push({ key: b, x: BAND_X0 + i * BAND_DX }));
    return cols;
  }
  function sliderValue(key) {
    if (key === "MODEL") {
      const lastModel = Math.max(1, provider().models.length - 1);
      return 1 - Math.min(S.modelIndex, lastModel) / lastModel;
    }
    return S.bands[key];
  }
  // AUTO latches until the user shapes the EQ by hand again.
  let eqAutoHold = false;
  function releaseEqAuto() {
    if (!S.eqAuto || eqAutoHold) return;
    S.eqAuto = false;
    const button = $("eq-auto");
    if (button) button.classList.remove("lit");
  }
  // The MODEL slider is inert when there's nothing to choose between (e.g. a
  // single local Ollama model, or none): dragging it would just jitter labels.
  const modelSliderLocked = () => provider().models.length <= 1;
  function setSliderValue(key, v) {
    v = Math.max(0, Math.min(1, v));
    if (key === "MODEL") {
      if (modelSliderLocked()) return;
      S.modelIndex = Math.round((1 - v) * Math.max(1, provider().models.length - 1));
    } else { S.bands[key] = v; releaseEqAuto(); }
    positionEqThumbs(); drawEqFace(); drawEqGraph(); saveSettings();
  }
  function drawEqFace() {
    eqFace.clearRect(0, 0, 275, EQ_FACE_H);
    const cols = sliderCols();
    for (let ci = 0; ci < cols.length; ci++) {
      const col = cols[ci];
      const v = sliderValue(col.key);
      // Classic track with one-pixel cut corners: rounded without soft edges.
      const hue = 100 - v * 100;
      const bx = col.x + 5;
      const barH = SL_TRAVEL + 11;
      eqFace.fillStyle = "#101018";
      eqFace.fillRect(bx, SL_TOP - 1, 4, 1);
      eqFace.fillRect(bx - 1, SL_TOP, 6, barH);
      eqFace.fillRect(bx, SL_TOP + barH, 4, 1);
      eqFace.fillStyle = `hsl(${hue},60%,32%)`;
      eqFace.fillRect(bx + 1, SL_TOP, 2, 1);
      eqFace.fillRect(bx, SL_TOP + 1, 1, barH - 2);
      eqFace.fillRect(bx + 3, SL_TOP + 1, 1, barH - 2);
      eqFace.fillRect(bx + 1, SL_TOP + barH - 1, 2, 1);
      eqFace.fillStyle = `hsl(${hue},80%,55%)`;
      eqFace.fillRect(bx + 1, SL_TOP + 1, 2, barH - 2);
      // flanking tick dashes at max / center / min, like the +12/0/-12 marks
      eqFace.fillStyle = "#8E90A8";
      for (const ty of [SL_TOP + 5, SL_TOP + 5 + Math.round(SL_TRAVEL / 2), SL_TOP + 5 + SL_TRAVEL]) {
        eqFace.fillRect(col.x - 2, ty, 3, 1);
        eqFace.fillRect(col.x + 13, ty, 3, 1);
      }
      // All EQ copy uses the same PixelFont/AmpDot glyph set as the rest of the skin.
      if (col.key !== "MODEL") {
        const label = BAND_LABELS[col.key] || col.key;
        const lw = PixelFont.textWidth(label);
        PixelFont.drawText(eqFace, label,
          Math.max(0, col.x + 7 - Math.floor(lw / 2)), 92, "#C6C8DC");
      }
    }
    // Model labels along the slider. With many models (Ollama can list dozens)
    // drawing every name stacks them into an illegible pile, so we thin the dim
    // labels to a minimum vertical gap and always draw the selected one on top.
    const models = provider().models;
    const sel = Math.min(S.modelIndex, models.length - 1);
    const yOf = i => Math.round(SL_TOP + (i / Math.max(1, models.length - 1)) * SL_TRAVEL + 3);
    const MINGAP = 8, selY = yOf(sel);
    let lastY = -Infinity;
    models.forEach((m, i) => {
      if (i === sel) return;                        // drawn last, on top
      const y = yOf(i);
      if (y - lastY < MINGAP) return;               // keep dim labels spaced
      if (Math.abs(y - selY) < MINGAP) return;      // don't crowd the selection
      PixelFont.drawText(eqFace, m.short, 40, y, "#5A5A72");
      lastY = y;
    });
    if (models[sel]) PixelFont.drawText(eqFace, models[sel].short, 40, selY, "#00E800");
    PixelFont.drawText(eqFace, "MODEL", 14, 92, "#C6C8DC");
  }
  function drawEqGraph() {
    eqGraph.fillStyle = "#000";
    eqGraph.fillRect(0, 0, 113, 19);
    eqGraph.fillStyle = "#3E3E52";
    for (let x = 6; x < 113; x += 12) eqGraph.fillRect(x, 0, 1, 19);
    eqGraph.fillStyle = "#26263A";
    eqGraph.fillRect(0, 9, 113, 1);
    for (let x = 0; x < 113; x++) {
      const t = x / 112 * (BANDS.length - 1);
      const i = Math.min(BANDS.length - 2, Math.floor(t));
      const f = t - i;
      const v = S.bands[BANDS[i]] * (1 - f) + S.bands[BANDS[i + 1]] * f;
      const y = Math.round(1 + (1 - v) * 16);
      const c = VISCOLORS[Math.max(0, Math.min(15, Math.round(y * 15 / 18)))];
      eqGraph.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      eqGraph.fillRect(x, y, 1, 2);
    }
  }

  /* EQ thumbs (HTML) + pointer handling */
  const eqBody = document.querySelector(".eq-body");
  const eqThumbs = {};
  function buildEqThumbs() {
    for (const col of sliderCols()) {
      const t = document.createElement("div");
      t.className = "eq-thumb";
      t.title = col.key === "MODEL" ? "Model (per provider)" : (BAND_TIPS[col.key] || col.key);
      t.style.left = (col.x + 1) + "px";
      eqBody.appendChild(t);
      eqThumbs[col.key] = t;
    }
    positionEqThumbs();

    let dragKey = null;
    const pickCol = e => {
      const r = eqBody.getBoundingClientRect();
      const z = WM.zoomFactor();
      const x = (e.clientX - r.left) / z, y = (e.clientY - r.top) / z;
      if (y < SL_TOP || y > SL_TOP + SL_TRAVEL + 17) return null;
      for (const col of sliderCols())
        if (x >= col.x - 2 && x <= col.x + 16) return col.key;
      return null;
    };
    const applyY = (key, e) => {
      const r = eqBody.getBoundingClientRect();
      const z = WM.zoomFactor();
      const y = (e.clientY - r.top) / z - SL_TOP - 5;
      let v = 1 - y / SL_TRAVEL;
      if (key === "MODEL") v = 1 - Math.round((1 - Math.max(0, Math.min(1, v))) * 3) / 3;
      setSliderValue(key, v);
    };
    eqBody.addEventListener("pointerdown", e => {
      if (e.target.closest(".winbtn")) return;
      dragKey = e.target.classList.contains("eq-thumb")
        ? Object.keys(eqThumbs).find(k => eqThumbs[k] === e.target)
        : pickCol(e);
      if (!dragKey) return;
      eqBody.setPointerCapture(e.pointerId);
      applyY(dragKey, e);
      e.preventDefault();
    });
    eqBody.addEventListener("pointermove", e => { if (dragKey) applyY(dragKey, e); });
    const up = () => { dragKey = null; };
    eqBody.addEventListener("pointerup", up);
    eqBody.addEventListener("pointercancel", up);

    // Keyboard access for the model/EQ sliders (they are canvas hit-tests,
    // invisible to assistive tech otherwise): Left/Right choose a column,
    // Up/Down adjust it, and a polite live region narrates the change.
    eqBody.tabIndex = 0;
    eqBody.setAttribute("role", "group");
    eqBody.setAttribute("aria-label",
      "Model tuner. Left and Right choose a slider, Up and Down adjust it.");
    const eqLive = document.createElement("div");
    eqLive.className = "sr-only";
    eqLive.setAttribute("aria-live", "polite");
    eqBody.appendChild(eqLive);
    let keyCol = 0;
    eqBody.addEventListener("keydown", e => {
      const cols = sliderCols();
      if (!cols.length) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        keyCol = (keyCol + (e.key === "ArrowRight" ? 1 : -1) + cols.length) % cols.length;
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const col = cols[keyCol];
        const step = col.key === "MODEL" ? 1 / 3 : 0.05;
        setSliderValue(col.key,
          Math.max(0, Math.min(1, sliderValue(col.key) + (e.key === "ArrowUp" ? step : -step))));
      } else return;
      const col = cols[keyCol];
      const label = col.key === "MODEL" ? "MODEL" : (BAND_LABELS[col.key] || col.key);
      eqLive.textContent = label + " " + Math.round(sliderValue(col.key) * 100) + "%";
      e.preventDefault();
    });
  }
  function positionEqThumbs() {
    for (const col of sliderCols()) {
      const v = sliderValue(col.key);
      eqThumbs[col.key].style.top = Math.round(SL_TOP + (1 - v) * SL_TRAVEL) + "px";
    }
    if (eqThumbs.MODEL) eqThumbs.MODEL.classList.toggle("locked", modelSliderLocked());
  }

  /* ==================== horizontal sliders (vol/bal) ==================== */
  function attachHSlider(el, getV, setV, colorFn) {
    const thumb = el.querySelector(".hslider-thumb");
    const track = () => el.clientWidth - thumb.offsetWidth;
    // Pointer-only sliders lock out keyboard and screen-reader users: give
    // each the ARIA slider contract and arrow-key control (5% steps).
    el.tabIndex = 0;
    el.setAttribute("role", "slider");
    if (!el.getAttribute("aria-label")) el.setAttribute("aria-label", el.title || "slider");
    el.setAttribute("aria-valuemin", "0");
    el.setAttribute("aria-valuemax", "100");
    const render = () => {
      thumb.style.left = Math.round(getV() * track()) + "px";
      el.setAttribute("aria-valuenow", String(Math.round(getV() * 100)));
      if (colorFn) el.style.setProperty("--groove-color", colorFn(getV()));
    };
    el.addEventListener("keydown", e => {
      const step = { ArrowLeft: -0.05, ArrowDown: -0.05, ArrowRight: 0.05, ArrowUp: 0.05 }[e.key];
      const jump = { Home: 0, End: 1 }[e.key];
      if (step === undefined && jump === undefined) return;
      setV(jump !== undefined ? jump : Math.max(0, Math.min(1, getV() + step)));
      render(); saveSettings(); e.preventDefault();
    });
    let dragging = false;
    const apply = e => {
      const r = el.getBoundingClientRect();
      const z = WM.zoomFactor();
      const x = (e.clientX - r.left) / z - thumb.offsetWidth / 2;
      setV(Math.max(0, Math.min(1, x / track())));
      render();
    };
    el.addEventListener("pointerdown", e => {
      dragging = true; el.setPointerCapture(e.pointerId); apply(e); e.preventDefault();
    });
    el.addEventListener("pointermove", e => { if (dragging) apply(e); });
    const up = () => { dragging = false; saveSettings(); };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    render();
    return { render };
  }

  /* ======================== canvas: usage monitor ======================== */
  const cvUsage = $("cv-usage").getContext("2d");
  const cvUseText = $("cv-usetext").getContext("2d");
  function usageColor(rowFromBottom, H) {
    const frac = rowFromBottom / H;
    const idx = 15 - Math.max(0, Math.min(15, Math.floor(frac * 16)));
    const c = VISCOLORS[idx];
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  function drawUsage() {
    const W = 251, H = 58;
    cvUsage.fillStyle = "#000";
    cvUsage.fillRect(0, 0, W, H);
    cvUsage.fillStyle = "#0A2208";
    for (let y = H - 1; y > 0; y -= 8) cvUsage.fillRect(0, y, W, 1);

    const turns = convo().turns.slice();
    if (liveTurn) turns.push(liveTurn);
    const per = 8;
    const maxBars = Math.floor(W / per);
    const shown = turns.slice(-maxBars);
    const hFor = n => Math.round(Math.min(1, Math.log10((n || 0) + 1) / Math.log10(30000)) * (H - 2));
    shown.forEach((t, i) => {
      const x = 2 + i * per;
      const hi = hFor(t.in), ho = hFor(t.out);
      cvUsage.fillStyle = "#166A0C";
      if (hi > 0) cvUsage.fillRect(x, H - hi, 2, hi);
      for (let r = 0; r < ho; r++) {
        cvUsage.fillStyle = usageColor(r, H);
        cvUsage.fillRect(x + 3, H - 1 - r, 4, 1);
      }
      const live = liveTurn && i === shown.length - 1;
      cvUsage.fillStyle = live && (performance.now() % 300) < 150
        ? "#FFFFFF" : "rgb(150,150,150)";
      if (ho > 0) cvUsage.fillRect(x + 3, H - 1 - ho, 4, 1);
    });
    if (!shown.length) {
      PixelFont.drawText(cvUsage, "TOKENS PER TURN", 78, 26, "#0E5E0E");
    }
  }
  function sessionUsage() {
    let inT = 0, outT = 0, cost = 0;
    const allModels = Object.values(ClaudeAPI.PROVIDERS).flatMap(p => p.models);
    for (const c of convos) for (const t of (c.turns || [])) {
      inT += t.in || 0; outT += t.out || 0;
      const m = allModels.find(x => x.id === t.model) || model();
      // demo turns are free; subscription (CLI) turns bill to the plan, not per token
      if (!t.demo && !t.sub)
        cost += (t.in || 0) / 1e6 * m.inPrice + (t.out || 0) / 1e6 * m.outPrice;
    }
    if (liveTurn) { inT += liveTurn.in || 0; outT += liveTurn.out || 0; }
    return { inT, outT, cost };
  }
  function drawUsageText() {
    cvUseText.fillStyle = "#000";
    cvUseText.fillRect(0, 0, 251, 24);
    const { inT, outT, cost } = sessionUsage();
    const GREEN = "#00E800", GRAY = "#8A8AA0";
    PixelFont.drawText(cvUseText, "IN", 2, 2, GRAY);
    PixelFont.drawText(cvUseText, fmtNum(inT).padStart(8, " "), 16, 2, GREEN);
    PixelFont.drawText(cvUseText, "OUT", 78, 2, GRAY);
    PixelFont.drawText(cvUseText, fmtNum(outT).padStart(8, " "), 98, 2, GREEN);
    // Bottom-right text block is flush right: model name against the right
    // edge, percent beside it, the $ amount right-aligned above them, and
    // the CTX meter stretches to fill whatever is left.
    const RIGHT = 249;
    const pct = Math.min(1, contextUsed() / model().ctx);
    const pctTxt = pct < 0.001 && contextUsed() > 0 ? "<1%" : Math.round(pct * 100) + "%";
    const shortX = RIGHT - PixelFont.textWidth(model().short);
    const pctX = shortX - 5 - PixelFont.textWidth(pctTxt);
    const costTxt = demoMode() ? "$0.00" : "$" + cost.toFixed(3);
    PixelFont.drawText(cvUseText, costTxt, RIGHT - PixelFont.textWidth(costTxt), 2,
      demoMode() ? GRAY : "#DEA518");
    PixelFont.drawText(cvUseText, "CTX", 2, 14, GRAY);
    const mx = 24, mw = pctX - 6 - mx;
    cvUseText.fillStyle = "#0C240C";
    cvUseText.fillRect(mx, 13, mw, 7);
    const fill = Math.round(pct * mw);
    for (let x = 0; x < fill; x++) {
      const c = VISCOLORS[15 - Math.min(15, Math.floor(x / mw * 16))];
      cvUseText.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      cvUseText.fillRect(mx + x, 13, 1, 7);
    }
    PixelFont.drawText(cvUseText, pctTxt, pctX, 14, GREEN);
    PixelFont.drawText(cvUseText, model().short, shortX, 14, GRAY);
  }

  /* ============================== playlist (music) ============================== */
  const plList = $("pl-list");
  const selected = new Set();
  let selectAnchor = -1;
  let savedSelected = "";
  let playlistNameMode = "save";
  let jumpSelected = -1;

  function selectionIndices() { return [...selected].sort((a, b) => a - b); }
  function clearSelection() { selected.clear(); selectAnchor = -1; }
  function sourceBadge(track) {
    if (track.type === "local") return "L";
    if (track.type === "stream") return "S";
    if (track.type === "apple") return "I";
    if (track.type === "spotify") return "P";
    if (track.type === "missing") return "?";
    return "";
  }

  function renderPlaylist() {
    plList.innerHTML = "";
    if (!Music.tracks.length) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "DROP MP3 / WAV / FLAC FILES HERE";
      plList.appendChild(empty);
      return;
    }
    Music.tracks.forEach((t, i) => {
      const li = document.createElement("li");
      li.dataset.index = i;
      li.draggable = true;
      if (i === Music.idx) li.classList.add("current");
      if (selected.has(i)) li.classList.add("selected");
      if (Music.isBad(t.id)) li.classList.add("bad");
      const n = document.createElement("span"); n.className = "n"; n.textContent = (i + 1) + ".";
      const name = document.createElement("span"); name.className = "name"; name.textContent = t.title;
      const tk = document.createElement("span"); tk.className = "toks";
      tk.textContent = t.dur ? fmtTime(t.dur) : "-:--";
      const src = document.createElement("span"); src.className = "src";
      src.textContent = sourceBadge(t);
      // Keep source with the row's other metadata: title reads uninterrupted
      // after the track number, while duration + source form right columns.
      li.append(n, name, tk, src);
      li.addEventListener("click", event => {
        if (event.shiftKey && selectAnchor >= 0) {
          selected.clear();
          const lo = Math.min(selectAnchor, i), hi = Math.max(selectAnchor, i);
          for (let row = lo; row <= hi; row++) selected.add(row);
        } else if (event.ctrlKey || event.metaKey) {
          if (selected.has(i)) selected.delete(i); else selected.add(i);
          selectAnchor = i;
        } else {
          selected.clear(); selected.add(i); selectAnchor = i;
        }
        renderPlaylist();
      });
      li.addEventListener("dblclick", () => Music.playTrack(i));
      li.addEventListener("dragstart", event => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/x-claudeamp-index", String(i));
        li.classList.add("dragging");
      });
      li.addEventListener("dragend", () => li.classList.remove("dragging"));
      li.addEventListener("dragover", event => {
        if (Array.from(event.dataTransfer.types).includes("text/x-claudeamp-index")) event.preventDefault();
      });
      li.addEventListener("drop", event => {
        const from = +event.dataTransfer.getData("text/x-claudeamp-index");
        if (!Number.isInteger(from)) return;
        event.preventDefault();
        clearSelection(); selected.add(i); selectAnchor = i;
        Music.moveTrack(from, i);
      });
      plList.appendChild(li);
    });
  }

  function renderMinibrowserSource(track) {
    const local = !!track && track.type !== "youtube" && !!track.type;
    const apple = !!track && track.type === "apple";
    const spotify = !!track && track.type === "spotify";
    const storeLink = $("itunes-store-link");
    $("yt-wrap").hidden = local;
    $("local-audio-screen").hidden = !local;
    $("yt-offline").hidden = local || !Music.offline;
    storeLink.hidden = !apple || !track.storeUrl;
    if (!storeLink.hidden) storeLink.href = track.storeUrl;
    if (!local) {
      $("mb-note").textContent = Music.offline ? "youtube unavailable - local audio still works" : "youtube embed player";
      return;
    }
    $("local-audio-source").textContent = apple ? "ITUNES 30-SECOND PREVIEW" :
      spotify ? "SPOTIFY CONNECT" :
      track.type === "missing" ? "MISSING FILE" :
      track.type === "stream" ? "NETWORK STREAM" : "LOCAL AUDIO";
    $("local-audio-title").textContent = track.title || "UNTITLED";
    const details = apple ? ["PROVIDED COURTESY OF ITUNES", track.album] :
      spotify ? [track.artist, "PLAYS IN YOUR SPOTIFY APP"] :
      [track.album, track.fileName, track.mime].filter(Boolean);
    $("local-audio-meta").textContent = details.filter(Boolean).join(" / ") || "BROWSER AUDIO DECK";
    $("mb-note").textContent = apple ? "itunes preview - provided courtesy of itunes" :
      spotify ? "spotify connect track" :
      track.type === "missing" ? "add the matching file to relink this track" :
      track.type === "stream" ? "direct audio stream" : "stored in claudeamp local media";
  }

  let musicSearchGeneration = 0;
  function setMusicResultsVisible(visible) {
    $("yt-results").hidden = !visible;
    $("mb-reset-button").hidden = !visible;
  }
  function resetMusicSearch(focus = true) {
    musicSearchGeneration++;
    setMusicResultsVisible(false);
    $("yt-search-input").value = "";
    const searchButton = $("yt-search-button");
    searchButton.disabled = false;
    delete searchButton.dataset.loading;
    $("mb-note").textContent = "visualization restored";
    if (focus) $("yt-search-input").focus();
  }
  function musicResultsState(message) {
    const results = $("yt-results");
    setMusicResultsVisible(true);
    results.innerHTML = "";
    const state = document.createElement("div");
    state.className = "yt-results-state";
    state.textContent = message;
    results.appendChild(state);
  }

  function pixelThumbnail(canvas, source) {
    const image = new Image();
    image.referrerPolicy = "no-referrer";
    image.onload = () => {
      const context = canvas.getContext("2d");
      context.imageSmoothingEnabled = false;
      context.clearRect(0, 0, canvas.width, canvas.height);
      const sourceWidth = image.naturalWidth;
      const sourceHeight = image.naturalHeight;
      const sourceRatio = sourceWidth / sourceHeight;
      const targetRatio = canvas.width / canvas.height;
      let sx = 0, sy = 0, sw = sourceWidth, sh = sourceHeight;
      if (sourceRatio > targetRatio) { sw = sourceHeight * targetRatio; sx = (sourceWidth - sw) / 2; }
      else { sh = sourceWidth / targetRatio; sy = (sourceHeight - sh) / 2; }
      context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      canvas.dataset.imageState = "loaded";
    };
    image.onerror = () => {
      const context = canvas.getContext("2d");
      context.fillStyle = "#06060C"; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#00A000";
      for (let y = 1; y < canvas.height; y += 3)
        for (let x = (y % 2) + 1; x < canvas.width; x += 4) context.fillRect(x, y, 1, 1);
      canvas.dataset.imageState = "fallback";
    };
    if (!source) { image.onerror(); return; }
    image.src = source;
  }

  function searchResultTrack(result, source) {
    if (source === "apple") return {
      type: "apple", id: "apple:" + result.id, appleId: result.id,
      title: [result.artists, result.name].filter(Boolean).join(" - ") || "iTunes Preview",
      artist: result.artists || "", songTitle: result.name || "", album: result.album || "",
      url: result.previewUrl, storeUrl: result.link || "", artwork: result.artwork || "", dur: 30,
    };
    if (source === "spotify") return {
      type: "spotify", id: "spotify:" + result.uri,
      title: [result.artists, result.name].filter(Boolean).join(" - ") || "Spotify Track",
      query: [result.artists, result.name].filter(Boolean).join(" - "),
      spotifyUri: result.uri, artwork: result.artwork || "", artist: result.artists || "",
      songTitle: result.name || "", sourceLocked: true,
      storeUrl: result.link || "", dur: Math.round((result.durationMs || 0) / 1000),
    };
    return {
      type: "youtube", id: result.id, title: result.title, sourceLocked: true,
      dur: result.duration || 0, channel: result.channel || "", thumbnail: result.thumbnail || "",
    };
  }

  function addSearchResult(result, source, button, playNow) {
    const track = searchResultTrack(result, source);
    const added = Music.addTracks([track]);
    if (!added.length) return;
    clearSelection();
    selected.add(added[0]); selectAnchor = added[0];
    renderPlaylist();
    button.textContent = "ADDED"; button.disabled = true; button.classList.add("added");
    $("mb-note").textContent = "added to playlist: " + track.title;
    if (playNow) Music.playTrack(added[0]);
  }

  function renderMusicResults(items, source) {
    const results = $("yt-results");
    results.innerHTML = "";
    setMusicResultsVisible(true);
    if (!items.length) {
      const empty = source === "apple" ? "NO PLAYABLE ITUNES PREVIEWS FOUND" :
        source === "spotify" ? "NO PLAYABLE SPOTIFY TRACKS FOUND" : "NO EMBEDDABLE VIDEO RESULTS FOUND";
      musicResultsState(empty + "\nTRY AN ARTIST AND SONG TITLE");
      return;
    }
    for (const item of items) {
      const track = searchResultTrack(item, source);
      const row = document.createElement("div");
      row.className = "yt-result"; row.setAttribute("role", "listitem");
      const thumb = document.createElement("canvas");
      thumb.width = 32; thumb.height = 24;
      thumb.setAttribute("aria-label", "Artwork for " + track.title);
      pixelThumbnail(thumb, item.thumbnail || item.artwork || "");
      const copy = document.createElement("div"); copy.className = "yt-result-copy";
      const title = document.createElement("div"); title.className = "yt-result-title"; title.textContent = track.title;
      const meta = document.createElement("div"); meta.className = "yt-result-meta";
      const metaParts = source === "apple" ? ["30S PREVIEW", item.album, "COURTESY OF ITUNES"] :
        source === "spotify" ? ["SPOTIFY", item.durationMs ? fmtTime(item.durationMs / 1000) : ""] :
          [item.channel, item.duration ? fmtTime(item.duration) : ""];
      meta.append(document.createTextNode(metaParts.filter(Boolean).join(" / ")));
      if (item.link) {
        const store = document.createElement("a");
        store.className = "yt-result-store"; store.href = item.link;
        store.target = "_blank"; store.rel = "noopener";
        store.textContent = source === "apple" ? " / VIEW IN ITUNES" : " / OPEN";
        store.title = source === "apple" ? "View this song in iTunes" : "Open this song";
        meta.appendChild(store);
      }
      copy.append(title, meta);
      const add = document.createElement("button");
      add.type = "button"; add.className = "plbtn yt-result-add"; add.textContent = "ADD";
      add.title = "Add " + track.title + " to the playlist";
      add.addEventListener("click", () => addSearchResult(item, source, add, false));
      row.addEventListener("dblclick", event => {
        if (!event.target.closest("button, a") && !add.disabled) addSearchResult(item, source, add, true);
      });
      row.append(thumb, copy, add);
      results.appendChild(row);
    }
  }

  async function searchMusic() {
    const query = $("yt-search-input").value.trim();
    const source = $("music-search-source").value;
    const label = source === "apple" ? "ITUNES" : source.toUpperCase();
    if (!query) {
      setMusicResultsVisible(false);
      $("mb-note").textContent = "choose a source and search for a song";
      return;
    }
    if (!bridgeStatus.token) {
      musicResultsState("SEARCH NEEDS THE CLAUDEAMP DESKTOP APP\nOR NODE BRIDGE.JS");
      return;
    }
    const generation = ++musicSearchGeneration;
    const button = $("yt-search-button");
    button.disabled = true; button.dataset.loading = "true";
    musicResultsState("SEARCHING " + label + " FOR " + query.toUpperCase());
    $("mb-note").textContent = "searching " + label.toLowerCase() + "...";
    try {
      const response = await fetch("/bridge/" + source + "/search?q=" + encodeURIComponent(query), {
        cache: "no-store", headers: { "x-claudeamp-token": bridgeStatus.token },
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value.error || label + " search returned " + response.status);
      if (generation !== musicSearchGeneration) return;
      let items = Array.isArray(value.results) ? value.results : [];
      if (source === "youtube") {
        musicResultsState("CHECKING WHICH YOUTUBE RESULTS CAN PLAY...");
        items = await Music.filterPlayableYoutube(items);
      }
      if (generation !== musicSearchGeneration) return;
      renderMusicResults(items, source);
      $("mb-note").textContent = items.length + " playable " + label.toLowerCase() +
        " results - double-click to add and play";
    } catch (error) {
      if (generation !== musicSearchGeneration) return;
      musicResultsState(label + " SEARCH FAILED\n" +
        (error.message || "CHECK YOUR CONNECTION") + "\nPRESS THE SEARCH ICON TO RETRY");
      $("mb-note").textContent = label.toLowerCase() + " search failed - retry with the search icon";
    } finally {
      if (generation === musicSearchGeneration) { button.disabled = false; delete button.dataset.loading; }
    }
  }

  function drawPlTime() {
    const { t, d } = Music.time();
    $("pl-time").textContent = fmtTime(t) + "/" + fmtTime(d);
    // pick up the real duration once the player knows it — but never from a
    // 30s service preview (Apple), which would clobber the song's true length
    const trk = Music.tracks[Music.idx];
    if (trk && d && !Music.servicePreview && Math.abs((trk.dur || 0) - d) > 1.5) {
      trk.dur = Math.round(d);
      Music.updateDuration(Music.idx, d);
      const li = plList.children[Music.idx];
      if (li) li.querySelector(".toks").textContent = fmtTime(trk.dur);
    }
  }

  function progressNote(done, total, name) {
    $("mb-note").textContent = `importing ${done}/${total}: ${name}`;
  }

  async function importLocalFiles(files) {
    const imported = await MediaLibrary.importFiles(files, progressNote);
    const added = Music.addTracks(imported);
    clearSelection();
    added.forEach(i => selected.add(i));
    if (added.length) selectAnchor = added[added.length - 1];
    renderPlaylist();
    $("mb-note").textContent = imported.length ? `${imported.length} local track${imported.length === 1 ? "" : "s"} added` : "no supported audio files found";
  }

  async function playlistEntryTrack(entry, localByName) {
    if (entry.track) {
      const saved = { ...entry.track };
      if (saved.type !== "local") return saved;
      const fileName = saved.fileName || MediaLibrary.basename(saved.ref);
      const selectedFile = localByName.get(String(fileName || "").toLowerCase());
      if (selectedFile) return {
        ...selectedFile,
        title: saved.title || selectedFile.title,
        dur: saved.dur || selectedFile.dur,
      };
      const storedBlob = saved.blobKey && await MediaLibrary.getBlob(saved.blobKey).catch(() => null);
      if (storedBlob) return saved;
      return {
        type: "missing",
        id: "missing:" + (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now() + Math.random()),
        ref: saved.ref || fileName,
        fileName,
        title: saved.title || fileName || "Missing Track",
        dur: saved.dur || 0,
      };
    }
    const ref = String(entry.ref || "").trim();
    const fileName = MediaLibrary.basename(ref);
    const local = localByName.get(fileName.toLowerCase());
    if (local) return local;
    const videoId = Music.parseId(ref);
    if (videoId) return { type: "youtube", id: videoId, title: entry.title || "YouTube " + videoId, dur: entry.dur || 0 };
    if (/^https?:\/\//i.test(ref)) return {
      type: "stream", id: "stream:" + ref, url: ref,
      title: entry.title || ref.replace(/^https?:\/\//i, ""), dur: entry.dur || 0,
    };
    return {
      type: "missing",
      id: "missing:" + (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now() + Math.random()),
      ref,
      fileName,
      title: entry.title || fileName || "Missing Track",
      dur: entry.dur || 0,
    };
  }

  async function importPlaylistFiles(files) {
    const all = Array.from(files || []);
    const playlistFile = all.find(MediaLibrary.isPlaylistFile);
    const audioFiles = all.filter(MediaLibrary.isAudioFile);
    if (!playlistFile) { await importLocalFiles(audioFiles); return; }
    try {
      const localTracks = await MediaLibrary.importFiles(audioFiles, progressNote);
      const localByName = new Map(localTracks.map(track => [track.fileName.toLowerCase(), track]));
      const entries = MediaLibrary.parsePlaylist(await playlistFile.text(), playlistFile.name);
      const imported = await Promise.all(entries.map(entry => playlistEntryTrack(entry, localByName)));
      const referenced = new Set(imported.filter(track => track.type === "local").map(track => track.id));
      imported.push(...localTracks.filter(track => !referenced.has(track.id)));
      const name = playlistFile.name.replace(/\.(m3u8?|pls|json)$/i, "");
      clearSelection();
      Music.replaceTracks(imported, name || "Imported Playlist");
      $("mb-note").textContent = `${imported.length} playlist entries loaded`;
    } catch (error) {
      $("mb-note").textContent = "playlist could not be read";
      msgDiv("error", null, "[PLAYLIST ERROR: " + error.message + "]");
    }
  }

  function exportPlaylist(kind) {
    const base = MediaLibrary.safeName(Music.activeName);
    if (kind === "m3u") MediaLibrary.download(base + ".m3u8", MediaLibrary.exportM3u(Music.tracks), "audio/x-mpegurl;charset=utf-8");
    else if (kind === "pls") MediaLibrary.download(base + ".pls", MediaLibrary.exportPls(Music.tracks), "audio/x-scpls;charset=utf-8");
    else MediaLibrary.download(base + ".claudeamp.json", JSON.stringify({ name: Music.activeName, tracks: Music.tracks }, null, 2), "application/json");
  }

  function openPlaylistName(mode) {
    playlistNameMode = mode;
    $("playlist-name-title").textContent = mode === "new" ? "New Playlist" : "Save Playlist As";
    $("playlist-name").value = mode === "new" ? "" : Music.activeName;
    showDialog("dlg-playlist-name");
    $("playlist-name").focus(); $("playlist-name").select();
  }

  function renderSavedPlaylists() {
    const list = $("saved-playlists");
    list.innerHTML = "";
    const names = Music.playlistNames;
    if (!names.length) {
      const row = document.createElement("div"); row.className = "saved-row"; row.textContent = "NO SAVED PLAYLISTS";
      list.appendChild(row); savedSelected = ""; return;
    }
    if (!names.includes(savedSelected)) savedSelected = names[0];
    names.forEach(name => {
      const row = document.createElement("div");
      row.className = "saved-row" + (name === savedSelected ? " selected" : "");
      row.dataset.name = name; row.setAttribute("role", "option");
      const label = document.createElement("span"); label.className = "saved-name"; label.textContent = name;
      row.appendChild(label);
      row.addEventListener("click", () => { savedSelected = name; renderSavedPlaylists(); });
      row.addEventListener("dblclick", () => { if (Music.loadPlaylist(name)) $("dlg-playlists").hidden = true; });
      list.appendChild(row);
    });
  }

  function openSavedPlaylists() {
    renderSavedPlaylists(); showDialog("dlg-playlists");
  }

  function renderJumpResults() {
    const query = $("jump-query").value.trim().toLowerCase();
    const rows = Music.tracks.map((track, index) => ({ track, index }))
      .filter(row => !query || row.track.title.toLowerCase().includes(query));
    const list = $("jump-results"); list.innerHTML = "";
    if (!rows.length) { jumpSelected = -1; list.textContent = "NO MATCHES"; return; }
    if (!rows.some(row => row.index === jumpSelected)) jumpSelected = rows[0].index;
    rows.forEach(row => {
      const item = document.createElement("div");
      item.className = "jump-row" + (row.index === jumpSelected ? " selected" : "");
      const name = document.createElement("span"); name.className = "jump-name";
      name.textContent = `${row.index + 1}. ${row.track.title}`;
      item.appendChild(name);
      item.addEventListener("click", () => { jumpSelected = row.index; renderJumpResults(); });
      item.addEventListener("dblclick", () => { Music.playTrack(row.index); $("dlg-jump").hidden = true; });
      list.appendChild(item);
    });
  }

  function openJump() {
    jumpSelected = Music.idx;
    $("jump-query").value = "";
    renderJumpResults(); showDialog("dlg-jump"); $("jump-query").focus();
  }

  /* ================================ chat ================================ */
  const chatLog = $("chat-log");
  const chatInput = $("chat-input");

  /* Pasted-image attachments queued for the next message. */
  let chatImages = [];   // {name, mime, dataUrl}
  let imgSeq = 0;
  function renderChatAttachments() {
    const box = $("chat-attachments");
    if (!box) return;
    box.innerHTML = "";
    box.hidden = chatImages.length === 0;
    chatImages.forEach((img, i) => {
      const chip = document.createElement("div");
      chip.className = "chat-chip";
      chip.style.backgroundImage = 'url("' + img.dataUrl + '")';
      const name = document.createElement("span");
      name.className = "chip-name"; name.textContent = img.name;
      const x = document.createElement("button");
      x.type = "button"; x.className = "chip-x"; x.title = "Remove"; x.textContent = "×";
      x.addEventListener("click", () => { chatImages.splice(i, 1); renderChatAttachments(); });
      chip.appendChild(name); chip.appendChild(x);
      box.appendChild(chip);
    });
  }
  function addChatImage(file) {
    if (!file || !/^image\//.test(file.type)) return;
    const reader = new FileReader();
    reader.onload = () => {
      // Conversations persist into one localStorage key with a ~5MB quota;
      // a full-resolution screenshot or two would exhaust it and silently
      // stop ALL chat history from saving. Downscale big pastes to a size
      // the models are happy with and the quota can afford.
      const img = new Image();
      img.onload = () => {
        const MAX = 1280;
        const scale = Math.min(1, MAX / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
        let dataUrl = String(reader.result), mime = file.type;
        if (scale < 1 || dataUrl.length > 700000) {
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
          canvas.height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          dataUrl = canvas.toDataURL("image/jpeg", 0.85);
          mime = "image/jpeg";
        }
        chatImages.push({
          name: file.name || ("image-" + (++imgSeq) + "." + ((mime.split("/")[1]) || "png")),
          mime,
          dataUrl,
        });
        renderChatAttachments();
      };
      img.onerror = () => {
        chatImages.push({
          name: file.name || ("image-" + (++imgSeq) + "." + ((file.type.split("/")[1]) || "png")),
          mime: file.type,
          dataUrl: String(reader.result),
        });
        renderChatAttachments();
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  }

  function msgDiv(cls, who, text, images) {
    const d = document.createElement("div");
    d.className = "msg " + cls;
    if (who) {
      const w = document.createElement("span");
      w.className = "who"; w.textContent = who + ": ";
      d.appendChild(w);
    }
    d.appendChild(document.createTextNode(text || ""));
    if (images && images.length) {
      const wrap = document.createElement("div");
      wrap.className = "msg-imgs";
      for (const im of images) {
        const t = document.createElement("img");
        t.src = im.dataUrl; t.alt = im.name || "image"; t.title = im.name || "image";
        wrap.appendChild(t);
      }
      d.appendChild(wrap);
    }
    chatLog.appendChild(d);
    chatLog.scrollTop = chatLog.scrollHeight;
    return d;
  }
  function renderChat() {
    chatLog.innerHTML = "";
    if (!convo().msgs.length) {
      msgDiv("system", null,
        "*** CLAUDEAMP v" + (window.CLAUDEAMP_VERSION || "") + " ***\n" +
        (demoMode()
          ? (isCli()
            ? provider().label + " IS NOT CONNECTED - TYPE /LOGIN OR USE OPTIONS > " +
              (S.provider === "codex-cli" ? "CODEX" : "CLAUDE") + " LOGIN."
            : isLocal()
              ? "OLLAMA IS NOT READY - START OLLAMA, PULL A MODEL, THEN REFRESH MODELS."
            : "NO MODEL CONNECTED - SEND A MESSAGE FOR GUIDED LOGIN, OR OPEN OPTIONS FOR A " +
              provider().label + " API KEY.")
          : ((isCli() || isLocal()) ? provider().label + " CONNECTED." : provider().label + " key loaded.")));
    }
    for (const m of convo().msgs) {
      msgDiv(m.role === "user" ? "user" : "assistant",
             m.role === "user" ? "YOU" : "AI", m.content, m.images);
    }
    // So does an in-flight reply: the streaming text lives only in these
    // detached-able nodes until onDone commits it into msgs, and a re-render
    // mid-stream (settings opened, login event) must not eat it.
    for (const live of [twThink && twThink.el, thinkingEl, warmupEl, tw && tw.el])
      if (live) chatLog.appendChild(live);
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  function stripMarkdown(t) {
    return t.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
  }

  /* ============================ send / stream ============================ */
  function stopStream() {
    genSeq++; // kill any late events from the aborted run
    // onDone already committed the reply once tw.done is set; only commit
    // the partial when the stream was cut short mid-flight.
    if (tw && !tw.done) {
      const full = tw.text + tw.buf;
      if (full) convo().msgs.push({ role: "assistant", content: full });
    }
    if (streamCtrl) { streamCtrl.abort(); streamCtrl = null; }
    finishTypewriters(true);
    if (liveTurn) commitLiveTurn();
    chatBusy = false;
    saveConvos();
  }

  function commitLiveTurn() {
    if (!liveTurn) return;
    convo().turns.push(liveTurn);
    liveTurn = null;
    saveConvos();
  }

  // Typing indicator: three pulsing dots in a bubble on the model's side of
  // the conversation, shown for every provider from the moment a message is
  // sent until the first token arrives (and again while a model that reports
  // its reasoning is thinking - the reasoning itself is never rendered).
  // Removed when the answer starts.
  let thinkingEl = null;
  function showThinking() {
    if (thinkingEl) return;
    thinkingEl = msgDiv("thinking", "", "");
    const dots = document.createElement("span");
    dots.className = "think-dots";
    dots.setAttribute("role", "status");
    dots.setAttribute("aria-label", "Waiting for a reply");
    for (let i = 0; i < 3; i++) dots.appendChild(document.createElement("i"));
    thinkingEl.appendChild(dots);
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  function hideThinking() {
    if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  }

  // Ollama loads the chosen model into memory on first use and streams NOTHING
  // until it's ready - that's the long pause before the first reply. We show an
  // estimated 0-100 "starting up" bar during that gap (real load-progress isn't
  // exposed by Ollama, so the fill is an eased time estimate from the model's
  // size) and snap it to 100 the moment the first token lands.
  let warmupEl = null, warmupRAF = null, warmupArm = null;
  function currentOllamaSizeGB() {
    const models = (bridgeStatus.ollama && bridgeStatus.ollama.models) || [];
    const id = model().id;
    const m = models.find(x => x.id === id) || models[S.modelIndex] || models[0];
    const bytes = m && Number(m.size) || 0;
    return bytes ? bytes / 1e9 : 4;   // assume ~4GB when the size is unknown
  }
  function armOllamaWarmup() {
    disarmOllamaWarmup();
    // A warm model returns its first token well under this delay, so the bar
    // only ever appears when there is a real load to wait on.
    warmupArm = setTimeout(showOllamaWarmup, 650);
  }
  function showOllamaWarmup() {
    warmupArm = null;
    if (warmupEl) return;
    hideThinking(); // the load bar takes over from the dots until the model is up
    const est = Math.max(2500, currentOllamaSizeGB() * 1600); // ~1.6s per GB
    const start = performance.now();
    warmupEl = msgDiv("warmup", null, "");
    const label = document.createElement("div");
    label.className = "warmup-label";
    label.textContent = "OLLAMA IS STARTING UP - LOADING MODEL";
    const bar = document.createElement("div");
    bar.className = "warmup-bar";
    const fill = document.createElement("div");
    fill.className = "warmup-fill";
    bar.appendChild(fill);
    const pct = document.createElement("span");
    pct.className = "warmup-pct";
    pct.textContent = "0%";
    warmupEl.appendChild(label);
    warmupEl.appendChild(bar);
    warmupEl.appendChild(pct);
    const tick = () => {
      if (!warmupEl) return;
      const t = performance.now() - start;
      // ease toward - but never quite reach - 100 until the model is actually up
      const p = Math.min(96, 100 * (1 - Math.exp(-t / (est * 0.55))));
      fill.style.width = p.toFixed(0) + "%";
      pct.textContent = p.toFixed(0) + "%";
      warmupRAF = requestAnimationFrame(tick);
    };
    tick();
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  function finishOllamaWarmup() {
    if (warmupArm) { clearTimeout(warmupArm); warmupArm = null; }
    if (!warmupEl) return;
    if (warmupRAF) { cancelAnimationFrame(warmupRAF); warmupRAF = null; }
    const fill = warmupEl.querySelector(".warmup-fill");
    const pct = warmupEl.querySelector(".warmup-pct");
    if (fill) fill.style.width = "100%";
    if (pct) pct.textContent = "100%";
    const el = warmupEl; warmupEl = null;
    setTimeout(() => el.remove(), 240);  // let the 100% register, then vanish
  }
  function disarmOllamaWarmup() {
    if (warmupArm) { clearTimeout(warmupArm); warmupArm = null; }
    if (warmupRAF) { cancelAnimationFrame(warmupRAF); warmupRAF = null; }
    if (warmupEl) { warmupEl.remove(); warmupEl = null; }
  }

  function finishTypewriters(flush) {
    disarmOllamaWarmup();
    hideThinking();
    for (const t of [twThink, tw]) {
      if (!t) continue;
      if (flush) { t.el.lastChild.nodeValue = t.text + t.buf; t.buf = ""; }
      t.el.classList.remove("cursor");
    }
    tw = twThink = null;
  }

  function makeTypewriter(cls, who) {
    const el = msgDiv(cls, who, "");
    el.classList.add("cursor");
    return { el, text: "", buf: "", done: false };
  }

  function typeStep() {
    for (const t of [twThink, tw]) {
      if (!t || !t.buf.length) continue;
      const n = t.buf.length > 400 ? 8 : t.buf.length > 120 ? 4 : 2;
      t.text += t.buf.slice(0, n);
      t.buf = t.buf.slice(n);
      t.el.lastChild.nodeValue = t.text;
      chatLog.scrollTop = chatLog.scrollHeight;
      pumpVis(Math.min(1, 0.35 + tps / 60));
    }
    const drained = (!tw || !tw.buf.length) && (!twThink || !twThink.buf.length);
    if (drained && tw && tw.done) {
      finishTypewriters(false);
      if (!streamCtrl) chatBusy = false;
    }
  }

  function sendMessage(text, images) {
    if (chatBusy) return;
    text = (text || "").trim();
    images = images || [];
    if (!text && !images.length) return;
    const c = convo();
    if (c.name === "Untitled Jam") {
      const basis = text || (images.length ? images[0].name : "");
      c.name = basis.slice(0, 30).replace(/\s+\S*$/, m => (basis.length > 30 ? "..." : m)) || "Untitled Jam";
    }
    const msg = { role: "user", content: text };
    if (images.length)
      msg.images = images.map(im => ({ name: im.name, mime: im.mime, dataUrl: im.dataUrl }));
    c.msgs.push(msg);
    msgDiv("user", "YOU", text, msg.images);
    saveConvos();
    startGeneration();
  }

  function regenerate() {
    const c = convo();
    if (chatBusy || !c.msgs.length) return;
    if (c.msgs[c.msgs.length - 1].role === "assistant") c.msgs.pop();
    if (isCli()) {
      c.sessions = c.sessions || {};
      delete c.sessions[provider().cli];
    }
    renderChat();
    saveConvos();
    startGeneration();
  }

  let genSeq = 0;
  function startGeneration() {
    const c = convo();
    if (!c.msgs.length || c.msgs[c.msgs.length - 1].role !== "user") return;
    chatBusy = true;
    genStart = performance.now(); genElapsed = 0;
    tps = 0; lastUsageT = 0; lastUsageOut = 0;
    liveTurn = { in: 0, out: 0, model: model().id, demo: demoMode() };
    tw = twThink = null;
    const myGen = ++genSeq; // stale handlers from a stopped run must not fire
    // Every provider: the dots appear the moment the message goes out, so
    // the wait for a first token never looks like a dropped request.
    showThinking();

    const rawHandlers = {
      onStart(u) { if (liveTurn) liveTurn.in = u.input || 0; },
      onThinking() {
        // First signal from the model means it has finished loading.
        finishOllamaWarmup();
        // The model's private reasoning is NOT shown - only an animated
        // "THINKING…" placeholder to signal it's working. It's replaced by
        // the answer the moment real output starts (onText/onDone).
        showThinking();
      },
      onStatus(text) { msgDiv("system", null, "[" + text + "]"); },
      onSession(id) {
        if (!isCli() || !id) return;
        c.sessions = c.sessions || {};
        c.sessions[provider().cli] = id;
        saveConvos();
      },
      onText(t) {
        finishOllamaWarmup(); // first token: the model is up
        hideThinking(); // the answer replaces the "THINKING…" indicator
        if (!tw) tw = makeTypewriter("assistant", "AI");
        tw.buf += stripMarkdown(t);
      },
      onUsage(u) {
        const now = performance.now();
        if (lastUsageT && u.output > lastUsageOut) {
          const inst = (u.output - lastUsageOut) / ((now - lastUsageT) / 1000);
          tps = tps ? tps * 0.6 + inst * 0.4 : inst;
        }
        lastUsageT = now; lastUsageOut = u.output || 0;
        if (liveTurn) {
          liveTurn.out = u.output || 0;
          if (u.input) liveTurn.in = u.input;
        }
      },
      onDone(info) {
        streamCtrl = null;
        finishOllamaWarmup();
        hideThinking(); // never leave the placeholder up after a turn ends
        if (tw) {
          tw.done = true;
          c.msgs.push({ role: "assistant", content: tw.text + tw.buf });
        }
        if (info && info.stopReason === "refusal")
          msgDiv("system", null, "*record scratch* The model declined that request. Try another track.");
        if (info && info.stopReason === "max_tokens")
          msgDiv("system", null, "[Cut off - the TOK slider capped output. Slide it up for longer takes.]");
        if (info && info.usage && liveTurn)
          liveTurn.out = info.usage.output || liveTurn.out;
        commitLiveTurn();
        if (!tw) chatBusy = false;
        tps = 0;
        saveConvos();
      },
      onError(msg) {
        streamCtrl = null;
        disarmOllamaWarmup();
        // A dead --resume target (workspace switched, CLI state cleared,
        // session expired) fails before any output arrives. Forget the
        // stored session and retry once with the full history instead of
        // leaving this conversation permanently unable to send.
        const cliName = isCli() ? provider().cli : "";
        if (cliName && c.sessions && c.sessions[cliName] && !tw && !twThink) {
          delete c.sessions[cliName];
          saveConvos();
          hideThinking();
          msgDiv("system", null, "[CLI SESSION WAS STALE - RETRYING WITH FULL HISTORY]");
          liveTurn = null;
          startGeneration();
          return;
        }
        // keep any partial reply that already streamed in, like stopStream does
        if (tw && !tw.done) {
          const full = tw.text + tw.buf;
          if (full) c.msgs.push({ role: "assistant", content: full });
        }
        msgDiv("error", "ERROR", msg);
        if (isCli() && /401|authenticat|credentials?/i.test(msg))
          msgDiv("system", null, "[AUTH NEEDED - TYPE /LOGIN OR USE THE MENU > " +
            (S.provider === "codex-cli" ? "CODEX" : "CLAUDE") + " LOGIN]");
        finishTypewriters(true);
        commitLiveTurn();
        chatBusy = false;
        saveConvos();
      },
    };
    const handlers = {};
    for (const k of Object.keys(rawHandlers))
      handlers[k] = (...a) => { if (myGen === genSeq) rawHandlers[k](...a); };

    if (demoMode()) {
      runDemoStream(handlers);
    } else {
      const eff = Object.assign({}, S.eqOn ? S : Object.assign({}, S, {
        balance: 0.5, bands: Object.assign({}, FLAT_BANDS),
      }), {
        apiKey: apiKey(),
        cliAccess: S.cliAccess,
        cliSessionId: isCli() && c.sessions ? c.sessions[provider().cli] || "" : "",
      });
      const req = ClaudeAPI.buildRequest(eff, c.msgs);
      maxTokensReq = req.maxTokens;
      if (isCli() || isLocal()) liveTurn.sub = true;
      // Local Ollama loads the model into memory on the first turn; show the
      // estimated startup bar during that gap (self-cancels if the model is warm).
      if (isLocal()) armOllamaWarmup();
      streamCtrl = ClaudeAPI.send(S.provider, req, handlers);
    }
  }

  function runDemoStream(h) {
    const c = convo();
    const prompt = c.msgs[c.msgs.length - 1].content;
    const reply = ClaudeAPI.demoReply(prompt, S);
    maxTokensReq = 1024;
    let i = 0, cancelled = false;
    streamCtrl = { abort() { cancelled = true; } };
    h.onStart({ input: Math.round(prompt.length / 4) + 120 });
    const step = () => {
      if (cancelled) return; // stopStream already cleaned up this run
      const n = 2 + Math.floor(Math.random() * 6);
      h.onText(reply.slice(i, i + n));
      i += n;
      h.onUsage({ output: Math.round(i / 4) });
      if (i < reply.length) setTimeout(step, 40 + Math.random() * 80);
      else h.onDone({ stopReason: "end_turn", usage: { output: Math.round(reply.length / 4) } });
    };
    setTimeout(step, 350);
  }

  /* ============================ menus & dialogs ============================ */
  const ctxmenu = $("ctxmenu");
  const LOGIN_MENU_ONBOARDING_KEY = "claudeamp.onboarding.login-menu.v1";
  function addPixelSparkles(target) {
    if (!target || target.querySelector(":scope > .pixel-sparkles")) return;
    const field = document.createElement("span");
    field.className = "pixel-sparkles"; field.setAttribute("aria-hidden", "true");
    // Spawn on the target's edges and fly outward: centered sparks die
    // invisibly against the opaque yellow fill.
    const bursts = [
      { sx: "8%", sy: "0%", dx: -13, dy: -19 },
      { sx: "40%", sy: "0%", dx: 3, dy: -23 },
      { sx: "74%", sy: "0%", dx: 15, dy: -20 },
      { sx: "100%", sy: "12%", dx: 22, dy: -11 },
      { sx: "100%", sy: "64%", dx: 24, dy: 7 },
      { sx: "62%", sy: "100%", dx: 11, dy: 20 },
      { sx: "16%", sy: "100%", dx: -11, dy: 18 },
      { sx: "0%", sy: "42%", dx: -22, dy: -4 },
    ];
    bursts.forEach((burst, index) => {
      const spark = document.createElement("i");
      spark.style.left = burst.sx;
      spark.style.top = burst.sy;
      spark.style.setProperty("--dx", burst.dx + "px");
      spark.style.setProperty("--dy", burst.dy + "px");
      spark.style.setProperty("--delay", (-index * 105) + "ms");
      field.appendChild(spark);
    });
    target.appendChild(field);
  }
  function openMenu(items, x, y) {
    ctxmenu.innerHTML = "";
    for (const it of items) {
      if (it === "-") {
        const s = document.createElement("div"); s.className = "sep";
        ctxmenu.appendChild(s); continue;
      }
      const d = document.createElement("div");
      d.className = "mi" + (it.checked ? " checked" : "") + (it.disabled ? " disabled" : "");
      if (it.className) d.classList.add(...it.className.split(/\s+/).filter(Boolean));
      if (it.id) d.dataset.menuId = it.id;
      d.textContent = it.label;
      if (it.sparkles) addPixelSparkles(d);
      if (!it.disabled) d.addEventListener("click", () => { closeMenu(); it.fn(); });
      ctxmenu.appendChild(d);
    }
    ctxmenu.hidden = false;
    const desk = $("desktop");
    const z = WM.zoomFactor();
    const r = desk.getBoundingClientRect();
    ctxmenu.style.left = Math.max(0, Math.min((x - r.left) / z, desk.offsetWidth - 140)) + "px";
    ctxmenu.style.top = Math.max(0, Math.min((y - r.top) / z, desk.offsetHeight - ctxmenu.offsetHeight - 4)) + "px";
  }
  function closeMenu() { ctxmenu.hidden = true; }
  // Quit fully closes the desktop app; in the browser preview there is no
  // process to end, so fall back to closing the tab where the host allows it.
  function quitApp() {
    if (window.claudeampNative && window.claudeampNative.quit) window.claudeampNative.quit();
    else if (window.claudeAmpDesktop && window.claudeAmpDesktop.close) window.claudeAmpDesktop.close();
    else window.close();
  }
  function buttonMenu(button, items) {
    const rect = button.getBoundingClientRect();
    openMenu(items, rect.left, rect.bottom);
  }
  document.addEventListener("pointerdown", e => {
    if (!e.target.closest("#ctxmenu")) closeMenu();
  });


  /* One command map for both menu renderings: the in-app hamburger below
     and the native menu bar (electron/main.cjs builds it from
     js/menu-spec.js and sends ids back over claudeamp:menu-command).
     test/menu-spec.test.cjs pins that every spec id has a handler here. */
  const ZOOM_STEPS = [1, 1.5, 2, 2.5, 3];
  function stepZoom(direction) {
    const at = ZOOM_STEPS.indexOf(S.zoom);
    const next = ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1,
      (at < 0 ? 1 : at) + direction))];
    setZoom(next);
  }
  function toggleWindowCmd(id) {
    WM.toggle(id); syncWinButtons();
  }
  const MENU_COMMANDS = {
    "about": openAbout,
    "welcome": openSetup,
    "settings": openSettings,
    "open-audio": () => $("file-audio").click(),
    "saved-playlists": openSavedPlaylists,
    "jump-to-track": openJump,
    "toggle-win-main": () => toggleWindowCmd("win-main"),
    "toggle-win-chat": () => toggleWindowCmd("win-chat"),
    "toggle-win-eq": () => toggleWindowCmd("win-eq"),
    "toggle-win-pl": () => toggleWindowCmd("win-pl"),
    "toggle-win-usage": () => toggleWindowCmd("win-usage"),
    "toggle-win-mb": () => toggleWindowCmd("win-mb"),
    "toggle-win-term": () => setChatMode(WM.visible("win-term") ? "chat" : "shell"),
    "mode-chat": () => setChatMode("chat"),
    "mode-shell": () => setChatMode("shell"),
    "zoom-1": () => setZoom(1),
    "zoom-1.5": () => setZoom(1.5),
    "zoom-2": () => setZoom(2),
    "zoom-2.5": () => setZoom(2.5),
    "zoom-3": () => setZoom(3),
    "zoom-in": () => stepZoom(1),
    "zoom-out": () => stepZoom(-1),
    "logout": () => { const cli = provider().cli; if (cli) logoutCli(cli); },
    "quit": quitApp,
    "play-pause": () => { if (Music.mode === "playing") Music.pause(); else Music.play(); },
    "next-track": () => Music.next(false),
    "prev-track": () => Music.prev(),
    "show-terminal": () => setChatMode("shell"),
    "help-docs": () => window.open("https://github.com/petehottelet/claudeamp#readme"),
    "help-changelog": () => window.open("https://github.com/petehottelet/claudeamp/blob/main/CHANGELOG.md"),
    "help-issue": () => window.open("https://github.com/petehottelet/claudeamp/issues"),
  };
  function runMenuCommand(id) {
    const fn = MENU_COMMANDS[id];
    if (fn) { fn(); syncMenuState(); }
  }
  // State flows renderer -> main so the native checkmarks stay honest.
  // Pushed after every command and on a slow heartbeat (window buttons and
  // drags change visibility outside the command map); main rebuilds only
  // when the payload actually changed.
  let lastMenuState = "";
  function syncMenuState() {
    const desktop = window.claudeAmpDesktop;
    if (!desktop || !desktop.setMenuState) return;
    const cliName = provider().cli;
    const cliState = cliName ? bridgeStatus[cliName] : null;
    const state = {
      windows: {
        "win-main": WM.visible("win-main"), "win-chat": WM.visible("win-chat"),
        "win-eq": WM.visible("win-eq"), "win-pl": WM.visible("win-pl"),
        "win-usage": WM.visible("win-usage"), "win-mb": WM.visible("win-mb"),
        "win-term": WM.visible("win-term"),
      },
      mode: S.chatMode === "shell" ? "shell" : "chat",
      zoom: S.zoom,
      termAvailable: !!window.claudeampTerm,
      signedIn: !!(cliState && cliState.ready),
      account: (cliState && cliState.account) || "",
    };
    const key = JSON.stringify(state);
    if (key === lastMenuState) return;
    lastMenuState = key;
    try { desktop.setMenuState(state); } catch (_) {}
  }

  function mainMenu(x, y, guide = null) {
    const guideLogin = !guide && !store.raw(LOGIN_MENU_ONBOARDING_KEY);
    const guideTarget = guide?.target || (guideLogin ? "settings" : "");
    const guided = id => id === guideTarget ? { className: "login-onboarding", sparkles: true } : {};
    const winItem = (label, id) => ({
      label, checked: WM.visible(id),
      fn: () => runMenuCommand("toggle-" + id),
    });
    // Signed-in CLI account line + logout action, shown only when a
    // subscription model is connected. This group lives in the menu footer.
    const cliName = provider().cli;              // "claude" | "codex" | undefined
    const cliState = cliName ? bridgeStatus[cliName] : null;
    const signedIn = cliState && cliState.ready;
    const accountItems = signedIn ? [
      { label: cliState.account || "Signed in", disabled: true },
      { label: "Log Out", fn: () => runMenuCommand("logout") },
    ] : [];

    openMenu([
      { label: "Settings", id: "settings", fn: () => runMenuCommand("settings"), ...guided("settings") },
      { label: "About ClaudeAmp...", fn: () => runMenuCommand("about") },
      "-",
      { label: "Open Audio Files...", fn: () => runMenuCommand("open-audio") },
      { label: "Saved Playlists...", fn: () => runMenuCommand("saved-playlists") },
      { label: "Jump to Track...", fn: () => runMenuCommand("jump-to-track") },
      "-",
      winItem("Main Window", "win-main"),
      winItem("Chat", "win-chat"),
      winItem("Equalizer", "win-eq"),
      winItem("Playlist", "win-pl"),
      winItem("Usage Monitor", "win-usage"),
      winItem("Visualization", "win-mb"),
      // The Terminal check doubles as the mode switch; the Mode rows and
      // the zoom steps left the dropdown (owner's call) - zoom lives in
      // Settings > Display and on the Cmd/Ctrl shortcuts.
      { label: "Terminal", checked: WM.visible("win-term"),
        fn: () => runMenuCommand("toggle-win-term") },
      ...(accountItems.length ? ["-", ...accountItems] : []),
      "-",
      { label: "Quit ClaudeAmp", fn: () => runMenuCommand("quit") },
    ], x, y);
    if (guide?.message) {
      const row = ctxmenu.querySelector(`[data-menu-id="${guideTarget}"]`);
      if (row) {
        const tip = document.createElement("span");
        tip.className = "menu-auth-tooltip";
        tip.setAttribute("role", "status");
        const title = document.createElement("strong"); title.textContent = guide.title || "LOGIN REQUIRED";
        tip.append(title, document.createTextNode(guide.message));
        addPixelSparkles(tip);
        row.appendChild(tip);
      }
    }
    if (guideLogin) store.setRaw(LOGIN_MENU_ONBOARDING_KEY, "shown");
  }

  /* ------------------------- wrapped terminal -------------------------
     A real PTY (desktop app only): xterm.js renders inside the skin
     window; the shell itself lives in the Electron main process. The
     holder is inverse-zoomed so glyphs stay native-crisp while the
     chrome stays chunky. */
  let termBooted = false, termFailed = false, term = null, termFit = null, termLive = false;
  function termNote(text) {
    const note = $("term-note");
    note.hidden = !text;
    if (text) note.textContent = text;
  }
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(src));
      document.head.appendChild(s);
    });
  }
  async function bootTerminal() {
    if (termBooted) return true;
    if (termFailed) return false;
    if (!window.claudeampTerm) {
      termFailed = true;
      termNote("THE TERMINAL NEEDS THE CLAUDEAMP DESKTOP APP - IN THE BROWSER, USE YOUR OWN TERMINAL");
      return false;
    }
    try {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "node_modules/@xterm/xterm/css/xterm.css";
      document.head.appendChild(link);
      await loadScript("node_modules/@xterm/xterm/lib/xterm.js");
      await loadScript("node_modules/@xterm/addon-fit/lib/addon-fit.js");
      await loadScript("node_modules/@xterm/addon-canvas/lib/addon-canvas.js");
      await loadScript("node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js");
    } catch (_) {
      termFailed = true;
      termNote("TERMINAL ASSETS MISSING - RUN NPM INSTALL AND RESTART");
      return false;
    }
    try {
    // One stack for every platform: Lucida Console first (the blocky
    // classic-Windows face; absent on macOS), then Menlo - which every Mac
    // ships with full Block Elements coverage, so the Claude CLI's block-art
    // banner renders whole instead of falling through to Courier New.
    const terminalFont = '"Lucida Console", "Menlo", "Cascadia Mono", "Courier New", monospace';
    term = new window.Terminal({
      fontFamily: terminalFont,
      // 12px keeps the cell height an integer at every zoom step
      // (12/18/24/30/36); 13px at 1.5x zoom was 19.5 device pixels, and the
      // fractional rows drew hairline seams through block art.
      fontSize: 12,
      // xterm draws U+2500-U+259F (box drawing + block elements) itself,
      // cell-exact, instead of trusting the font - the other half of the
      // garbled-mascot fix. Takes effect with the webgl/canvas renderer.
      customGlyphs: true,
      cursorBlink: true,
      theme: {
        background: "#000000", foreground: "#00FF00",
        cursor: "#00FF00", cursorAccent: "#000000",
        selectionBackground: "#1E5C1E",
        green: "#00FF00", brightGreen: "#7CFF7C",
      },
    });
    termFit = new window.FitAddon.FitAddon();
    term.loadAddon(termFit);
    // Wait until the (just un-hidden) holder actually has a size before
    // opening; opening xterm into a 0x0 box yields a black, zero-row panel.
    await waitForSize($("term-holder"));
    term.open($("term-holder"));
    // Canvas renderer (accelerated 2D), DOM as the implicit fallback. NOT
    // the WebGL addon: the desktop scales with the CSS `zoom` property, and
    // under an ancestor zoom the WebGL renderer paints the grid into the
    // bottom-left 1/zoom of its canvas (GL's origin is bottom-left), which
    // left the top ~third of every zoomed terminal permanently black - the
    // first-run default is 1.5x, so that was every Windows install. The
    // canvas renderer sizes for the effective zoom and fills the panel.
    try { term.loadAddon(new window.CanvasAddon.CanvasAddon()); } catch (_) {}
    try {
      term.loadAddon(new window.Unicode11Addon.Unicode11Addon());
      term.unicode.activeVersion = "11"; // wide glyphs and emoji keep columns aligned
    } catch (_) {}
    // The GPU renderer keeps screen text out of the DOM (.xterm-rows stays
    // empty), so the verification harness reads the terminal through this
    // buffer probe instead.
    window.__claudeampTermText = () => {
      try {
        const buf = term.buffer.active;
        const rows = [];
        for (let i = 0; i < term.rows; i++) {
          const line = buf.getLine(buf.viewportY + i);
          rows.push(line ? line.translateToString(true) : "");
        }
        return { rows, cursorRow: buf.cursorY };
      } catch (_) { return { rows: [], cursorRow: -1 }; }
    };
    const xtermRoot = $("term-holder").querySelector(".xterm");
    if (xtermRoot) xtermRoot.style.fontFamily = terminalFont;
    const terminalViewport = $("term-holder").querySelector(".xterm-viewport");
    attachAmpScroll(terminalViewport, $("term-scroll"), Math.max(24, term.options.fontSize * 3));
    term.onData(data => window.claudeampTerm.input(data));
    window.claudeampTerm.onData(data => {
      termSawOutput = true;
      termNote("");        // real shell output: reveal the xterm grid
      term.write(data);
    });
    // Detailed backend diagnostics stay in terminal.log. The UI only needs a
    // concise startup state; internal host/ConPTY traces are not terminal text.
    window.claudeampTerm.onExit(info => {
      termLive = false;
      const code = info && info.code != null ? " (" + info.code + ")" : "";
      term.write("\r\n\x1b[33m[SHELL EXITED" + code + " - REOPEN THE TERMINAL TO RESTART]\x1b[0m\r\n");
    });
    new ResizeObserver(() => fitTerminal()).observe($("term-holder"));
    } catch (error) {
      termFailed = true;
      termNote("TERMINAL SETUP FAILED: " + String((error && error.message) || error).toUpperCase().slice(0, 80));
      return false;
    }
    termBooted = true;
    return true;
  }
  function waitForSize(el, tries = 60) {
    return new Promise(resolve => {
      const check = () => {
        if (!el || (el.clientWidth > 4 && el.clientHeight > 4) || tries-- <= 0) resolve();
        else requestAnimationFrame(check);
      };
      check();
    });
  }
  function fitTerminal() {
    if (!termBooted || !WM.visible("win-term")) return;
    const holder = $("term-holder");
    if (!holder || holder.clientWidth < 4 || holder.clientHeight < 4) return;
    try {
      // The whole desktop is scaled with a CSS transform, and xterm's fit
      // measurement reads layout pixels (which the transform doesn't change),
      // so we must NOT also apply CSS `zoom` here - doing both double-counted
      // and could collapse the grid to zero rows, leaving a black panel.
      holder.style.zoom = "";
      termFit.fit();
      if (termLive && term.cols && term.rows)
        window.claudeampTerm.resize({ cols: term.cols, rows: term.rows });
    } catch (_) {}
  }
  let termSawOutput = false;
  async function openTerminal(auto = shellAutoCommand()) {
    WM.toggle("win-term", true);
    WM.bringToFront($("win-term"));
    if (!(await bootTerminal())) return;
    termNote("STARTING TERMINAL…");
    term.focus(); // visible cursor from the first frame, even while spawning
    // The CLI hint only needs a fresh "installed" flag - never let a slow or
    // wedged bridge probe hold the whole terminal hostage (silent black).
    await Promise.race([
      refreshBridgeStatus(true).catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ]);
    requestAnimationFrame(async () => {
      // NOTHING in here may fail silently: a swallowed rejection is exactly
      // the all-black terminal panel users reported. Every failure paints.
      try {
        fitTerminal();
        if (!termLive) {
          termSawOutput = false;
          $("term-holder").dataset.backend = "";
          // The desktop shell tries every PTY backend (narrated into this
          // panel); a hung invoke must still surface, hence the outer race.
          const res = await Promise.race([
            window.claudeampTerm.open({
              cols: term.cols, rows: term.rows,
              env: auto && auto.env ? auto.env : undefined,
            }).catch(error => ({ ok: false, error: String((error && error.message) || error) })),
            new Promise(resolve => setTimeout(() =>
              resolve({ ok: false, error: "the terminal backend did not answer in 45s" }), 45000)),
          ]);
          if (!res || !res.ok) {
            if (termSawOutput) return; // a late backend came alive after all
            termNote("THE TERMINAL COULDN'T START ON THIS MACHINE:\n" +
              String((res && res.error) || "unknown").toUpperCase() +
              "\n\nREOPEN THE TERMINAL TO TRY AGAIN." +
              (res && res.log ? "\n(LOG: " + res.log + ")" : ""));
            if (S.chatMode === "shell") {
              // don't strand the user in shell mode with no working shell
              setChatMode("chat");
              msgDiv("system", null, "THE TERMINAL COULD NOT START (" +
                String((res && res.error) || "unknown").toUpperCase() +
                ") - REOPEN THE TERMINAL TO TRY AGAIN, OR STAY IN CHAT MODE.");
            }
            return;
          }
          termLive = true;
          $("term-holder").dataset.backend = String(res.backend || "");
          // The main process deliberately returns the first shell bytes with
          // the invoke result. Writing them here closes the startup race where
          // an early IPC event could arrive while the diagnostics overlay was
          // still considered authoritative.
          if (res.initialData) {
            termSawOutput = true;
            termNote("");
            term.write(String(res.initialData));
          }
          // The wizard promises this shell auto-runs the chosen CLI. Every
          // term-open spawns a fresh shell (main kills any prior session), so
          // this can never type into an already-running CLI; the tty holds
          // the line until the shell reads it. The verify harness needs the
          // bare shell instead - its echo probes must not land inside a TUI.
          if (auto && auto.cmd && !(window.claudeampNative && window.claudeampNative.verifyMode))
            window.claudeampTerm.input(auto.cmd + "\r");
        }
        window.claudeampTerm.resize({ cols: term.cols, rows: term.rows });
        term.focus();
      } catch (error) {
        termNote("TERMINAL ERROR: " + String((error && error.message) || error).toUpperCase().slice(0, 90));
      }
    });
  }

  /* The chat window can instead be a real terminal that launches the
     chosen brain's CLI. The shell window simply takes over the chat
     window's dock slot; the hamburger menu swaps back. */
  function shellAutoCommand(p = S.provider) {
    if (p === "claude-cli") return { cmd: "claude", label: "CLAUDE CODE" };
    if (p === "codex-cli") return { cmd: "codex", label: "CODEX" };
    if (p === "claude")
      return { cmd: "claude", label: "CLAUDE CODE",
               env: S.keys.claude ? { ANTHROPIC_API_KEY: S.keys.claude } : undefined };
    if (p === "openai")
      return { cmd: "codex", label: "CODEX",
               env: S.keys.openai ? { OPENAI_API_KEY: S.keys.openai } : undefined };
    if (p === "ollama" && p === S.provider) {
      // model() reads S.provider, so the id is only meaningful once ollama
      // is actually the active brain (previews for other brains skip this).
      const id = model().id || "";
      if (/^[A-Za-z0-9._:-]+$/.test(id))
        return { cmd: "ollama run " + id, label: "OLLAMA " + id.toUpperCase() };
    }
    return null; // no CLI counterpart (e.g. Gemini): plain shell
  }
  function setChatMode(mode) {
    if (mode === "shell" && !window.claudeampTerm) {
      msgDiv("system", null, "REAL-TERMINAL MODE NEEDS THE CLAUDEAMP DESKTOP APP - STAYING IN CHAT MODE.");
      mode = "chat";
    }
    S.chatMode = mode;
    saveSettings();
    const chat = $("win-chat"), shell = $("win-term");
    if (mode === "shell") {
      if (WM.visible("win-chat")) {
        chat.classList.remove("shaded"); // a shaded chat measures titlebar-only
        shell.style.left = chat.offsetLeft + "px";
        shell.style.top = chat.offsetTop + "px";
        shell.style.width = chat.offsetWidth + "px";
        shell.style.height = chat.offsetHeight + "px";
        WM.toggle("win-chat", false);
      }
      openTerminal(shellAutoCommand());
    } else {
      // Only reclaim the slot when the shell actually replaced the chat
      // window; a standalone shell opened from the menu stays put.
      if (!WM.visible("win-chat") && WM.visible("win-term")) {
        chat.style.left = shell.offsetLeft + "px";
        chat.style.top = shell.offsetTop + "px";
        WM.toggle("win-term", false);
      }
      WM.toggle("win-chat", true);
      WM.bringToFront(chat);
    }
  }

  /* ---------------------- first-run welcome overlay ----------------------
     The modern panel (same design language as Settings, liquid glass on
     macOS): pick terminal vs chat, pick where the music plays from, go.
     Choices are remembered; reopening it later preselects the live state. */
  // v2: shown once to everyone at the 1.7 re-founding - installs before
  // 1.7.1 kept their app data across uninstall/reinstall (the Windows
  // uninstaller now clears it, but only uninstallers built from 1.7.1 on),
  // so the key bump is what actually re-runs the welcome for them.
  const SETUP_KEY = "claudeamp.onboarding.setup.v2";
  let setupWired = false;
  let wmPage = 1;

  /* Page 2 of the welcome: pick the model (step 3) and connect it (step 4).
     Step 4's shape depends on the dropdown: API providers take a key,
     Ollama picks a local model, the subscription CLIs need nothing. */
  const WM_STEP4 = {
    "claude-cli": { title: "No key needed",
      cli: "Claude Code signs in with your Claude subscription — after starting, use the menu's Claude Login." },
    "codex-cli": { title: "No key needed",
      cli: "Codex signs in with your ChatGPT subscription — after starting, use the menu's Codex Login." },
    claude: { title: "Anthropic API key", key: "sk-ant-…", help: "Stored only on this machine." },
    openai: { title: "OpenAI API key", key: "sk-…", help: "Stored only on this machine." },
    gemini: { title: "Google AI (Gemini) API key", key: "AIza…", help: "Stored only on this machine." },
    ollama: { title: "Pick a local model", ollama: true, help: "Models already pulled into your local Ollama." },
  };
  const wmMode = () =>
    (document.querySelector('input[name="wm-mode"]:checked') || {}).value || "chat";
  const wmMusic = () =>
    (document.querySelector('input[name="wm-music"]:checked') || {}).value || "itunes";
  // Spotify gets an account-connect step on page 2.
  const wmMusicNeedsConnect = () => wmMusic() === "spotify";
  const wmNeedsPage2 = () => wmMode() === "chat" || wmMusicNeedsConnect();
  function wmSyncPrimary() {
    const btn = $("wm-start");
    if (wmPage === 1 && wmNeedsPage2()) {
      btn.innerHTML = "";
      btn.appendChild(document.createTextNode("Next"));
      const arrow = document.createElement("span");
      arrow.className = "next-arrow";
      arrow.textContent = "→";
      btn.appendChild(arrow);
    } else {
      btn.textContent = "Start ClaudeAmp";
    }
    $("wm-back").hidden = wmPage === 1;
  }
  function wmShowPage(page) {
    wmPage = page;
    $("wm-page1").hidden = page !== 1;
    $("wm-page2").hidden = page !== 2;
    if (page === 2) {
      // model steps only in chat mode; music-connect only for paid services
      const chat = wmMode() === "chat";
      $("wm-model-steps").hidden = !chat;
      if (chat) {
        $("wm-provider").value = ClaudeAPI.PROVIDERS[S.provider] ? S.provider : "claude-cli";
        wmRenderStep4();
      }
      const connect = wmMusicNeedsConnect();
      $("wm-music-connect").hidden = !connect;
      if (connect) {
        $("wm-music-num").textContent = chat ? "5." : "3.";
        $("wm-music-connect-help").textContent =
          "Link your Spotify Premium account so every playlist entry plays the official track through your Spotify app.";
        // the Spotify row/help visibility is driven by refreshServiceUi
        refreshSpotifyUi("wm");
      }
    }
    wmSyncPrimary();
    const content = document.querySelector("#welcome-modern .content");
    if (content) content.scrollTop = 0;
  }
  function wmRenderStep4() {
    const p = $("wm-provider").value;
    const spec = WM_STEP4[p] || WM_STEP4["claude-cli"];
    $("wm-step4-title").textContent = spec.title;
    $("wm-step4-help").textContent = spec.help || "";
    $("wm-key-row").hidden = !spec.key;
    $("wm-ollama-row").hidden = !spec.ollama;
    const note = $("wm-cli-note");
    note.hidden = !spec.cli;
    if (spec.cli) note.textContent = spec.cli;
    if (spec.key) {
      const input = $("wm-api-key");
      input.placeholder = spec.key;
      input.value = S.keys[p] || "";
    }
    if (spec.ollama) wmFillOllama();
  }
  function wmFillOllama() {
    const select = $("wm-ollama-model"), status = $("wm-ollama-status");
    const models = (bridgeStatus.ollama && bridgeStatus.ollama.models) || [];
    select.innerHTML = "";
    for (const m of models) {
      const option = document.createElement("option");
      option.value = m.id;
      option.textContent = m.id;
      select.appendChild(option);
    }
    select.disabled = !models.length;
    if (S.provider === "ollama" && models[S.modelIndex]) select.value = models[S.modelIndex].id;
    status.textContent = models.length
      ? models.length + " local model" + (models.length > 1 ? "s" : "")
      : "Start Ollama, then Refresh";
  }
  function wmFinish() {
    const music = (document.querySelector('input[name="wm-music"]:checked') || {}).value || "itunes";
    S.musicService = ["itunes", "youtube", "spotify"].includes(music) ? music : "itunes";
    const wmSpotify = $("wm-spotify-client");
    if (wmSpotify && wmSpotify.value.trim()) S.spotifyClientId = wmSpotify.value.trim();
    if (wmMode() === "chat" && wmPage === 2) {
      const p = $("wm-provider").value;
      const spec = WM_STEP4[p] || {};
      if (ClaudeAPI.PROVIDERS[p]) S.provider = p;
      if (spec.key) {
        persistKey(p, $("wm-api-key").value.trim());
      }
      if (spec.ollama) {
        const models = (bridgeStatus.ollama && bridgeStatus.ollama.models) || [];
        const index = models.findIndex(m => m.id === $("wm-ollama-model").value);
        if (index >= 0) S.modelIndex = index;
      }
    }
    syncMusicService();
    chooseSetup(wmMode());
  }

  function openSetup() {
    const overlay = $("welcome-modern");
    if (!overlay) return;
    const iconHost = $("wm-icon");
    if (iconHost && !iconHost.firstChild) {
      // Build the mark here rather than cloning the Settings panel's copy:
      // on a first run Settings has never been opened, so there is nothing
      // in the DOM to clone and the welcome header would show no icon.
      const clawMark = document.createElement("img");
      clawMark.className = "about-mark";
      clawMark.src = "assets/claw-mark.png";
      clawMark.alt = "";
      iconHost.appendChild(clawMark);
    }
    if (!setupWired) {
      setupWired = true;
      $("wm-close").addEventListener("click", () => {
        overlay.hidden = true;
        // Closing counts as seen - the welcome must not nag every boot;
        // it stays reachable from the menu.
        store.setRaw(SETUP_KEY, "done");
        // A returning shell-mode user dismissing the re-shown welcome still
        // gets their terminal: the boot path skipped its shell startup
        // because the welcome intercepted it. Unconditional on visibility -
        // a restored layout can show win-term as a visible but never-booted
        // shell, and setChatMode("shell") is what actually starts the PTY.
        if (S.chatMode === "shell" && window.claudeampTerm)
          setChatMode("shell");
      });
      $("wm-start").addEventListener("click", () => {
        if (wmPage === 1 && wmNeedsPage2()) { wmShowPage(2); return; }
        wmFinish();
      });
      $("wm-back").addEventListener("click", () => wmShowPage(1));
      document.querySelectorAll('input[name="wm-mode"], input[name="wm-music"]').forEach(radio =>
        radio.addEventListener("change", wmSyncPrimary));
      $("wm-provider").addEventListener("change", wmRenderStep4);
      $("wm-key-eye").addEventListener("click", () => {
        const input = $("wm-api-key");
        input.type = input.type === "password" ? "text" : "password";
      });
      $("wm-ollama-refresh").addEventListener("click", () =>
        refreshBridgeStatus(true).then(wmFillOllama).catch(() => {}));
      wireSpotifyRow("wm");
    }
    // First run defaults to the terminal; a returning user sees their
    // actual current mode preselected.
    const firstRun = !store.raw(SETUP_KEY);
    const wantMode = firstRun || S.chatMode === "shell" ? "shell" : "chat";
    const modeRadio = document.querySelector('input[name="wm-mode"][value="' + wantMode + '"]');
    if (modeRadio) modeRadio.checked = true;
    const musicRadio = document.querySelector(
      'input[name="wm-music"][value="' + (S.musicService || "itunes") + '"]');
    if (musicRadio) musicRadio.checked = true;
    refreshSpotifyUi("wm");
    wmShowPage(1); // reopening always starts on the first page
    overlay.hidden = false;
  }

  function chooseSetup(mode) {
    const overlay = $("welcome-modern");
    if (overlay) overlay.hidden = true;
    store.setRaw(SETUP_KEY, "done");
    const wantShell = mode === "shell" && !!window.claudeampTerm;
    S.chatMode = wantShell ? "shell" : "chat";
    // Default the terminal's CLI only when the current provider has none -
    // a Codex or Ollama user re-running the welcome keeps their choice
    // instead of being silently switched to Claude Code.
    if (wantShell && !provider().cli && S.provider !== "ollama") S.provider = "claude-cli";
    saveSettings();
    drawEqFace(); drawInfo();
    if (wantShell) {
      // Through setChatMode, not a bare toggle: the mode switch moves the
      // terminal into the chat window's slot. Hiding the chat and opening
      // the terminal directly left the terminal at the default layout's
      // third stacked position - off the bottom edge of shorter desktops.
      setChatMode("shell");
    } else {
      if (mode === "shell") // asked for terminal but not the desktop app
        msgDiv("system", null, "THE REAL TERMINAL NEEDS THE CLAUDEAMP DESKTOP APP - USING CHAT INSTEAD.");
      // Through setChatMode here too: it also reclaims the chat slot and
      // hides a leftover terminal window, which a bare toggle left visible.
      setChatMode("chat");
      renderLoginSteps();
    }
    initMenuOnboarding(true);
  }

  // Chat-mode first run: the chat log shows the steps to connect the CHOSEN
  // model. The guidance is provider-specific - an Ollama user must not be told
  // to run Claude login.
  function renderLoginSteps() {
    const cli = window.claudeAmpDesktop;
    const p = S.provider;
    chatLog.innerHTML = "";
    msgDiv("system", null, "*** CLAUDEAMP v" + (window.CLAUDEAMP_VERSION || "") + " - LET'S CONNECT A MODEL ***");
    if (p === "ollama") {
      const st = bridgeStatus.ollama || {};
      const models = st.models || [];
      if (st.ready && models.length) {
        msgDiv("system", null, "OLLAMA IS READY - " + models.length + " LOCAL MODEL" +
          (models.length > 1 ? "S" : "") + " FOUND. JUST TYPE BELOW TO CHAT.");
      } else {
        msgDiv("system", null,
          "OLLAMA (FREE LOCAL MODELS):\n" +
          "1. INSTALL OLLAMA FROM https://ollama.com AND KEEP IT RUNNING.\n" +
          "2. PULL A MODEL IN A TERMINAL, e.g.  ollama pull llama3\n" +
          "3. MENU > OPTIONS... > REFRESH MODELS TO PICK IT UP.\n" +
          "4. RETURN HERE AND JUST TYPE." +
          (st.error ? "\n\n(" + String(st.error).toUpperCase() + ")" : ""));
      }
    } else if (p === "claude-cli" || p === "codex-cli") {
      if (cli) {
        msgDiv("system", null,
          "SUBSCRIPTION (NO API KEY):\n" +
          "1. OPEN THE MENU (HAMBURGER).\n" +
          "2. CHOOSE \"CLAUDE LOGIN...\" (OR \"CODEX LOGIN...\").\n" +
          "3. FINISH THE BROWSER/DEVICE STEP IN THE TERMINAL THAT OPENS.\n" +
          "4. RETURN HERE - CLAUDEAMP DETECTS IT AUTOMATICALLY, THEN JUST TYPE.");
        msgDiv("system", null,
          "PREFER AN API KEY? MENU > OPTIONS... - PASTE A CLAUDE, OPENAI, OR GEMINI KEY.");
      } else {
        msgDiv("system", null,
          "SUBSCRIPTION LOGIN (CLAUDE CODE / CODEX) NEEDS THE CLAUDEAMP DESKTOP APP.\n" +
          "IN THE BROWSER, OPEN MENU > OPTIONS... AND PASTE A CLAUDE, OPENAI, OR GEMINI API KEY.");
      }
    } else {
      // API-key providers: claude, openai, gemini
      const label = p === "openai" ? "OPENAI" : p === "gemini" ? "GOOGLE AI (GEMINI)" : "ANTHROPIC (CLAUDE)";
      msgDiv("system", null,
        "MENU > OPTIONS... AND PASTE YOUR " + label + " API KEY, THEN JUST TYPE BELOW.");
    }
  }


  function showLoginGuide() {
    const local = isLocal();
    const target = "settings";
    const button = document.querySelector("#win-main .tb-menu");
    const rect = button.getBoundingClientRect();
    mainMenu(rect.left, rect.bottom, {
      target,
      title: local ? "LOCAL MODEL NEEDED" : "LOGIN REQUIRED",
      message: local
        ? "START OLLAMA AND PULL A MODEL. THEN OPEN OPTIONS AND PRESS REFRESH MODELS."
        : "CLICK HERE. FINISH THE BROWSER/DEVICE STEP IN THE TERMINAL, THEN PRESS ENTER TO SEND.",
    });
  }

  function showBrainSetupGuide() {
    const local = isLocal();
    const name = local ? "OLLAMA" : S.provider === "codex-cli" ? "CODEX" : "CLAUDE";
    msgDiv("system", null, local
      ? "OLLAMA IS NOT READY. START OLLAMA, PULL A LOCAL MODEL, THEN USE REFRESH MODELS. YOUR MESSAGE IS STILL IN THE INPUT."
      : "AUTHENTICATION IS REQUIRED BEFORE I CAN SEND THAT. USE THE HIGHLIGHTED " + name +
        " LOGIN; YOUR MESSAGE IS STILL IN THE INPUT.");
    showLoginGuide();
  }

  document.addEventListener("contextmenu", e => {
    if (e.target.closest("input") || e.target.closest(".chat-log")) return;
    e.preventDefault();
    mainMenu(e.clientX, e.clientY);
  });

  function showDialog(id) {
    const d = $(id);
    d.hidden = false;
    d.style.zIndex = 2000;
  }
  document.querySelectorAll("[data-close]").forEach(b =>
    b.addEventListener("click", () => { b.closest(".w95-dialog").hidden = true; }));

  document.querySelectorAll(".w95-dialog").forEach(d => {
    const bar = d.querySelector(".w95-title");
    let sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
    bar.addEventListener("pointerdown", e => {
      if (e.target.closest(".w95-x")) return;
      drag = true;
      const z = WM.zoomFactor();
      sx = e.clientX / z; sy = e.clientY / z;
      ox = d.offsetLeft; oy = d.offsetTop;
      bar.setPointerCapture(e.pointerId);
    });
    bar.addEventListener("pointermove", e => {
      if (!drag) return;
      const z = WM.zoomFactor();
      d.style.left = ox + (e.clientX / z - sx) + "px";
      d.style.top = Math.max(0, oy + (e.clientY / z - sy)) + "px";
    });
    bar.addEventListener("pointerup", () => { drag = false; });
  });

  /* Settings and About sit centered on a full-window backdrop. Dragging
     the header offsets the panel with a transform, so the centering rule
     stays its resting position and each open starts centered again. The
     panel lives outside the zoomed desktop, but the scale is measured
     rather than assumed so a zoomed ancestor would still drag 1:1. */
  const modernDrags = new Map();
  function makeModernDraggable(overlayId) {
    if (modernDrags.has(overlayId)) return;
    const overlay = $(overlayId);
    const panel = overlay && overlay.querySelector(".window");
    const bar = panel && panel.querySelector(".header");
    if (!bar) return;
    panel.classList.add("draggable");
    let dx = 0, dy = 0, sx = 0, sy = 0, ox = 0, oy = 0, minY = 0, drag = false;
    const place = () => { panel.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : ""; };
    const scale = () => panel.getBoundingClientRect().width / (panel.offsetWidth || 1) || 1;
    bar.addEventListener("pointerdown", e => {
      if (e.button !== 0 || e.target.closest("button, a, input")) return;
      const z = scale();
      drag = true;
      sx = e.clientX / z; sy = e.clientY / z; ox = dx; oy = dy;
      // the header may rise no higher than the backdrop's top edge
      minY = dy - panel.getBoundingClientRect().top / z;
      try { bar.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    bar.addEventListener("pointermove", e => {
      if (!drag) return;
      const z = scale();
      dx = ox + (e.clientX / z - sx);
      dy = Math.max(minY, oy + (e.clientY / z - sy));
      panel.classList.add("dragging");
      place();
    });
    const stop = () => { drag = false; panel.classList.remove("dragging"); };
    bar.addEventListener("pointerup", stop);
    bar.addEventListener("pointercancel", stop);
    modernDrags.set(overlayId, () => { dx = dy = 0; place(); });
  }
  function resetModernDrag(overlayId) {
    const reset = modernDrags.get(overlayId);
    if (reset) reset();
  }

  async function logoutCli(cli) {
    const label = cli === "codex" ? "CODEX" : "CLAUDE";
    if (!bridgeStatus.token) {
      msgDiv("system", null, "LOG OUT NEEDS THE DESKTOP APP OR BRIDGE.JS.");
      return;
    }
    msgDiv("system", null, "LOGGING OUT OF " + label + "...");
    try {
      const response = await fetch("/bridge/logout?cli=" + cli, {
        method: "POST", cache: "no-store",
        headers: { "x-claudeamp-token": bridgeStatus.token },
      });
      const result = await response.json().catch(() => ({}));
      await refreshBridgeStatus(true);
      msgDiv("system", null, result.ok
        ? label + " LOGGED OUT."
        : "LOG OUT MAY NOT HAVE COMPLETED: " + String(result.error || "unknown").toUpperCase());
    } catch (error) {
      msgDiv("system", null, "LOG OUT FAILED: " + String(error.message || error).toUpperCase());
    }
  }

  async function openClaudeLogin() {
    if (!window.claudeAmpDesktop?.openClaudeLogin) {
      msgDiv("system", null, "CLAUDE LOGIN REQUIRES THE CLAUDEAMP DESKTOP APP.");
      return false;
    }
    const result = await window.claudeAmpDesktop.openClaudeLogin();
    if (!result?.ok) {
      msgDiv("system", null, "COULD NOT OPEN CLAUDE LOGIN: " + (result?.error || "UNKNOWN ERROR"));
      return false;
    }
    msgDiv("system", null,
      "CLAUDE LOGIN OPENED IN A SECURE TERMINAL. FINISH THE BROWSER/CODE PROMPT THERE; CLAUDEAMP WILL DETECT IT AUTOMATICALLY.");
    return true;
  }
  async function openCodexLogin() {
    if (!window.claudeAmpDesktop?.openCodexLogin) {
      msgDiv("system", null, "CODEX LOGIN REQUIRES THE CLAUDEAMP DESKTOP APP.");
      return false;
    }
    const result = await window.claudeAmpDesktop.openCodexLogin();
    if (!result?.ok) {
      msgDiv("system", null, "COULD NOT OPEN CODEX LOGIN: " + (result?.error || "UNKNOWN ERROR"));
      return false;
    }
    msgDiv("system", null,
      "CODEX LOGIN OPENED IN A SECURE TERMINAL. FINISH THE BROWSER/DEVICE PROMPT THERE; CLAUDEAMP WILL DETECT IT AUTOMATICALLY.");
    return true;
  }
  // The CLI can take a beat to persist credentials after the terminal
  // reports done, so re-probe a few times before giving up.
  async function waitForCliReady(cli, tries = 6) {
    for (let i = 0; i < tries; i++) {
      await refreshBridgeStatus(true);
      if (bridgeStatus[cli].ready) return true;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return bridgeStatus[cli].ready;
  }
  if (window.claudeAmpDesktop?.onClaudeLoginComplete) {
    window.claudeAmpDesktop.onClaudeLoginComplete(async result => {
      const ready = await waitForCliReady("claude");
      if (result?.ok && ready) {
        S.provider = "claude-cli";
        saveSettings(); drawEqFace(); drawInfo(); renderChat();
        msgDiv("system", null, "CLAUDE LOGIN CONFIRMED - CLAUDE CODE IS NOW THE ACTIVE MODEL.");
      } else {
        msgDiv("system", null, "CLAUDE LOGIN DID NOT COMPLETE: " +
          (result?.error || bridgeStatus.claude.error || "TERMINAL CLOSED BEFORE AUTHENTICATION"));
      }
    });
  }
  if (window.claudeAmpDesktop?.onCodexLoginComplete) {
    window.claudeAmpDesktop.onCodexLoginComplete(async result => {
      const ready = await waitForCliReady("codex");
      if (result?.ok && ready) {
        S.provider = "codex-cli";
        saveSettings(); drawEqFace(); drawInfo(); renderChat();
        msgDiv("system", null, "CODEX LOGIN CONFIRMED - CODEX CLI IS NOW THE ACTIVE MODEL.");
      } else {
        msgDiv("system", null, "CODEX LOGIN DID NOT COMPLETE: " +
          (result?.error || bridgeStatus.codex.error || "TERMINAL CLOSED BEFORE AUTHENTICATION"));
      }
    });
  }
  /* ---------------- Modern settings overlay ---------------- */
  let smWired = false;
  function renderSmInfo() {
    const el = $("sm-info-lines");
    if (!el) return;
    const rows = [
      { key: "claude", label: "Claude Code" },
      { key: "codex",  label: "Codex CLI" },
      { key: "ollama", label: "Ollama" },
    ];
    el.innerHTML = "";
    for (const r of rows) {
      const st = bridgeStatus[r.key] || {};
      const line = document.createElement("div"); line.className = "info-line";
      const lab = document.createElement("div"); lab.className = "info-label"; lab.textContent = r.label;
      const val = document.createElement("div");
      if (st.ready) {
        val.className = "info-ok";
        val.textContent = "Ready" + (st.account ? " — " + st.account : "");
      } else if (st.installed) {
        val.className = "info-off"; val.textContent = "Installed, not signed in";
      } else {
        val.className = "info-off"; val.textContent = window.claudeAmpDesktop ? "Not installed" : "Needs the desktop app";
      }
      line.append(lab, val);
      el.appendChild(line);
    }
  }
  /* --------------------- music service (Spotify Connect) ---------------------
     iTunes previews and YouTube embeds play directly in ClaudeAmp; Spotify is
     the one external service adapter. The bridge owns its OAuth tokens. */
  /* Spotify is the one connectable service: a client-id input, a Connect
     button, and a status chip, per overlay prefix (wm-/sm-). */
  const SVC_UI = {
    spotify: {
      api: () => MusicService,
      adapter: () => MusicService.adapter,
      clientKey: "spotifyClientId",
      hint: "Paste your Spotify app Client ID first (developer.spotify.com/dashboard)",
      note: st => st.product && st.product !== "premium" ? " (free plan: playback needs Premium)" : "",
    },
  };

  async function syncMusicService() {
    // iTunes and YouTube are built-in playback paths (adapter null).
    const ui = SVC_UI[S.musicService];
    if (!ui) { Music.setService(null); return; }
    try {
      const st = await ui.api().status();
      Music.setService(st.connected ? ui.adapter() : null);
    } catch (_) {
      Music.setService(null);
    }
  }

  function refreshServiceUi(prefix) {
    const selected = document.querySelector('input[name="' + prefix + '-music"]:checked');
    const want = selected && selected.value;
    for (const [name, ui] of Object.entries(SVC_UI)) {
      const row = $(prefix + "-" + name + "-row"), help = $(prefix + "-" + name + "-help");
      const status = $(prefix + "-" + name + "-status"), input = $(prefix + "-" + name + "-client");
      const disconnect = $(prefix + "-" + name + "-disconnect");
      if (!row) continue;
      const active = want === name;
      row.hidden = !active; if (help) help.hidden = !active;
      if (!active) continue;
      if (input && ui.clientKey && !input.value) input.value = S[ui.clientKey] || "";
      ui.api().status().then(st => {
        if (input && !input.value && st.clientId) input.value = st.clientId;
        if (status) {
          status.classList.toggle("ok", !!st.connected);
          status.textContent = st.connected
            ? "Connected" + (st.account ? " — " + st.account : "") + ui.note(st)
            : "Not connected";
        }
        if (disconnect) disconnect.hidden = !st.connected;
      }).catch(() => {
        if (status) { status.classList.remove("ok"); status.textContent = "Needs the desktop app or bridge.js"; }
        if (disconnect) disconnect.hidden = true;
      });
    }
  }

  let svcWatch = 0;
  // Poll until the sign-in lands (OAuth callback at the bridge, or the
  // Google window finishing), then refresh every service UI.
  function watchServiceConnect(ui) {
    clearInterval(svcWatch);
    const deadline = Date.now() + 120000;
    svcWatch = setInterval(async () => {
      if (Date.now() > deadline) { clearInterval(svcWatch); return; }
      try {
        const st = await ui.api().status();
        if (st.connected) {
          clearInterval(svcWatch);
          refreshServiceUi("wm"); refreshServiceUi("sm");
          syncMusicService();
        }
      } catch (_) {}
    }, 2500);
  }
  async function connectService(prefix, name) {
    const ui = SVC_UI[name];
    const input = $(prefix + "-" + name + "-client"), status = $(prefix + "-" + name + "-status");
    const clientId = ((input && input.value) || S[ui.clientKey] || "").trim();
    if (!clientId) {
      if (status) status.textContent = ui.hint;
      return;
    }
    try {
      const res = await ui.api().login(clientId);
      S[ui.clientKey] = clientId; saveSettings();
      if (status) status.textContent = "Approve in the browser… (Redirect URI: " + res.redirectUri + ")";
      window.open(res.url, "_blank");
      watchServiceConnect(ui);
    } catch (error) {
      if (status) status.textContent = String(error.message || error);
    }
  }

  function wireSpotifyRow(prefix) { // wires ALL service rows for this overlay
    document.querySelectorAll('input[name="' + prefix + '-music"]').forEach(radio =>
      radio.addEventListener("change", () => refreshServiceUi(prefix)));
    for (const name of Object.keys(SVC_UI)) {
      const connect = $(prefix + "-" + name + "-connect");
      if (connect) connect.addEventListener("click", () => connectService(prefix, name));
      const disconnect = $(prefix + "-" + name + "-disconnect");
      if (disconnect) disconnect.addEventListener("click", async () => {
        try { await SVC_UI[name].api().logout(); } catch (_) {}
        refreshServiceUi(prefix);
        syncMusicService();
      });
    }
  }
  const refreshSpotifyUi = refreshServiceUi; // existing call sites

  function smShowTab(name) {
    document.querySelectorAll("#sm-tabs .sm-tab").forEach(tab => {
      const active = tab.dataset.tab === name;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll("#settings-modern .sm-tab-panel").forEach(panel => {
      panel.hidden = panel.dataset.panel !== name;
    });
  }

  function mountClawMark(hostId) {
    const host = $(hostId);
    if (!host || host.firstChild) return;
    const clawMark = document.createElement("img");
    clawMark.className = "about-mark";
    clawMark.src = "assets/claw-mark.png";
    clawMark.alt = "";
    host.appendChild(clawMark);
  }
  /* About: the same white panel as Settings (it was a Win95 dialog). */
  let aboutWired = false;
  function openAbout() {
    const ov = $("about-modern");
    if (!ov) return;
    mountClawMark("am-icon");
    if (!aboutWired) {
      aboutWired = true;
      const close = () => { ov.hidden = true; };
      $("am-close").addEventListener("click", close);
      $("am-ok").addEventListener("click", close);
      document.addEventListener("keydown", e => { if (e.key === "Escape" && !ov.hidden) close(); });
      makeModernDraggable("about-modern");
    }
    resetModernDrag("about-modern");
    ov.hidden = false;
  }
  // "More details, legal & privacy" unfolds a scrollable panel in place
  // (no dialog); it starts folded on every open.
  const LEGAL_LINK_TEXT = "◈ More details, legal & privacy";
  function toggleLegalPanel(open) {
    const panel = $("sm-legal-panel"), link = $("sm-legal");
    if (!panel || !link) return;
    const show = open === undefined ? panel.hidden : !!open;
    panel.hidden = !show;
    link.textContent = show ? "◈ Hide details" : LEGAL_LINK_TEXT;
    link.setAttribute("aria-expanded", show ? "true" : "false");
    if (show) { panel.scrollTop = 0; panel.scrollIntoView({ block: "nearest" }); }
  }
  function openSettings() {
    const ov = $("settings-modern");
    if (!ov) return;
    smShowTab("model"); // always open on the first tab
    mountClawMark("sm-icon");
    toggleLegalPanel(false);
    const p = document.querySelector('input[name="sm-provider"][value="' + S.provider + '"]');
    if (p) p.checked = true;
    const wv = S.cliAccess === "workspace" ? "workspace" : "read-only";
    const w = document.querySelector('input[name="sm-workspace"][value="' + wv + '"]');
    if (w) w.checked = true;
    $("sm-shell").checked = S.cliShell === true;
    $("sm-shell").disabled = wv !== "workspace";
    $("sm-key-claude").value = S.keys.claude || "";
    $("sm-key-openai").value = S.keys.openai || "";
    $("sm-key-gemini").value = S.keys.gemini || "";
    $("sm-workspace-label").textContent = bridgeStatus.workspace || "Current App Folder";
    $("sm-choose-workspace").disabled = !window.claudeAmpDesktop;
    const m = document.querySelector('input[name="sm-music"][value="' + (S.musicService || "itunes") + '"]');
    if (m) m.checked = true;
    const z = document.querySelector('input[name="sm-zoom"][value="' + S.zoom + '"]');
    if (z) z.checked = true;
    const smSpotifyId = $("sm-spotify-client");
    if (smSpotifyId) smSpotifyId.value = S.spotifyClientId || "";
    refreshSpotifyUi("sm");
    renderSmInfo();
    if (!smWired) {
      smWired = true;
      document.querySelectorAll("#sm-tabs .sm-tab").forEach(tab =>
        tab.addEventListener("click", () => smShowTab(tab.dataset.tab)));
      wireSpotifyRow("sm");
      $("sm-close").addEventListener("click", closeSettings);
      $("sm-cancel").addEventListener("click", closeSettings);
      makeModernDraggable("settings-modern");
      $("sm-save").addEventListener("click", saveSettingsModern);
      $("sm-claude-login").addEventListener("click", openClaudeLogin);
      $("sm-codex-login").addEventListener("click", openCodexLogin);
      $("sm-refresh").addEventListener("click", () => refreshBridgeStatus(true).then(renderSmInfo).catch(() => {}));
      $("sm-legal").addEventListener("click", e => { e.preventDefault(); toggleLegalPanel(); });
      document.querySelectorAll('input[name="sm-workspace"]').forEach(r =>
        r.addEventListener("change", () => {
          $("sm-shell").disabled = r.value !== "workspace" || !r.checked;
        }));
      $("sm-choose-workspace").addEventListener("click", async () => {
        if (!window.claudeAmpDesktop) return;
        const selected = await window.claudeAmpDesktop.chooseWorkspace();
        if (selected) {
          bridgeStatus.workspace = selected;
          $("sm-workspace-label").textContent = selected;
          await refreshBridgeStatus(true);
          renderSmInfo();
        }
      });
      document.querySelectorAll("#settings-modern .eye").forEach(btn => {
        btn.addEventListener("click", () => {
          const input = btn.parentElement.querySelector("input");
          input.type = input.type === "password" ? "text" : "password";
        });
      });
      document.addEventListener("keydown", e => {
        if (e.key === "Escape" && !$("settings-modern").hidden) closeSettings();
      });
    }
    resetModernDrag("settings-modern");
    ov.hidden = false;
    refreshBridgeStatus(true).then(renderSmInfo).catch(() => {});
  }
  function closeSettings() { $("settings-modern").hidden = true; }
  function saveSettingsModern() {
    persistKey("claude", $("sm-key-claude").value.trim());
    persistKey("openai", $("sm-key-openai").value.trim());
    persistKey("gemini", $("sm-key-gemini").value.trim());
    const p = document.querySelector('input[name="sm-provider"]:checked');
    if (p) S.provider = p.value;
    const w = document.querySelector('input[name="sm-workspace"]:checked');
    S.cliAccess = w && w.value === "workspace" ? "workspace" : "read-only";
    S.cliShell = S.cliAccess === "workspace" && $("sm-shell").checked;
    syncAccessCeiling();
    const m = document.querySelector('input[name="sm-music"]:checked');
    if (m) S.musicService = m.value;
    const smSpotify = $("sm-spotify-client");
    if (smSpotify && smSpotify.value.trim()) S.spotifyClientId = smSpotify.value.trim();
    const z = document.querySelector('input[name="sm-zoom"]:checked');
    if (z && ZOOM_STEPS.includes(Number(z.value)) && Number(z.value) !== S.zoom) setZoom(Number(z.value));
    saveSettings();
    syncMusicService();
    closeSettings();
    drawEqFace(); drawInfo();
    renderChat();
  }

  /* ============================== presets ============================== */
  const PRESETS = [
    { name: "Flat",           set: { bands: Object.assign({}, FLAT_BANDS), balance: .5 } },
    { name: "Speed Demon",    set: { modelIndex: 3, bands: { EFF: .1, THK: 0, TOK: .25, VRB: .1 } } },
    { name: "Galaxy Model",   set: { modelIndex: 0, bands: { EFF: 1, THK: 1, TOK: .9, VRB: .8 } } },
    { name: "Corporate Rock", set: { bands: { FRM: 1, VRB: .6 }, balance: .2 } },
    { name: "3AM Poetry",     set: { bands: { VRB: .8, FRM: .1 }, balance: 1 } },
    { name: "Caffeinated",    set: { bands: { EFF: .3, VRB: .4 } } },
  ];
  function applyPreset(p) {
    releaseEqAuto();
    if (p.set.modelIndex !== undefined) S.modelIndex = p.set.modelIndex;
    if (p.set.balance !== undefined) S.balance = p.set.balance;
    Object.assign(S.bands, p.set.bands || {});
    positionEqThumbs(); drawEqFace(); drawEqGraph();
    balSlider.render();
    saveSettings();
    msgDiv("system", null, `[EQ preset: ${p.name.toUpperCase()}]`);
  }

  /* ============================ conversations ============================ */
  function switchConvo(i) {
    if (i < 0 || i >= convos.length || i === cur) return;
    stopStream();
    cur = i;
    renderChat(); saveConvos();
  }
  function newConvo() {
    stopStream();
    convos.push({ name: "Untitled Jam", msgs: [], turns: [], sessions: {} });
    cur = convos.length - 1;
    renderChat(); saveConvos();
  }
  function convMenu(x, y) {
    const items = convos.map((c, i) => ({
      label: (i + 1) + ". " + c.name + " (" + fmtTok(convoTokens(c)) + ")",
      checked: i === cur,
      fn: () => switchConvo(i),
    }));
    items.push("-",
      { label: "New conversation", fn: newConvo },
      { label: "Regenerate last reply", fn: regenerate },
      { label: "Clear this conversation", fn: () => {
          stopStream();
          convo().msgs = []; convo().turns = []; convo().sessions = {};
          saveConvos(); renderChat();
        } },
      { label: "Delete this conversation", fn: () => {
          stopStream();
          convos.splice(cur, 1);
          if (!convos.length) convos = [{ name: "Untitled Jam", msgs: [], turns: [], sessions: {} }];
          cur = Math.min(cur, convos.length - 1);
          saveConvos(); renderChat();
        } });
    openMenu(items, x, y);
  }

  /* ============================ wiring ============================ */
  function syncWinButtons() {
    $("btn-eq").classList.toggle("lit", WM.visible("win-eq"));
    $("btn-pl").classList.toggle("lit", WM.visible("win-pl"));
  }
  function setZoom(z) {
    S.zoom = z;
    $("desktop").style.setProperty("--zoom", z);
    // The desktop just changed size (layout width is viewport/zoom); pull
    // any panel the shrink stranded back inside the reachable area.
    WM.clampIntoDesktop();
    saveSettings();
  }

  // Advance this revision whenever the menu hint materially changes. The
  // earlier v1 dismissal survives in-place upgrades in Electron's userData;
  // v2 lets the corrected hint appear once without wiping user settings.
  const ONBOARDING_KEY = "claudeamp.onboarding.menu.v2";
  function dismissMenuOnboarding() {
    const tip = $("menu-onboarding");
    if (tip) tip.hidden = true;
    store.setRaw(ONBOARDING_KEY, "done");
  }
  // Point the tooltip at the hamburger with text suited to the chosen mode.
  // force=true shows it even if it was dismissed before (used right after a
  // fresh setup choice).
  function initMenuOnboarding(force) {
    const tip = $("menu-onboarding");
    const menu = document.querySelector("#win-main .tb-menu");
    if (!tip || !menu) return;
    if (!force && store.raw(ONBOARDING_KEY)) return;
    const shell = S.chatMode === "shell";
    tip.querySelector("strong").textContent = shell ? "YOU'RE ALL SET" : "START HERE";
    $("onboarding-text").textContent = "Open this menu to select options for ClaudeAmp.";
    tip.hidden = false;
    // The tip floats above the window with a caret pointing down at the
    // hamburger; if the window is too near the top of the desktop the tip
    // would clip off-screen, so nudge the whole dock group down to make room.
    const main = $("win-main");
    const requiredTop = tip.offsetHeight + 12;
    if (main.offsetTop < requiredTop)
      WM.moveDockGroup("win-main", 0, requiredTop - main.offsetTop, false);
    addPixelSparkles(tip);
    tip.querySelector(".onboarding-close").onclick = dismissMenuOnboarding;
    menu.addEventListener("click", dismissMenuOnboarding, { once: true });
  }

  let balSlider;
  function wire() {
    // transport = music
    $("t-play").addEventListener("click", () => Music.play());
    $("t-pause").addEventListener("click", () => {
      if (Music.mode === "paused") Music.play(); else Music.pause();
    });
    $("t-stop").addEventListener("click", () => Music.stop());
    $("t-prev").addEventListener("click", () => Music.prev());
    $("t-next").addEventListener("click", () => Music.next(false));
    $("t-eject").addEventListener("click", () => $("file-audio").click());
    $("btn-shuffle").addEventListener("click", () => {
      S.shuffle = !S.shuffle; Music.shuffle = S.shuffle;
      $("btn-shuffle").classList.toggle("on", S.shuffle);
      saveSettings();
    });
    $("btn-repeat").addEventListener("click", () => {
      S.repeat = !S.repeat; Music.repeat = S.repeat;
      $("btn-repeat").classList.toggle("on", S.repeat);
      saveSettings();
    });
    $("btn-shuffle").classList.toggle("on", S.shuffle);
    $("btn-repeat").classList.toggle("on", S.repeat);
    Music.shuffle = S.shuffle; Music.repeat = S.repeat;

    $("btn-eq").addEventListener("click", () => { WM.toggle("win-eq"); syncWinButtons(); });
    $("btn-pl").addEventListener("click", () => { WM.toggle("win-pl"); syncWinButtons(); });

    document.querySelectorAll(".wa-window").forEach(w => {
      const close = w.querySelector(".tb-close");
      const min = w.querySelector(".tb-min");
      const shade = w.querySelector(".tb-shade");
      if (close) close.addEventListener("click", () => {
        if (w.id === "win-main" && window.claudeAmpDesktop) window.claudeAmpDesktop.close();
        else if (w.id === "win-term" && S.chatMode === "shell") setChatMode("chat");
        else { WM.toggle(w.id, false); syncWinButtons(); }
      });
      if (min) min.addEventListener("click", () => {
        if (w.id === "win-main" && window.claudeAmpDesktop) window.claudeAmpDesktop.minimize();
        else { WM.toggle(w.id, false); syncWinButtons(); }
      });
      if (shade) shade.addEventListener("click", () => {
        WM.toggleShade(w.id);
      });
    });
    document.querySelectorAll(".tb-menu").forEach(m =>
      m.addEventListener("click", e => mainMenu(e.clientX, e.clientY)));

    $("clutterbar").addEventListener("click", e => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === "options") openSettings();
      else if (act === "about") openAbout();
      else if (act === "info") { S.lcdMode = S.lcdMode === "time" ? "tokens" : "time"; saveSettings(); }
      else if (act === "double") setZoom(S.zoom > 1 ? 1 : 2);
      else if (act === "viz") WM.toggle("win-usage");
    });

    $("cv-vis").addEventListener("click", () => {
      S.visMode = (S.visMode + 1) % 3; saveSettings();
    });
    $("cv-time").addEventListener("click", () => {
      S.lcdMode = S.lcdMode === "time" ? "tokens" : "time"; saveSettings();
    });

    // volume drives the YouTube player; balance pans the AI's brain
    attachHSlider($("sl-volume"),
      () => S.volume, v => { S.volume = v; Music.setVolume(v); },
      v => `hsl(${100 - v * 100},85%,45%)`);
    balSlider = attachHSlider($("sl-balance"),
      () => S.balance, v => { S.balance = v; },
      () => "#2CA81E");
    Music.setVolume(S.volume);

    // seek bar drags the current track
    const seekEl = $("sl-seek");
    let seeking = false;
    const seekApply = e => {
      const r = seekEl.getBoundingClientRect();
      const z = WM.zoomFactor();
      const x = (e.clientX - r.left) / z - 14;
      seekDrag = Math.max(0, Math.min(1, x / (246 - 29)));
    };
    seekEl.addEventListener("pointerdown", e => {
      seeking = true; seekEl.setPointerCapture(e.pointerId); seekApply(e); e.preventDefault();
    });
    seekEl.addEventListener("pointermove", e => { if (seeking) seekApply(e); });
    const seekUp = () => {
      if (!seeking) return;
      seeking = false;
      if (seekDrag !== null) {
        const target = seekDrag;
        Music.seekTo(target);
        // Keep the thumb pinned at the target until playback actually gets
        // there; otherwise it snaps back to the old spot while YouTube seeks,
        // then jumps forward - the "snap back then land" the user saw.
        seekSettle = { target, until: performance.now() + 1800 };
      }
      seekDrag = null;
    };
    seekEl.addEventListener("pointerup", seekUp);
    seekEl.addEventListener("pointercancel", seekUp);

    // EQ buttons
    $("eq-on").classList.toggle("lit", S.eqOn);
    $("eq-on").addEventListener("click", () => {
      S.eqOn = !S.eqOn;
      $("eq-on").classList.toggle("lit", S.eqOn);
      saveSettings();
    });
    // AUTO latches: flattens the EQ and stays lit until a band is touched.
    $("eq-auto").classList.toggle("lit", S.eqAuto);
    $("eq-auto").addEventListener("click", () => {
      S.eqAuto = !S.eqAuto;
      if (S.eqAuto) {
        eqAutoHold = true;
        applyPreset(PRESETS[0]);
        eqAutoHold = false;
      }
      $("eq-auto").classList.toggle("lit", S.eqAuto);
      saveSettings();
    });
    $("eq-presets").addEventListener("click", e => {
      openMenu(PRESETS.map(p => ({ label: p.name, fn: () => applyPreset(p) })),
        e.clientX, e.clientY);
    });

    // playlist buttons (music); the video filter now lives in the VIDEO
    // dropdown (fx-pick) as Video vs Video (HD)
    const searchSource = $("music-search-source");
    const savedSearchSource = store.raw("claudeamp.search-source");
    if (["apple", "youtube", "spotify"].includes(savedSearchSource)) searchSource.value = savedSearchSource;
    $("yt-search-form").addEventListener("submit", event => { event.preventDefault(); searchMusic(); });
    $("mb-reset-button").addEventListener("click", () => resetMusicSearch());
    searchSource.addEventListener("change", () => {
      musicSearchGeneration++;
      store.setRaw("claudeamp.search-source", searchSource.value);
      setMusicResultsVisible(false);
      $("mb-note").textContent = "search source: " +
        (searchSource.value === "apple" ? "itunes previews" : searchSource.value);
    });
    $("yt-search-input").addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        resetMusicSearch();
      }
    });

    const renameTrackInline = i => {
      if (i < 0 || i >= Music.tracks.length) return;
      const li = plList.children[i];
      if (!li) return;
      const name = li.querySelector(".name");
      const input = document.createElement("input");
      input.value = Music.tracks[i].title;
      input.className = "pl-rename";
      name.replaceWith(input);
      input.focus(); input.select();
      // clicks inside the edit box must not bubble to the row (its click
      // handler re-renders the list and would destroy the input mid-edit)
      for (const ev of ["click", "dblclick", "pointerdown"])
        input.addEventListener(ev, e => e.stopPropagation());
      const commit = () => {
        Music.renameTrack(i, input.value.trim());
        renderPlaylist(); // re-render even when the title was rejected
      };
      input.addEventListener("keydown", ev => {
        if (ev.key === "Enter") commit();
        if (ev.key === "Escape") renderPlaylist();
      });
      input.addEventListener("blur", commit);
    };

    $("pl-add").addEventListener("click", () => buttonMenu($("pl-add"), [
      { label: "Add File(s)...", fn: () => $("file-audio").click() },
      { label: "Add Folder...", fn: () => $("file-folder").click() },
      { label: "Add URL / Stream...", fn: openAddTrack },
      { label: "Search for a Song...", fn: () => { WM.toggle("win-mb", true); $("yt-search-input").focus(); } },
      "-",
      { label: "Load Playlist File...", fn: () => $("file-playlist").click() },
    ]));
    $("pl-rem").addEventListener("click", () => buttonMenu($("pl-rem"), [
      { label: "Remove Selected", disabled: !selected.size, fn: () => {
          Music.removeTracks(selectionIndices()); clearSelection(); renderPlaylist();
        } },
      { label: "Remove Missing", disabled: !Music.tracks.some(track => track.type === "missing"), fn: () => {
          Music.removeTracks(Music.tracks.map((track, i) => track.type === "missing" ? i : -1));
          clearSelection(); renderPlaylist();
        } },
      { label: "Crop to Selection", disabled: !selected.size, fn: () => {
          Music.cropTo(selectionIndices()); clearSelection(); renderPlaylist();
        } },
      "-",
      { label: "Clear Playlist", disabled: !Music.tracks.length, fn: () => {
          Music.replaceTracks([], Music.activeName); clearSelection();
        } },
    ]));
    $("pl-sel").addEventListener("click", () => buttonMenu($("pl-sel"), [
      { label: "Select All", disabled: !Music.tracks.length, fn: () => {
          selected.clear(); Music.tracks.forEach((_, i) => selected.add(i)); renderPlaylist();
        } },
      { label: "Select None", disabled: !selected.size, fn: () => { clearSelection(); renderPlaylist(); } },
      { label: "Invert Selection", disabled: !Music.tracks.length, fn: () => {
          const old = new Set(selected); selected.clear();
          Music.tracks.forEach((_, i) => { if (!old.has(i)) selected.add(i); }); renderPlaylist();
        } },
      "-",
      { label: "Jump to Track...", disabled: !Music.tracks.length, fn: openJump },
      { label: "Rename Selected", disabled: selected.size !== 1,
        fn: () => renameTrackInline(selectionIndices()[0]) },
    ]));
    function runEmbedCheck() {
      const rep = $("embed-report");
      const dlg = $("dlg-embed");
      dlg.hidden = false; dlg.style.zIndex = 2000;
      Music.stop();
      const fmt = t => t.n + ". " + t.title.toUpperCase() + "  [" + t.reason + "]  id=" + t.id;
      rep.textContent = "CHECKING...";
      Music.checkEmbeds(st => {
        if (st.error) { rep.textContent = "CHECK FAILED: " + st.error.toUpperCase(); return; }
        if (!st.done) {
          rep.textContent = "CHECKING " + (st.i + 1) + "/" + st.total + "\n" + st.title.toUpperCase();
          return;
        }
        rep.textContent = st.blocked.length
          ? "UNPLAYABLE YOUTUBE TRACKS (" + st.blocked.length + "/" + st.tested + " TESTED):\n\n"
            + st.blocked.map(fmt).join("\n")
          : "ALL " + st.tested + " YOUTUBE TRACKS EMBEDDABLE. NICE.";
      });
    }
    $("embed-copy").addEventListener("click", () => {
      try { navigator.clipboard.writeText($("embed-report").textContent); } catch (_) {}
    });
    // RADIO: load a 90s station's top-100 as the active playlist. Tracks
    // resolve to their lowest-view YouTube upload the first time they play.
    const loadRadioStation = station => {
      clearSelection();
      Music.replaceTracks(station.tracks.map(song => ({
        type: "radio",
        title: song.a + " - " + song.t,
        query: song.a + " " + song.t,
        station: station.call,
      })), station.call + " 90s");
      msgDiv("system", null, "[RADIO] TUNED TO " + station.call + " - " + station.name +
        " (" + station.tracks.length + " TRACKS). PRESS PLAY; EACH SONG FINDS A " +
        "PLAYABLE OFFICIAL YOUTUBE VERSION WHEN IT COMES ON.");
    };
    $("pl-radio").addEventListener("click", () => {
      const stations = window.RADIO_STATIONS || [];
      buttonMenu($("pl-radio"), stations.length ? stations.map(station => ({
        label: station.call + " : " + (station.format || station.name),
        fn: () => loadRadioStation(station),
      })) : [{ label: "Stations are being tuned in - try again shortly", disabled: true, fn: () => {} }]);
    });
    const miscItems = () => [
      { label: "New Playlist...", fn: () => openPlaylistName("new") },
      { label: "Save Playlist As...", fn: () => openPlaylistName("save") },
      { label: "Saved Playlists...", fn: openSavedPlaylists },
      "-",
      { label: "Import M3U / PLS / JSON...", fn: () => $("file-playlist").click() },
      { label: "Export M3U8", disabled: !Music.tracks.length, fn: () => exportPlaylist("m3u") },
      { label: "Export PLS", disabled: !Music.tracks.length, fn: () => exportPlaylist("pls") },
      { label: "Export ClaudeAmp JSON", disabled: !Music.tracks.length, fn: () => exportPlaylist("json") },
      "-",
      { label: "Sort by Title", disabled: Music.tracks.length < 2, fn: () => {
          clearSelection(); Music.sortTracks("title");
        } },
      { label: "Sort by Filename", disabled: Music.tracks.length < 2, fn: () => {
          clearSelection(); Music.sortTracks("file");
        } },
      { label: "Sort by Duration", disabled: Music.tracks.length < 2, fn: () => {
          clearSelection(); Music.sortTracks("duration");
        } },
      { label: "Randomize Order", disabled: Music.tracks.length < 2, fn: () => {
          clearSelection(); Music.randomizeTracks();
        } },
      "-",
      { label: "Reset ClaudeAmp 90s Playlist", fn: () => { clearSelection(); Music.resetTracks(); } },
      { label: "Relink To Official Uploads", disabled: !Music.tracks.length, fn: () => Music.retuneAll() },
      { label: "Check YouTube Embeds", fn: runEmbedCheck },
      { label: "Toggle Shuffle", checked: S.shuffle, fn: () => $("btn-shuffle").click() },
      { label: "Toggle Repeat", checked: S.repeat, fn: () => $("btn-repeat").click() },
    ];
    $("pl-misc").addEventListener("click", () => buttonMenu($("pl-misc"), miscItems()));
    $("pl-menu").addEventListener("click", () => buttonMenu($("pl-menu"), miscItems()));

    document.querySelectorAll(".pl-mini button").forEach(button =>
      button.addEventListener("click", () => {
        const act = button.dataset.m;
        if (act === "play") Music.play();
        else if (act === "pause") { if (Music.mode === "paused") Music.play(); else Music.pause(); }
        else if (act === "stop") Music.stop();
        else if (act === "prev") Music.prev();
        else if (act === "next") Music.next(false);
        else if (act === "eject") $("file-audio").click();
      }));

    $("file-audio").addEventListener("change", async event => {
      await importLocalFiles(event.target.files); event.target.value = "";
    });
    $("file-folder").addEventListener("change", async event => {
      await importLocalFiles(event.target.files); event.target.value = "";
    });
    $("file-playlist").addEventListener("change", async event => {
      await importPlaylistFiles(event.target.files); event.target.value = "";
    });

    const playlistFrame = $("win-pl").querySelector(".pl-frame");
    playlistFrame.addEventListener("dragenter", event => {
      if (Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); playlistFrame.classList.add("drop-target"); }
    });
    playlistFrame.addEventListener("dragover", event => {
      if (Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }
    });
    playlistFrame.addEventListener("dragleave", event => {
      if (!playlistFrame.contains(event.relatedTarget)) playlistFrame.classList.remove("drop-target");
    });
    playlistFrame.addEventListener("drop", async event => {
      if (!event.dataTransfer.files.length) return;
      event.preventDefault(); playlistFrame.classList.remove("drop-target");
      const files = Array.from(event.dataTransfer.files);
      if (files.some(MediaLibrary.isPlaylistFile)) await importPlaylistFiles(files);
      else await importLocalFiles(files);
    });

    $("playlist-name-ok").addEventListener("click", () => {
      const name = $("playlist-name").value.trim();
      if (!name) { $("playlist-name").focus(); return; }
      if (playlistNameMode === "new") Music.newPlaylist(name);
      else Music.savePlaylist(name);
      $("dlg-playlist-name").hidden = true;
    });
    $("playlist-name").addEventListener("keydown", event => {
      if (event.key === "Enter") $("playlist-name-ok").click();
    });
    $("playlist-load").addEventListener("click", () => {
      if (savedSelected && Music.loadPlaylist(savedSelected)) {
        clearSelection(); $("dlg-playlists").hidden = true;
      }
    });
    $("playlist-delete").addEventListener("click", () => {
      if (savedSelected) { Music.deletePlaylist(savedSelected); savedSelected = ""; renderSavedPlaylists(); }
    });
    $("jump-query").addEventListener("input", renderJumpResults);
    $("jump-query").addEventListener("keydown", event => {
      if (event.key === "Enter" && jumpSelected >= 0) $("jump-play").click();
    });
    $("jump-play").addEventListener("click", () => {
      if (jumpSelected >= 0) { Music.playTrack(jumpSelected); $("dlg-jump").hidden = true; }
    });

    // add-URL dialog
    $("track-ok").addEventListener("click", () => {
      const ok = Music.addTrack($("track-url").value, $("track-title").value);
      if (ok) {
        $("dlg-addtrack").hidden = true;
        $("track-url").value = ""; $("track-title").value = "";
      } else {
        $("track-url").select();
      }
    });

    // Classic transport keys. Inputs keep their native editing behavior.
    document.addEventListener("keydown", event => {
      if (event.target.closest("input, textarea, select") || event.altKey || event.metaKey) return;
      const key = event.key.toLowerCase();
      if (event.ctrlKey && key === "o") { event.preventDefault(); $("file-audio").click(); return; }
      if (event.ctrlKey && event.shiftKey && key === "s") { event.preventDefault(); openPlaylistName("save"); return; }
      if (event.ctrlKey) return;
      if (key === "z") Music.prev();
      else if (key === "x") Music.play();
      else if (key === "c") Music.pause();
      else if (key === "v") Music.stop();
      else if (key === "b") Music.next(false);
      else if (key === "j") openJump();
      else if (key === "l") openAddTrack();
      else if (event.key === "Delete" && selected.size) {
        Music.removeTracks(selectionIndices()); clearSelection(); renderPlaylist();
      } else if (event.key === "F1") openAbout();
    });

    // chat
    const doSend = () => {
      if (chatBusy) return;
      const v = chatInput.value;
      if (!v.trim() && !chatImages.length) return;
      const command = v.trim().toLowerCase();
      if (["/clear", "/new"].includes(command)) {
        chatInput.value = "";
        const c = convo();
        c.msgs = []; c.turns = []; c.sessions = {};
        chatImages = [];
        renderChatAttachments();
        renderChat();
        saveConvos();
        return;
      }
      if (["/login", "/claude-login", "/codex-login", "claude login", "codex login"].includes(command)) {
        chatInput.value = "";
        if (["/codex-login", "codex login"].includes(command) ||
            (command === "/login" && S.provider === "codex-cli"))
          openCodexLogin();
        else
          openClaudeLogin();
        return;
      }
      if (demoMode()) { showBrainSetupGuide(); return; }
      chatInput.value = "";
      const imgs = chatImages;
      chatImages = [];
      renderChatAttachments();
      sendMessage(v, imgs);
    };
    chatInput.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }  // Shift+Enter = newline
      else if (e.key === "Escape") stopStream();
    });
    chatInput.addEventListener("paste", e => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      let grabbed = false;
      for (const it of items) {
        if (it.kind === "file" && /^image\//.test(it.type)) {
          const file = it.getAsFile();
          if (file) { addChatImage(file); grabbed = true; }
        }
      }
      if (grabbed) e.preventDefault();   // keep the binary out of the text box
    });
    $("chat-send").addEventListener("click", doSend);
    $("chat-stop").addEventListener("click", stopStream);
    $("chat-conv").addEventListener("click", e => convMenu(e.clientX, e.clientY));
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && chatBusy) stopStream();
    });
  }

  function openAddTrack() {
    $("dlg-addtrack").hidden = false;
    $("dlg-addtrack").style.zIndex = 2000;
    $("track-url").focus();
  }

  /* ============================ seek + status ============================ */
  const seekThumb = document.querySelector("#sl-seek .hslider-thumb");
  function drawSeek() {
    let p = 0;
    if (seekDrag !== null) { p = seekDrag; seekSettle = null; }
    else {
      const musicActive = ["playing", "paused", "loading"].includes(Music.mode);
      if (musicActive) {
        const { t, d } = Music.time();
        const actual = d ? t / d : 0;
        if (seekSettle) {
          // Hold at the requested spot until the player catches up (within 2%)
          // or the grace window ends, so release doesn't flash back-then-jump.
          if (performance.now() > seekSettle.until ||
              Math.abs(actual - seekSettle.target) < 0.02) {
            p = actual; seekSettle = null;
          } else p = seekSettle.target;
        } else p = actual;
      } else {
        seekSettle = null;
        if (liveTurn && maxTokensReq) p = Math.min(1, (liveTurn.out || 0) / maxTokensReq);
      }
    }
    seekThumb.style.left = Math.round(p * (246 - 29)) + "px";
  }
  function drawPlaystate() {
    const m = Music.mode;
    const cls = m === "playing" || m === "loading" ? "play"
      : m === "paused" ? "pause"
      : chatBusy ? "play" : "stop";
    const ps = $("playstate");
    const want = "playstate " + cls;
    if (ps.className !== want) ps.className = want;
  }

  /* ------------------- minibrowser pixel FX visualizer -------------------
     The retro effects render at 152x84 and stretch with image-rendering:
     pixelated. Rain instead tracks the visible stage at a fixed backing
     density, so resizing reveals more fixed-size glyphs without distorting
     them. All effects use the energy that drives the spectrum bars. */
  const FX_MODES = ["PLASMA", "FIRE", "SNAKE", "STARS", "SCOPE", "RAIN"];
  const FXW = 152, FXH = 84;
  // Four backing pixels per logical CSS pixel keeps rain glyphs detailed and
  // gives both canvas axes the same scale at every visualization-window size.
  const RAIN_SCALE = 4;
  const fxCanvas = $("fx-canvas");
  const fxCtx = fxCanvas.getContext("2d", { willReadFrequently: false });
  const fxImage = fxCtx.createImageData(FXW, FXH);
  let fxT = 0, fxLastMode = -1;
  // Integrated phases: multiplying ACCUMULATED time by a varying energy
  // factor rescales the whole field whenever the music moves (that was the
  // plasma jerk). Integrating speed keeps the phase continuous.
  let fxPlasmaT = 0, fxSmoothEnergy = 0;

  /* ---- SNAKE: a playable game living in the visualization window (replaces
     the tunnel FX). Rendered on a high-res, smoothly-scaled backing so the
     grid and the corner HUD stay crisp. Arrow keys steer it (wired below). */
  const SNAKE_COLS = 25, SNAKE_ROWS = 15, SNAKE_CELL = 24;
  const SNAKEW = SNAKE_COLS * SNAKE_CELL, SNAKEH = SNAKE_ROWS * SNAKE_CELL;
  let snake = null, snakeBest = 0, snakeLastT = 0;
  function snakeFood(body) {
    let f;
    do { f = { x: (Math.random() * SNAKE_COLS) | 0, y: (Math.random() * SNAKE_ROWS) | 0 }; }
    while (body.some(s => s.x === f.x && s.y === f.y));
    return f;
  }
  function snakeReset() {
    const cy = SNAKE_ROWS >> 1;
    const body = [{ x: 6, y: cy }, { x: 5, y: cy }, { x: 4, y: cy }];
    snake = { body, dir: { x: 1, y: 0 }, queued: { x: 1, y: 0 },
      food: snakeFood(body), score: 0, level: 1, acc: 0, over: false, started: false };
  }
  function snakeSetDir(dx, dy) {
    if (!snake) snakeReset();
    if (snake.over) { snakeReset(); snake.started = true; return; } // any arrow restarts
    // ignore a 180° reversal into the neck
    if (snake.dir.x === -dx && snake.dir.y === -dy) return;
    snake.queued = { x: dx, y: dy };
    snake.started = true;
  }
  function snakeStep() {
    snake.dir = snake.queued;
    const head = { x: snake.body[0].x + snake.dir.x, y: snake.body[0].y + snake.dir.y };
    if (head.x < 0 || head.x >= SNAKE_COLS || head.y < 0 || head.y >= SNAKE_ROWS ||
        snake.body.some(s => s.x === head.x && s.y === head.y)) {
      snake.over = true;
      if (snake.score > snakeBest) snakeBest = snake.score;
      return;
    }
    snake.body.unshift(head);
    if (head.x === snake.food.x && head.y === snake.food.y) {
      snake.score += 10;
      snake.level = 1 + Math.floor(snake.score / 50); // level up every 5 apples
      snake.food = snakeFood(snake.body);
    } else {
      snake.body.pop();
    }
  }
  function snakeCenter(ctx, lines, big) {
    ctx.save();
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(0,0,0,0.72)";
    ctx.fillRect(0, SNAKEH / 2 - 46, SNAKEW, 92);
    lines.forEach((ln, i) => {
      ctx.fillStyle = i === 0 ? "#00FF00" : "#c8ffc8";
      ctx.font = (i === 0 ? (big || 30) : 15) + "px 'AmpDot', 'Courier New', monospace";
      ctx.fillText(ln, SNAKEW / 2, SNAKEH / 2 - 20 + i * 28);
    });
    ctx.restore();
  }
  function snakeGame() {
    if (!snake) snakeReset();
    const now = performance.now();
    const dt = snakeLastT ? Math.min(0.1, (now - snakeLastT) / 1000) : 0;
    snakeLastT = now;
    const ctx = fxCtx, cell = SNAKE_CELL;
    ctx.fillStyle = "#000305"; ctx.fillRect(0, 0, SNAKEW, SNAKEH);
    // faint grid
    ctx.strokeStyle = "rgba(0,70,0,0.35)"; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= SNAKE_COLS; x++) { ctx.moveTo(x * cell, 0); ctx.lineTo(x * cell, SNAKEH); }
    for (let y = 0; y <= SNAKE_ROWS; y++) { ctx.moveTo(0, y * cell); ctx.lineTo(SNAKEW, y * cell); }
    ctx.stroke();
    // advance the game
    if (snake.started && !snake.over) {
      snake.acc += dt;
      const interval = Math.max(0.06, 0.20 - (snake.level - 1) * 0.014); // faster each level
      let guard = 8;
      while (snake.acc >= interval && guard-- > 0) { snake.acc -= interval; snakeStep(); if (snake.over) break; }
    }
    // target dot: the brightest green, glowing and pulsing
    const pulse = 0.5 + 0.5 * Math.sin(now / 240);      // 0..1 breathing cycle
    const fx = snake.food.x * cell + cell / 2;
    const fy = snake.food.y * cell + cell / 2;
    const fr = (cell - 8) / 2 + pulse * 2;               // radius pulses slightly
    const lift = Math.round(pulse * 150);                // brightness pulses
    ctx.save();
    ctx.shadowColor = "#66ff33";
    ctx.shadowBlur = 14 + pulse * 22;                    // glowing halo pulses
    ctx.fillStyle = "rgb(" + (90 + lift) + ",255," + (60 + lift) + ")";
    ctx.beginPath();
    ctx.arc(fx, fy, fr, 0, Math.PI * 2);
    ctx.fill();
    ctx.fill();                                          // second pass intensifies glow
    ctx.restore();
    // snake body (head brightest)
    for (let i = 0; i < snake.body.length; i++) {
      const s = snake.body[i];
      ctx.fillStyle = i === 0 ? "#d8ffd8" : "#00FF00";
      ctx.fillRect(s.x * cell + 1, s.y * cell + 1, cell - 2, cell - 2);
    }
    // corner HUD - only SCORE (top-left) and LEVEL (top-right), skin font
    ctx.fillStyle = "#00FF00";
    ctx.font = "18px 'AmpDot', 'Courier New', monospace";
    ctx.textBaseline = "top"; ctx.textAlign = "left";
    ctx.fillText("SCORE " + snake.score, 8, 6);
    ctx.textAlign = "right";
    ctx.fillText("LEVEL " + snake.level, SNAKEW - 8, 6);
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    // overlays
    if (!snake.started) snakeCenter(ctx, ["SNAKE", "PRESS AN ARROW KEY TO START"]);
    else if (snake.over) snakeCenter(ctx, ["GAME OVER", "SCORE " + snake.score + "   PRESS AN ARROW KEY"]);
  }
  const fxEnergy = () => {
    let sum = 0;
    for (let i = 0; i < 19; i++) sum += bars[i];
    return Math.min(1, sum / (19 * 12)) + (chatBusy || Music.mode === "playing" ? 0.15 : 0.02);
  };

  // shared rainbow + ember palettes (256 x rgb)
  const fxPal = new Uint8Array(256 * 3), fxEmber = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const a = i / 256 * Math.PI * 2;
    fxPal[i * 3] = 128 + 127 * Math.sin(a);
    fxPal[i * 3 + 1] = 128 + 127 * Math.sin(a + 2.094);
    fxPal[i * 3 + 2] = 128 + 127 * Math.sin(a + 4.188);
    const heat = i / 255;
    fxEmber[i * 3] = Math.min(255, heat * 3 * 255);
    fxEmber[i * 3 + 1] = Math.max(0, Math.min(255, (heat - 0.33) * 3 * 255));
    fxEmber[i * 3 + 2] = Math.max(0, Math.min(255, (heat - 0.75) * 4 * 255));
  }
  // distance/angle lookups for plasma + tunnel
  const fxDist = new Float32Array(FXW * FXH), fxAng = new Float32Array(FXW * FXH);
  for (let y = 0; y < FXH; y++) for (let x = 0; x < FXW; x++) {
    const dx = x - FXW / 2, dy = y - FXH / 2, i = y * FXW + x;
    fxDist[i] = Math.sqrt(dx * dx + dy * dy);
    fxAng[i] = Math.atan2(dy, dx);
  }
  const fxFire = new Uint8Array(FXW * (FXH + 2));
  const fxStars = Array.from({ length: 90 }, () => ({
    x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random() * 0.9 + 0.1 }));

  /* RAIN: the Smythe glyph-rain screensaver (github.com/petehottelet/smythe)
     with 192 procedural cyber glyphs, per-glyph speeds/trails,
     persistence-fade trails and glowing heads. */
  let rainState = null;
  // weight scales the stroke width (and dot radius) of the glyph data.
  function rainGlyphPath(ctx, index, ox, oy, glyphH, color, weight = 1) {
    const [cw, ch] = GLYPHS.canvas;
    const sx = glyphH * cw / ch / cw, sy = glyphH / ch;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of GLYPHS.strokes[index]) {
      if (s[0] === "d") {
        ctx.beginPath();
        ctx.arc(ox + s[1] * sx, oy + s[2] * sy, Math.max(0.5, s[3] * sx * weight), 0, 7);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.lineWidth = Math.max(0.9, s[s.length - 1] * sx * weight);
      ctx.moveTo(ox + s[1] * sx, oy + s[2] * sy);
      if (s[0] === "l") ctx.lineTo(ox + s[3] * sx, oy + s[4] * sy);
      else ctx.quadraticCurveTo(ox + s[3] * sx, oy + s[4] * sy, ox + s[5] * sx, oy + s[6] * sy);
      ctx.stroke();
    }
  }
  function buildRain(previous = null) {
    if (typeof GLYPHS === "undefined") { rainState = null; return; } // glyph data missing: draw nothing
    // The backing follows the stage at exactly RAIN_SCALE on both axes. Cells
    // therefore remain six logical pixels tall regardless of the window's
    // aspect ratio; a larger stage gets more backing pixels and more lanes.
    // 1.5x the 1.5.1 glyph size at the owner's request (6 -> 9 logical px
    // cells); everything else about the rain stays the 1.5.1 original.
    const cell = 9 * RAIN_SCALE, pad = 5 * RAIN_SCALE;
    const W = fxCanvas.width, H = fxCanvas.height;
    const gw = cell * GLYPHS.canvas[0] / GLYPHS.canvas[1];
    const size = { w: Math.ceil(gw) + pad * 2, h: cell + pad * 2 };
    const count = GLYPHS.strokes.length;
    // Pre-render every glyph twice (trail stamp + glowing head) so the
    // frame loop stays at drawImage calls, exactly like the original.
    // Greens keyed to the playlist window's text green (--pl-green #00FF00):
    // a solid green trail, a full #00FF00 head with matching glow, and a
    // pale-green (not blue-white) highlight so the leading glyph still pops.
    // Owner change on top of the 1.5.1 look: the trail stamp is drawn at
    // 1.8x stroke weight in near-full green so every glyph in a drip reads
    // as a filled green character. The original's thin rgb(0,150,0) strokes
    // came out as black outlines once the 1.5x cells were scaled onto the
    // screen.
    const trail = previous?.trail?.length === count ? previous.trail : [];
    const head = previous?.head?.length === count ? previous.head : [];
    if (!trail.length || !head.length) {
      trail.length = 0; head.length = 0;
      for (let g = 0; g < count; g++) {
        let c = document.createElement("canvas");
        c.width = size.w; c.height = size.h;
        let ctx = c.getContext("2d");
        rainGlyphPath(ctx, g, pad, pad, cell, "rgb(0,230,0)", 1.8);
        trail.push(c);
        c = document.createElement("canvas");
        c.width = size.w; c.height = size.h;
        ctx = c.getContext("2d");
        ctx.shadowColor = "rgba(0,255,0,.95)";
        ctx.shadowBlur = cell * 0.42;
        rainGlyphPath(ctx, g, pad, pad, cell, "#00FF00");
        ctx.shadowColor = "rgba(140,255,140,.9)";
        ctx.shadowBlur = cell * 0.15;
        rainGlyphPath(ctx, g, pad, pad, cell, "#c8ffc8");
        head.push(c);
      }
    }
    const stepX = Math.max(2, Math.round(cell * 0.52));
    const stepY = Math.round(cell * 1.04);
    const lanes = Math.ceil(W / stepX) + 1;
    const targetCount = lanes * 2;
    const columns = previous ? previous.columns
      .filter(column => column.x < W + stepX).slice(0, targetCount) : [];
    while (columns.length < targetCount) {
      const i = columns.length;
      const g = (Math.random() * count) | 0;
      columns.push({
        x: previous ? Math.random() * (W + stepX) :
          (i * stepX) % (W + stepX) + (((Math.random() * 5 - 2) * RAIN_SCALE) | 0),
        glyph: g,
        phase: (Math.random() * count) | 0,
        y: ((Math.random() * 2.2 - 1.2) * H) | 0,
        rate: GLYPHS.speeds[g] * 5.6, // cells/second, as in the original
        burst: 0,
        acc: Math.random(),
      });
    }
    rainState = { trail, head, pad, stepY, columns, count, W, H };
  }
  function rainFx(energy) {
    if (typeof GLYPHS === "undefined") return; // glyph data missing: draw nothing
    if (!rainState) buildRain();
    if (!rainState) return;
    const { trail, head, pad, stepY, columns, count, W, H } = rainState;
    // persistence: last frame's heads dim slowly into long trails (full
    // canvas). 0.016/frame (the 1.5.1 original was 0.034) keeps the glyphs
    // behind the head green for the length of a drip instead of letting
    // them go black a few cells back.
    fxCtx.fillStyle = "rgba(0,0,0,0.016)";
    fxCtx.fillRect(0, 0, W, H);
    const dt = 1 / 60;
    const pace = 1 + energy * 0.25; // original speed, swaying a touch with the music
    for (const col of columns) {
      col.acc += dt * col.rate * (col.burst > 0 ? 1.9 : 1) * pace;
      if (col.burst > 0) col.burst -= dt;
      while (col.acc >= 1) {
        col.acc -= 1;
        fxCtx.globalAlpha = 1;
        fxCtx.drawImage(trail[(col.glyph + col.phase) % count], col.x - pad, col.y - pad);
        col.y += stepY;
        col.phase = (col.phase + 7) % count;
        const past = col.y - GLYPHS.trails[col.glyph] * stepY * 1.15;
        if (past > H && Math.random() < 0.6) {
          col.y = -stepY * ((Math.random() * 7) | 0);
          col.glyph = (Math.random() * count) | 0;
          col.rate = GLYPHS.speeds[col.glyph] * 5.6;
          if (Math.random() < 0.06) col.burst = 1.6;
        }
      }
      if (col.y > -stepY && col.y < H + stepY) {
        fxCtx.globalAlpha = col.burst > 0 ? 1 : 0.92;
        fxCtx.drawImage(head[(col.glyph + col.phase) % count], col.x - pad, col.y - pad);
      }
    }
    fxCtx.globalAlpha = 1;
  }

  function fxPaint(indexAt, palette) {
    const data = fxImage.data;
    for (let i = 0, p = 0; i < FXW * FXH; i++, p += 4) {
      const c = indexAt(i) & 255;
      data[p] = palette[c * 3];
      data[p + 1] = palette[c * 3 + 1];
      data[p + 2] = palette[c * 3 + 2];
      data[p + 3] = 255;
    }
    fxCtx.putImageData(fxImage, 0, 0);
  }
  function fxFade(alpha) {
    fxCtx.fillStyle = "rgba(0,0,0," + alpha + ")";
    fxCtx.fillRect(0, 0, FXW, FXH);
  }

  const FX_DRAW = [
    function plasma(energy) {
      // slow, continuous drift; the music only eases the speed up a little
      fxPlasmaT += 0.016 * (1 + energy * 1.4);
      const t = fxPlasmaT;
      fxPaint(i => {
        const x = i % FXW, y = (i / FXW) | 0;
        return (Math.sin(x / 9 + t) + Math.sin(y / 7 - t * 0.8) +
                Math.sin((x + y) / 13 + t * 0.6) + Math.sin(fxDist[i] / 8 - t)) * 32 + t * 20;
      }, fxPal);
    },
    function fire(energy) {
      const feed = 120 + energy * 135;
      for (let x = 0; x < FXW; x++) {
        fxFire[FXH * FXW + x] = Math.random() < 0.6 ? feed + Math.random() * 60 : fxFire[FXH * FXW + x] * 0.8;
        fxFire[(FXH + 1) * FXW + x] = fxFire[FXH * FXW + x];
      }
      for (let y = 0; y < FXH; y++) for (let x = 0; x < FXW; x++) {
        const below = (y + 1) * FXW;
        const twoBelow = y + 2 <= FXH + 1 ? (y + 2) * FXW + x : below + x;
        fxFire[y * FXW + x] = Math.max(0,
          (fxFire[below + Math.max(0, x - 1)] + fxFire[below + x] +
           fxFire[below + Math.min(FXW - 1, x + 1)] + fxFire[twoBelow]) / 4 -
          (1.6 - energy));
      }
      fxPaint(i => fxFire[i], fxEmber);
    },
    function snakeFxEntry() { snakeGame(); },
    function stars(energy) {
      fxFade(0.45);
      const speed = 0.0025 + energy * 0.018;
      for (const star of fxStars) {
        star.z -= speed;
        if (star.z <= 0.05) { star.x = Math.random() * 2 - 1; star.y = Math.random() * 2 - 1; star.z = 1; }
        const px = FXW / 2 + star.x / star.z * (FXW / 3);
        const py = FXH / 2 + star.y / star.z * (FXH / 3);
        if (px < 0 || px >= FXW || py < 0 || py >= FXH) continue;
        const bright = Math.min(255, 60 / star.z) | 0;
        fxCtx.fillStyle = "rgb(" + bright + "," + bright + "," + Math.min(255, bright + 40) + ")";
        fxCtx.fillRect(px | 0, py | 0, star.z < 0.3 ? 2 : 1, star.z < 0.3 ? 2 : 1);
      }
    },
    function scope(energy) {
      fxFade(0.22);
      const r1 = 18 + energy * 22, r2 = 12 + energy * 26, t = fxT * 2;
      for (let i = 0; i < 90; i++) {
        const px = FXW / 2 + Math.sin(i * 0.14 + t) * r1 + Math.sin(i * 0.05 - t * 0.7) * 12;
        const py = FXH / 2 + Math.cos(i * 0.11 + t * 1.3) * r2 + Math.cos(i * 0.07 + t) * 8;
        const g = 120 + ((i * 3 + fxT * 90) % 135);
        fxCtx.fillStyle = "rgb(0," + (g | 0) + ",0)";
        fxCtx.fillRect(px | 0, py | 0, 1, 1);
      }
    },
    function rain(energy) {
      rainFx(energy);
    },
  ];

  function drawFx() {
    if (!S.fxOn || !WM.visible("win-mb")) return;
    const modeChanged = fxLastMode !== S.fxMode;
    const rain = S.fxMode === 5, snakeMode = S.fxMode === 2;
    const visibleW = Math.max(1, fxCanvas.clientWidth || FXW);
    const visibleH = Math.max(1, fxCanvas.clientHeight || FXH);
    const wantW = rain ? Math.round(visibleW * RAIN_SCALE) : snakeMode ? SNAKEW : FXW;
    const wantH = rain ? Math.round(visibleH * RAIN_SCALE) : snakeMode ? SNAKEH : FXH;
    const sizeChanged = fxCanvas.width !== wantW || fxCanvas.height !== wantH;
    if (modeChanged || sizeChanged) {
      fxLastMode = S.fxMode;
      // Rain and Snake get a high-res, smoothly-scaled backing; every other
      // effect uses the retro 152x84 pixelated one. Rain's backing is resized
      // whenever its stage changes, using the same multiplier on both axes.
      if (sizeChanged) {
        fxCanvas.width = wantW; fxCanvas.height = wantH;
      }
      if (rain) buildRain(rainState);
      else if (modeChanged) rainState = null;
      if (snakeMode && modeChanged) { snakeReset(); snakeLastT = 0; } // fresh game on entry
      fxCanvas.classList.toggle("fx-smooth", rain || snakeMode);
      fxCtx.fillStyle = "#000";
      fxCtx.fillRect(0, 0, wantW, wantH);
      fxFire.fill(0);
    }
    fxT += 0.035;
    // Low-pass the audio energy so beats sway the effects instead of
    // snapping them frame to frame.
    fxSmoothEnergy += (fxEnergy() - fxSmoothEnergy) * 0.06;
    FX_DRAW[S.fxMode](fxSmoothEnergy);
  }

  // Arrow keys drive the SNAKE game, but only when it's the live effect in a
  // visible visualization window and the user isn't typing into a field.
  const SNAKE_KEYS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  document.addEventListener("keydown", e => {
    if (!S.fxOn || S.fxMode !== 2 || !WM.visible("win-mb")) return;
    if (e.target && e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;
    const d = SNAKE_KEYS[e.key];
    if (d) { snakeSetDir(d[0], d[1]); e.preventDefault(); }
    else if (e.key === " " && snake && snake.over) { snakeReset(); snake.started = true; e.preventDefault(); }
  });

  // One fixed-width dropdown: filtered video (default), HD video, or one of
  // the six FX. The label alone shows the state; no lit/deboss so the
  // button never changes appearance-position when toggled.
  const fxPickButton = $("fx-pick");
  function syncFx() {
    // narrow fixed button: the HD state reads just "HD" beside the TV
    fxPickButton.textContent = S.fxOn ? FX_MODES[S.fxMode] : (S.videoFilter ? "VIDEO" : "HD");
    fxCanvas.hidden = !S.fxOn;
    $("yt-wrap").classList.toggle("indexed-video", S.videoFilter);
  }
  fxPickButton.addEventListener("click", () => buttonMenu(fxPickButton, [
    { label: "Video", checked: !S.fxOn && S.videoFilter, fn: () => {
        S.fxOn = false; S.videoFilter = true; syncFx(); saveSettings();
        $("mb-note").textContent = "video - 6x pixels + indexed 256-color filter";
      } },
    { label: "Video (HD)", checked: !S.fxOn && !S.videoFilter, fn: () => {
        S.fxOn = false; S.videoFilter = false; syncFx(); saveSettings();
        $("mb-note").textContent = "video - original hd";
      } },
    "-",
    ...FX_MODES.map((name, i) => ({
      label: name.charAt(0) + name.slice(1).toLowerCase() + " FX",
      checked: S.fxOn && S.fxMode === i,
      fn: () => {
        S.fxMode = i; S.fxOn = true; syncFx(); saveSettings();
        $("mb-note").textContent = "fx: " + name.toLowerCase();
      },
    })),
  ]));
  syncFx();

  /* -------------- minibrowser settings ticker (bottom bar) --------------
     Continuously scrolls a summary of the current settings; a status note
     written to #mb-note interrupts it for a few seconds, then it resumes. */
  const mbNoteEl = $("mb-note"), mbTickerEl = $("mb-ticker"), mbTickerInner = $("mb-ticker-inner");
  let mbHoldUntil = 0, mbOffset = 0, mbLastText = "", mbLastBuild = 0;
  new MutationObserver(() => { mbHoldUntil = performance.now() + 4000; })
    .observe(mbNoteEl, { childList: true, characterData: true, subtree: true });
  function drawMbTicker(now) {
    const holding = now < mbHoldUntil && mbNoteEl.textContent.trim();
    // Write `hidden` only when it changes: a same-value assignment still
    // queues a mutation record, and native.js re-reports the window shape
    // on every one - this line used to trigger a report every frame.
    const noteHidden = !holding, tickerHidden = !!holding;
    if (mbNoteEl.hidden !== noteHidden) mbNoteEl.hidden = noteHidden;
    if (mbTickerEl.hidden !== tickerHidden) mbTickerEl.hidden = tickerHidden;
    if (holding || !WM.visible("win-mb")) return;
    if (now - mbLastBuild > 500) {
      mbLastBuild = now;
      const text = [
        "VIDEO: " + (S.fxOn ? "FX " + FX_MODES[S.fxMode] : S.videoFilter ? "FILTERED" : "HD"),
        "MODEL: " + provider().label.toUpperCase(),
        "WINDOW: " + (S.chatMode === "shell" ? "REAL TERMINAL" : "AI CHAT"),
        "VOL: " + Math.round(S.volume * 100) + "%",
        "ZOOM: " + S.zoom + "X",
        "SHUFFLE: " + (S.shuffle ? "ON" : "OFF"),
        "REPEAT: " + (S.repeat ? "ON" : "OFF"),
      ].join("  ***  ") + "  ***  ";
      if (text !== mbLastText) {
        mbLastText = text;
        mbTickerInner.textContent = text + text; // doubled for a seamless loop
      }
    }
    mbOffset += 0.12; // gentle crawl - roughly 7px/s
    const half = mbTickerInner.scrollWidth / 2 || 1;
    if (mbOffset >= half) mbOffset -= half;
    mbTickerInner.style.transform = "translateX(" + -Math.round(mbOffset) + "px)";
  }

  /* ---------------- custom pledit scrollbar (playlist) ----------------
     Native scrollbars vary per browser and fluent overlay ones ignore CSS
     entirely, so the playlist draws its own: gold thumb, arrow buttons. */
  function attachAmpScroll(list, root, stepPx = 27) {
    if (!list || !root) return;
    const up = root.querySelector(".up"), down = root.querySelector(".down");
    const track = root.querySelector(".amp-scroll-track");
    const thumb = root.querySelector(".amp-scroll-thumb");
    const metrics = () => {
      const range = list.scrollHeight - list.clientHeight;
      const trackH = track.clientHeight;
      const thumbH = range <= 0 ? trackH :
        Math.max(12, Math.round(trackH * list.clientHeight / list.scrollHeight));
      return { range, trackH, thumbH };
    };
    const sync = () => {
      const { range, trackH, thumbH } = metrics();
      root.classList.toggle("idle", range <= 0);
      thumb.style.height = thumbH + "px";
      thumb.style.top = (range <= 0 ? 0 :
        Math.round((trackH - thumbH) * (list.scrollTop / range))) + "px";
    };
    list.addEventListener("scroll", sync);
    new ResizeObserver(sync).observe(list);
    new MutationObserver(sync).observe(list, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["style"],
    });
    const step = dir => { list.scrollTop += dir * stepPx; };
    let holdTimer = null, holdRepeat = null;
    const pressable = (el, dir) => {
      el.addEventListener("pointerdown", e => {
        step(dir); e.preventDefault();
        holdTimer = setTimeout(() => { holdRepeat = setInterval(() => step(dir), 60); }, 320);
      });
      for (const ev of ["pointerup", "pointerleave", "pointercancel"])
        el.addEventListener(ev, () => { clearTimeout(holdTimer); clearInterval(holdRepeat); });
    };
    pressable(up, -1);
    pressable(down, 1);
    let drag = null;
    thumb.addEventListener("pointerdown", e => {
      const { range, trackH, thumbH } = metrics();
      if (range <= 0) return;
      drag = { y: e.clientY, from: list.scrollTop, range, span: trackH - thumbH };
      thumb.setPointerCapture(e.pointerId);
      e.preventDefault(); e.stopPropagation();
    });
    thumb.addEventListener("pointermove", e => {
      if (!drag || drag.span <= 0) return;
      list.scrollTop = drag.from + (e.clientY - drag.y) / WM.zoomFactor() * (drag.range / drag.span);
    });
    for (const ev of ["pointerup", "pointercancel"])
      thumb.addEventListener(ev, () => { drag = null; });
    track.addEventListener("pointerdown", e => {
      if (e.target === thumb) return;
      const { range, trackH, thumbH } = metrics();
      if (range <= 0) return;
      const y = (e.clientY - track.getBoundingClientRect().top) / WM.zoomFactor() - thumbH / 2;
      list.scrollTop = Math.max(0, Math.min(1, y / (trackH - thumbH || 1))) * range;
    });
    sync();
  }
  attachAmpScroll($("pl-list"), $("pl-scroll"));
  attachAmpScroll($("chat-log"), $("chat-scroll"), 40);
  attachAmpScroll($("yt-results"), $("mb-results-scroll"), 28);

  /* ============================ main loop ============================ */
  let lastSlow = 0, lastPlaylistIdx = -1;
  function frame(now) {
    typeStep();
    if (chatBusy && streamCtrl) genElapsed = (now - genStart) / 1000;
    drawVis();
    drawFx();
    drawMbTicker(now);
    drawPlaystate();
    const busy = chatBusy || Music.mode === "playing";
    if (busy || now - lastSlow > 250) {
      drawTime(); drawInfo(); drawUsage(); drawUsageText(); drawSeek(); drawPlTime();
      if (lastPlaylistIdx !== Music.idx) {
        lastPlaylistIdx = Music.idx;
        renderPlaylist();
      }
      lastSlow = now;
    }
    drawTicker(now);
    requestAnimationFrame(frame);
  }

  /* ============================ boot ============================ */
  loadAll();
  adoptSecureState();
  if (window.claudeAmpDesktop && window.claudeAmpDesktop.onUpdateAvailable)
    window.claudeAmpDesktop.onUpdateAvailable(info => {
      updateNotice = "NEW: CLAUDEAMP V" + String(info.version || "").toUpperCase() +
        " IS OUT - CLAUDEAMP.COM  ***  ";
    });
  // Native menu bar: commands arrive from main by id; state flows back so
  // the native checkmarks track the app (heartbeat catches visibility
  // changes made with window buttons or drags).
  if (window.claudeAmpDesktop && window.claudeAmpDesktop.onMenuCommand) {
    window.claudeAmpDesktop.onMenuCommand(runMenuCommand);
    setInterval(syncMenuState, 2000);
    setTimeout(syncMenuState, 500);
  }
  // Zoom before layout: WM.init() clamps restored panels against the
  // desktop's size, which depends on --zoom. At the default 1 the old order
  // was harmless; at a saved 2x it clamped against a desktop twice as wide
  // as the one the panels end up on.
  $("desktop").style.setProperty("--zoom", S.zoom);
  WM.init();
  buildEqThumbs();
  drawEqFace(); drawEqGraph();
  Music.init({
    onState(mode) { $("local-audio-screen").classList.toggle("playing", mode === "playing"); },
    onTrack() { renderPlaylist(); },
    onNote(t) { $("mb-note").textContent = t.toLowerCase(); }, // player status stays in the visualization window, never the chat
    onSource(track) { renderMinibrowserSource(track); },
    async search(query) {
      let response;
      try {
        response = await fetch("/bridge/youtube/search?q=" + encodeURIComponent(query), {
          cache: "no-store", headers: { "x-claudeamp-token": bridgeStatus.token },
        });
      } catch (_) {
        throw new Error("needs the desktop app or bridge.js");
      }
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value.error || "search returned " + response.status);
      return Array.isArray(value.results) ? value.results : [];
    },
    async lookupApple(ids) {
      if (!bridgeStatus.token) throw new Error("bridge is still starting");
      const clean = (Array.isArray(ids) ? ids : []).map(String).filter(id => /^\d+$/.test(id));
      if (!clean.length) return [];
      let response;
      try {
        response = await fetch("/bridge/apple/lookup?ids=" + encodeURIComponent(clean.join(",")), {
          cache: "no-store", headers: { "x-claudeamp-token": bridgeStatus.token },
        });
      } catch (_) {
        throw new Error("needs the desktop app or bridge.js");
      }
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value.error || "itunes lookup returned " + response.status);
      return Array.isArray(value.results) ? value.results : [];
    },
    async activateService(name) {
      if (name !== "spotify") throw new Error("unknown music service");
      // Being connected is not enough: if the user has switched the music
      // service away from Spotify, replaying a Spotify track must not
      // silently reinstall the adapter and undo their choice.
      if (S.musicService !== "spotify") throw new Error("Spotify is not the selected music service");
      const status = await MusicService.status();
      if (!status.connected) throw new Error("connect Spotify in Options first");
      return MusicService.adapter;
    },
  });
  if (window.claudeampNative?.platform === "darwin")
    document.body.classList.add("mac-shell");
  wire();
  syncWinButtons();
  syncFx(); // module-eval ran before loadAll; re-apply the loaded video/FX state
  const aboutVersion = $("about-version");
  if (aboutVersion) aboutVersion.textContent = window.CLAUDEAMP_VERSION || "";
  renderPlaylist();
  renderChat();
  if (!store.raw(SETUP_KEY)) {
    openSetup();                         // first run: pick terminal or chat
  } else {
    if (S.chatMode === "shell") {
      if (window.claudeampTerm) {
        WM.toggle("win-chat", false);
        openTerminal(shellAutoCommand());
      } else {
        S.chatMode = "chat";             // shell mode only exists in the desktop app
      }
    } else if (window.claudeampTerm && WM.visible("win-term")) {
      // Older layouts could persist a standalone terminal while the menu still
      // claimed AI Chat was selected. Normalize that legacy state: a visible
      // terminal is Real Terminal mode and takes the chat window's dock slot.
      setChatMode("shell");
    }
    initMenuOnboarding();                // returning users: menu hint if not dismissed
  }
  requestAnimationFrame(frame);
})();
