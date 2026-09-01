"use strict";

/* ClaudeAmp music/search backends: the YouTube result scraper, Spotify
   Connect OAuth remote control, and Apple preview lookups - split out of
   bridge.js so the CLI relay and its security core stay a small auditable
   file. bridge.js wires this up with createMusicRoutes() and dispatches
   /bridge/youtube|spotify|apple requests here; auth (bearer token,
   same-origin) stays with the caller except where a handler documents its
   own (the OAuth callback's one-time state). */

const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");

module.exports = function createMusicRoutes({ json, hasToken, getListenPort, DEFAULT_PORT }) {

function balancedJson(source, start) {
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  return "";
}

function textValue(value) {
  if (!value) return "";
  if (value.simpleText) return value.simpleText;
  return (value.runs || []).map(run => run.text || "").join("");
}

// "1,234,567 views" -> 1234567; live/"watching" counts return null
function viewsCount(text) {
  const match = /^([\d,.]+)\s*views?\b/.exec(String(text || "").trim());
  return match ? Number(match[1].replace(/[^\d]/g, "")) : null;
}

function durationSeconds(value) {
  const parts = String(value || "").split(":").map(Number);
  if (!parts.length || parts.some(part => !Number.isFinite(part))) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function collectVideos(root) {
  const results = [], seen = new Set(), stack = [root];
  while (stack.length && results.length < 12) {
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    const renderer = value.videoRenderer;
    if (renderer && /^[A-Za-z0-9_-]{11}$/.test(renderer.videoId || "") && !seen.has(renderer.videoId)) {
      seen.add(renderer.videoId);
      results.push({
        id: renderer.videoId,
        title: textValue(renderer.title) || "YouTube " + renderer.videoId,
        channel: textValue(renderer.ownerText || renderer.longBylineText),
        duration: durationSeconds(textValue(renderer.lengthText)),
        views: viewsCount(textValue(renderer.viewCountText)),
        thumbnail: "/bridge/youtube/thumbnail/" + renderer.videoId,
      });
    }
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--) stack.push(value[index]);
    } else {
      for (const child of Object.values(value)) if (child && typeof child === "object") stack.push(child);
    }
  }
  return results;
}

function youtubeSearch(query) {
  return new Promise((resolve, reject) => {
    const url = "https://www.youtube.com/results?hl=en&gl=US&search_query=" + encodeURIComponent(query);
    const request = https.get(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
      },
      timeout: 12000,
    }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error("YouTube returned " + response.statusCode)); return; }
      let html = "", bytes = 0;
      response.setEncoding("utf8");
      response.on("data", chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 6 * 1024 * 1024) { request.destroy(new Error("YouTube response was too large")); return; }
        html += chunk;
      });
      response.on("end", () => {
        const markers = ["var ytInitialData = ", '"ytInitialData":'];
        let jsonText = "";
        for (const marker of markers) {
          const markerAt = html.indexOf(marker);
          if (markerAt < 0) continue;
          const start = html.indexOf("{", markerAt + marker.length);
          if (start >= 0) jsonText = balancedJson(html, start);
          if (jsonText) break;
        }
        if (!jsonText) { reject(new Error("YouTube search data was not found")); return; }
        try { resolve(collectVideos(JSON.parse(jsonText))); }
        catch (_) { reject(new Error("YouTube search data could not be read")); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("YouTube search timed out")));
    request.on("error", reject);
  });
}

function youtubeThumbnail(videoId, res) {
  const request = https.get("https://i.ytimg.com/vi/" + videoId + "/mqdefault.jpg", {
    headers: { "user-agent": "ClaudeAmp/1.2" },
    timeout: 10000,
  }, response => {
    if (response.statusCode !== 200 || !String(response.headers["content-type"] || "").startsWith("image/")) {
      response.resume(); json(res, 502, { error: "YouTube thumbnail unavailable" }); return;
    }
    let bytes = 0;
    res.writeHead(200, {
      "content-type": response.headers["content-type"],
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
    });
    response.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) request.destroy(new Error("Thumbnail response was too large"));
    });
    response.pipe(res);
  });
  request.on("timeout", () => request.destroy(new Error("YouTube thumbnail timed out")));
  request.on("error", error => {
    if (!res.headersSent) json(res, 502, { error: error.message || "YouTube thumbnail failed" });
    else res.destroy(error);
  });
}

/* ============================ Spotify Connect ============================
   ClaudeAmp never plays Spotify audio itself (that would need DRM). Instead
   it is a remote control: OAuth PKCE against the user's own (free to
   register) Spotify app client id, then the Web API searches each playlist
   entry and starts it on whatever device is running the real Spotify app.
   Tokens live in ~/.claudeamp/spotify.json, never in the renderer. */
const SPOTIFY_ACCOUNTS = process.env.CLAUDEAMP_SPOTIFY_ACCOUNTS || "https://accounts.spotify.com";
const SPOTIFY_API = process.env.CLAUDEAMP_SPOTIFY_API || "https://api.spotify.com";
const SPOTIFY_SCOPES = "user-read-playback-state user-modify-playback-state user-read-private";
const spotifyStorePath = () => path.join(os.homedir(), ".claudeamp", "spotify.json");
let spotifyPending = null; // {state, verifier, clientId, expires}

function readSpotifyStore() {
  try { return JSON.parse(fs.readFileSync(spotifyStorePath(), "utf8")) || {}; }
  catch (_) { return {}; }
}
function writeSpotifyStore(value) {
  try {
    fs.mkdirSync(path.dirname(spotifyStorePath()), { recursive: true });
    fs.writeFileSync(spotifyStorePath(), JSON.stringify(value, null, 2), { mode: 0o600 });
  } catch (_) {}
}

// http(s) JSON/form request that follows the base URL's protocol, so tests
// can point CLAUDEAMP_SPOTIFY_* at a local plain-http mock.
function webRequest(urlString, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(urlString); } catch (error) { reject(error); return; }
    const lib = target.protocol === "http:" ? http : https;
    const request = lib.request(target, { method, headers }, response => {
      let data = "", bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) { response.destroy(); return; } // 2MB cap
        data += chunk;
      });
      response.on("end", () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (_) {}
        resolve({ status: response.statusCode, body: parsed, raw: data });
      });
    });
    request.on("error", reject);
    request.setTimeout(15000, () => request.destroy(new Error("spotify request timed out")));
    if (body) request.write(body);
    request.end();
  });
}

function spotifyRedirectUri() {
  return "http://127.0.0.1:" + (getListenPort() || DEFAULT_PORT) + "/bridge/spotify/callback";
}

async function spotifyTokenRequest(form) {
  const body = new URLSearchParams(form).toString();
  const response = await webRequest(SPOTIFY_ACCOUNTS + "/api/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) },
    body,
  });
  if (response.status !== 200 || !response.body || !response.body.access_token) {
    throw new Error((response.body && (response.body.error_description || response.body.error)) ||
      "token exchange failed (" + response.status + ")");
  }
  return response.body;
}

let spotifyRefreshing = null; // single-flight: concurrent callers share one refresh
async function spotifyAccessToken() {
  const store = readSpotifyStore();
  if (!store.refreshToken || !store.clientId) throw new Error("spotify is not connected");
  if (store.accessToken && store.expiresAt && Date.now() < store.expiresAt - 30000)
    return store.accessToken;
  if (!spotifyRefreshing) {
    spotifyRefreshing = (async () => {
      const grant = await spotifyTokenRequest({
        grant_type: "refresh_token",
        refresh_token: store.refreshToken,
        client_id: store.clientId,
      });
      const fresh = readSpotifyStore(); // logout may have raced us
      if (!fresh.refreshToken) throw new Error("spotify is not connected");
      fresh.accessToken = grant.access_token;
      fresh.expiresAt = Date.now() + (grant.expires_in || 3600) * 1000;
      if (grant.refresh_token) fresh.refreshToken = grant.refresh_token;
      writeSpotifyStore(fresh);
      return fresh.accessToken;
    })().finally(() => { spotifyRefreshing = null; });
  }
  return spotifyRefreshing;
}

async function spotifyApi(method, apiPath, body) {
  const token = await spotifyAccessToken();
  const payload = body ? JSON.stringify(body) : null;
  const response = await webRequest(SPOTIFY_API + apiPath, {
    method,
    headers: Object.assign({ authorization: "Bearer " + token },
      payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
    body: payload,
  });
  if (response.status === 404) throw new Error("no-device: open Spotify on any device first");
  if (response.status === 403) {
    const reason = response.body && response.body.error && response.body.error.reason;
    throw new Error(reason === "PREMIUM_REQUIRED" ? "premium required" :
      (response.body && response.body.error && response.body.error.message) || "spotify refused (403)");
  }
  if (response.status >= 400) {
    throw new Error((response.body && response.body.error && response.body.error.message) ||
      "spotify error " + response.status);
  }
  return response.body;
}

function spotifyStatusSnapshot() {
  const store = readSpotifyStore();
  return {
    configured: !!store.clientId,
    connected: !!store.refreshToken,
    account: store.account || "",
    product: store.product || "",
    clientId: store.clientId || "",
    redirectUri: spotifyRedirectUri(),
  };
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise(resolve => {
    let data = "", bytes = 0, bad = false;
    req.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > limit) bad = true; else data += chunk.toString();
    });
    req.on("end", () => {
      if (bad) { resolve(null); return; }
      try { resolve(JSON.parse(data || "{}")); } catch (_) { resolve(null); }
    });
  });
}

async function handleSpotifyRoute(url, req, res) {
  if (url.pathname === "/bridge/spotify/callback" && req.method === "GET") {
    // Arrives as a browser redirect from Spotify: no bridge token possible.
    // The one-time state value is the proof this flow started here.
    const state = url.searchParams.get("state") || "";
    const code = url.searchParams.get("code") || "";
    const fail = message => {
      const safe = String(message).replace(/[&<>"']/g, c =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end("<h2>Spotify connection failed</h2><p>" + safe + "</p><p>Return to ClaudeAmp and try again.</p>");
    };
    if (!spotifyPending || state !== spotifyPending.state || Date.now() > spotifyPending.expires) {
      fail("The sign-in link expired or did not match. "); return true;
    }
    if (!code) { fail(url.searchParams.get("error") || "Spotify sent no code."); return true; }
    const pending = spotifyPending;
    spotifyPending = null;
    try {
      const grant = await spotifyTokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: spotifyRedirectUri(),
        client_id: pending.clientId,
        code_verifier: pending.verifier,
      });
      const store = {
        clientId: pending.clientId,
        refreshToken: grant.refresh_token || "",
        accessToken: grant.access_token,
        expiresAt: Date.now() + (grant.expires_in || 3600) * 1000,
      };
      writeSpotifyStore(store);
      try {
        const me = await spotifyApi("GET", "/v1/me");
        store.account = (me && (me.display_name || me.id)) || "";
        store.product = (me && me.product) || "";
        writeSpotifyStore(store);
      } catch (_) {}
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<h2>Spotify connected ✓</h2><p>You can close this tab and return to ClaudeAmp.</p>");
    } catch (error) {
      fail(error.message || "token exchange failed");
    }
    return true;
  }

  if (!url.pathname.startsWith("/bridge/spotify/")) return false;
  if (!hasToken(req)) { json(res, 403, { error: "bridge token rejected" }); return true; }

  if (url.pathname === "/bridge/spotify/status" && req.method === "GET") {
    json(res, 200, spotifyStatusSnapshot());
    return true;
  }
  if (url.pathname === "/bridge/spotify/login" && req.method === "POST") {
    const body = await readJsonBody(req);
    const clientId = String((body && body.clientId) || readSpotifyStore().clientId || "").trim();
    if (!/^[A-Za-z0-9]{16,64}$/.test(clientId)) {
      json(res, 400, { error: "A Spotify app Client ID is required (developer.spotify.com/dashboard)" });
      return true;
    }
    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const state = crypto.randomBytes(16).toString("base64url");
    spotifyPending = { state, verifier, clientId, expires: Date.now() + 10 * 60 * 1000 };
    const authorize = SPOTIFY_ACCOUNTS + "/authorize?" + new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: spotifyRedirectUri(),
      scope: SPOTIFY_SCOPES,
      code_challenge_method: "S256",
      code_challenge: challenge,
      state,
    }).toString();
    json(res, 200, { ok: true, url: authorize, redirectUri: spotifyRedirectUri() });
    return true;
  }
  if (url.pathname === "/bridge/spotify/logout" && req.method === "POST") {
    writeSpotifyStore({});
    spotifyPending = null;
    json(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/bridge/spotify/search" && req.method === "GET") {
    const query = String(url.searchParams.get("q") || "").trim().slice(0, 120);
    if (!query) { json(res, 400, { error: "empty query" }); return true; }
    try {
      const data = await spotifyApi("GET", "/v1/search?" + new URLSearchParams({ q: query, type: "track", limit: "6" }));
      const results = (((data || {}).tracks || {}).items || [])
        .filter(item => item && item.uri && item.is_playable !== false)
        .map(item => ({
          uri: item.uri,
          name: item.name,
          artists: (item.artists || []).map(artist => artist.name).join(", "),
          durationMs: item.duration_ms || 0,
          artwork: (((item.album || {}).images || [])[0] || {}).url || "",
          link: ((item.external_urls || {}).spotify) || "",
        }));
      json(res, 200, { query, results });
    } catch (error) { json(res, 502, { error: error.message || "spotify search failed" }); }
    return true;
  }
  if (url.pathname === "/bridge/spotify/state" && req.method === "GET") {
    try {
      const state = await spotifyApi("GET", "/v1/me/player");
      if (!state) { json(res, 200, { playing: false, progressMs: 0, durationMs: 0, trackName: "", device: "" }); return true; }
      json(res, 200, {
        playing: !!state.is_playing,
        progressMs: state.progress_ms || 0,
        durationMs: (state.item && state.item.duration_ms) || 0,
        trackName: (state.item && state.item.name) || "",
        artists: (state.item && state.item.artists || []).map(artist => artist.name).join(", "),
        device: (state.device && state.device.name) || "",
        volume: state.device && typeof state.device.volume_percent === "number" ? state.device.volume_percent : null,
      });
    } catch (error) { json(res, 502, { error: error.message || "spotify state failed" }); }
    return true;
  }
  if (url.pathname === "/bridge/spotify/player" && req.method === "POST") {
    const body = await readJsonBody(req);
    const action = body && body.action;
    try {
      if (action === "play" && body.uri) await spotifyApi("PUT", "/v1/me/player/play", { uris: [String(body.uri)] });
      else if (action === "resume") await spotifyApi("PUT", "/v1/me/player/play");
      else if (action === "pause") await spotifyApi("PUT", "/v1/me/player/pause");
      else if (action === "next") await spotifyApi("POST", "/v1/me/player/next");
      else if (action === "previous") await spotifyApi("POST", "/v1/me/player/previous");
      else if (action === "seek") await spotifyApi("PUT", "/v1/me/player/seek?position_ms=" + Math.max(0, Math.round(Number(body.positionMs) || 0)));
      else if (action === "volume") await spotifyApi("PUT", "/v1/me/player/volume?volume_percent=" + Math.max(0, Math.min(100, Math.round(Number(body.volume) || 0))));
      else { json(res, 400, { error: "unknown player action" }); return true; }
      json(res, 200, { ok: true });
    } catch (error) { json(res, 502, { error: error.message || "spotify player failed" }); }
    return true;
  }
  json(res, 404, { error: "not found" });
  return true;
}

/* ========================= Apple Music previews =========================
   Apple's public iTunes Search API needs no account and returns official
   30-second preview streams (plain AAC/MP3 URLs) for most of the catalog.
   Full Apple Music playback would need a DRM build; previews play in-skin. */
const APPLE_API = process.env.CLAUDEAMP_APPLE_API || "https://itunes.apple.com";
function applePreviewResult(item) {
  if (!item || !item.previewUrl || !item.trackId) return null;
  return {
    id: String(item.trackId),
    previewUrl: item.previewUrl,
    previewDuration: 30,
    name: item.trackName || "",
    artists: item.artistName || "",
    album: item.collectionName || "",
    trackDurationMs: item.trackTimeMillis || 0,
    artwork: item.artworkUrl100 || item.artworkUrl60 || "",
    link: item.trackViewUrl || "",
  };
}

async function handleAppleRoute(url, req, res) {
  if (!["/bridge/apple/search", "/bridge/apple/lookup"].includes(url.pathname) || req.method !== "GET") return false;
  if (!hasToken(req)) { json(res, 403, { error: "bridge token rejected" }); return true; }
  if (url.pathname === "/bridge/apple/lookup") {
    const ids = String(url.searchParams.get("ids") || "").split(",")
      .map(value => value.trim()).filter(value => /^\d+$/.test(value)).slice(0, 100);
    if (!ids.length) { json(res, 400, { error: "no valid track ids" }); return true; }
    try {
      const response = await webRequest(APPLE_API + "/lookup?" + new URLSearchParams({
        id: ids.join(","), entity: "song", country: "US",
      }));
      if (response.status !== 200) throw new Error("itunes returned " + response.status);
      let data = response.body;
      if (!data && response.raw) { try { data = JSON.parse(response.raw); } catch (_) {} }
      const results = ((data && data.results) || []).map(applePreviewResult).filter(Boolean);
      json(res, 200, { results });
    } catch (error) { json(res, 502, { error: error.message || "apple lookup failed" }); }
    return true;
  }
  const query = String(url.searchParams.get("q") || "").trim().slice(0, 120);
  if (!query) { json(res, 400, { error: "empty query" }); return true; }
  try {
    const response = await webRequest(APPLE_API + "/search?" + new URLSearchParams({
      term: query, media: "music", entity: "song", limit: "10", country: "US", explicit: "Yes",
    }));
    if (response.status !== 200) throw new Error("itunes returned " + response.status);
    // The API serves JSON with a text/javascript content type; webRequest
    // already tolerates that by parsing the raw body.
    let data = response.body;
    if (!data && response.raw) { try { data = JSON.parse(response.raw); } catch (_) {} }
    const results = ((data && data.results) || []).map(applePreviewResult).filter(Boolean);
    json(res, 200, { query, results });
  } catch (error) { json(res, 502, { error: error.message || "apple search failed" }); }
  return true;
}


  async function handleYouTubeRoute(url, req, res) {
    if (url.pathname === "/bridge/youtube/search" && req.method === "GET") {
      if (!hasToken(req)) { json(res, 403, { error: "bridge token rejected" }); return true; }
      const query = String(url.searchParams.get("q") || "").trim().slice(0, 120);
      if (!query) { json(res, 400, { error: "Enter a song, artist, or album" }); return true; }
      try { json(res, 200, { query, results: await youtubeSearch(query) }); }
      catch (error) { json(res, 502, { error: error.message || "YouTube search failed" }); }
      return true;
    }
    const thumbnailMatch = url.pathname.match(/^\/bridge\/youtube\/thumbnail\/([A-Za-z0-9_-]{11})$/);
    if (thumbnailMatch && req.method === "GET") {
      youtubeThumbnail(thumbnailMatch[1], res);
      return true;
    }
    return false;
  }

  return { handleSpotifyRoute, handleAppleRoute, handleYouTubeRoute };
};
