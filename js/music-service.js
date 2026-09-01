/* ClaudeAmp — external music services. Today: Spotify Connect.
   ClaudeAmp acts as a remote control for the user's real Spotify app: the
   bridge holds the OAuth tokens and relays search/playback, this module is
   the thin renderer client plus the adapter the player engine drives. */
"use strict";

const MusicService = (() => {
  let token = "";

  function setToken(value) { token = String(value || ""); }

  async function call(path, options = {}) {
    const response = await fetch(path, {
      method: options.method || "GET",
      cache: "no-store",
      headers: Object.assign({ "x-claudeamp-token": token },
        options.body ? { "content-type": "application/json" } : {}),
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(data.error || ("HTTP " + response.status));
    return data;
  }

  const status = () => call("/bridge/spotify/status");
  const login = clientId => call("/bridge/spotify/login", { method: "POST", body: { clientId } });
  const logout = () => call("/bridge/spotify/logout", { method: "POST" });

  /* The adapter surface the Music engine drives when Spotify is the active
     service. All calls relay through the bridge; audio comes out of the
     user's own Spotify app (Connect), never this window. */
  const adapter = {
    name: "spotify",
    search: async query =>
      (await call("/bridge/spotify/search?q=" + encodeURIComponent(query))).results || [],
    play: uri => call("/bridge/spotify/player", { method: "POST", body: { action: "play", uri } }),
    resume: () => call("/bridge/spotify/player", { method: "POST", body: { action: "resume" } }),
    pause: () => call("/bridge/spotify/player", { method: "POST", body: { action: "pause" } }),
    seek: positionMs => call("/bridge/spotify/player", { method: "POST", body: { action: "seek", positionMs } }),
    setVolume: volume => call("/bridge/spotify/player", { method: "POST", body: { action: "volume", volume } }),
    state: async () => {
      const state = await call("/bridge/spotify/state");
      state.at = performance.now();
      return state;
    },
  };

  return { setToken, status, login, logout, adapter };
})();
