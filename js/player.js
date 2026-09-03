/* ClaudeAmp — YouTube, iTunes-preview, and local audio playlist engine. */
"use strict";

const Music = (() => {
  const TRACKS_V = 52;
  const ACTIVE_KEY = "claudeamp.tracks";
  const LIBRARY_KEY = "claudeamp.playlists";
  const DEFAULT_NAME = "ClaudeAmp 90s Previews";
  const BOSSTONES_REPLACEMENT = {
    type: "youtube", id: "70u2F_ryLDM", title: "Mustard Plug - Mr. Smiley", dur: 167,
  };
  const YOUTUBE_PLACEHOLDER_ID = "PSYxT9GM0fQ";
  const applePreview = (appleId, title) => ({
    type: "apple", id: "apple:" + appleId, appleId, title, dur: 30, defaultPreview: true,
  });
  const DEFAULT_TRACKS = [
    applePreview(338349243,  "Darude - Sandstorm"),
    applePreview(1444009361, "Chumbawamba - Tubthumping"),
    applePreview(1731384547, "Haddaway - What Is Love"),
    applePreview(1440841589, "Eric B. & Rakim - Paid In Full"),
    applePreview(1771850361, "Orbital - Halcyon"),
    applePreview(1530256522, "New Order - True Faith"),
    applePreview(1440719249, "Smash Mouth - All Star"),
    applePreview(1025318629, "Pixies - Where Is My Mind?"),
    applePreview(1765550586, "Dinosaur Jr. - Feel The Pain"),
    applePreview(1440902348, "4 Non Blondes - What's Up?"),
    applePreview(715805283,  "Liz Phair - Supernova"),
    applePreview(1440800296, "Technotronic - Pump Up The Jam"),
    applePreview(1442993417, "Wu-Tang Clan - Triumph"),
    applePreview(158470164,  "G. Love & Special Sauce - Cold Beverage"),
    applePreview(720099920,  "Gang Starr - Mass Appeal"),
    applePreview(389044413,  "Tom Tom Club - Who Feelin' It"),
    applePreview(1443993482, "Elastica - Connection"),
    applePreview(298572470,  "Republica - Ready To Go"),
    applePreview(190809033,  "Alice In Chains - Rooster"),
    applePreview(989445780,  "Letters To Cleo - Here & Now"),
    applePreview(291497568,  "Face To Face - Disconnected"),
    applePreview(1667655088, "The Lemonheads - It's A Shame About Ray"),
    applePreview(358058316,  "Belly - Feed The Tree"),
    applePreview(724739482,  "Katrina & The Waves - Walking On Sunshine"),
    applePreview(444190188,  "Sebadoh - Skull"),
    applePreview(1251496094, "The Breeders - Cannonball"),
    applePreview(40454935,   "Spacehog - In The Meantime"),
    applePreview(734450288,  "Candlebox - Far Behind"),
    applePreview(83385347,   "Faith No More - Epic"),
    applePreview(1440798881, "Rush - Tom Sawyer"),
    applePreview(1049828562, "Bikini Kill - Rebel Girl"),
    applePreview(784725793,  "Minor Threat - Seeing Red"),
    applePreview(395970118,  "Mustard Plug - Mr. Smiley"),
    applePreview(1706500742, "Knochenfabrik - Filmriss"),
    applePreview(520417425,  "The Mr. T Experience - I'm Like Yeah, But She's All No"),
    applePreview(193603361,  "Ben Folds Five - Battle Of Who Could Care Less"),
    applePreview(1442530446, "Trio - Da Da Da"),
    applePreview(1440921344, "The Refreshments - Banditos"),
    applePreview(157316202,  "Screaming Trees - Nearly Lost You"),
    applePreview(1675516478, "White Town - Your Woman"),
    applePreview(1612544004, "Depeche Mode - Enjoy The Silence"),
    applePreview(714052827,  "Fatboy Slim - Weapon Of Choice"),
    applePreview(724971921,  "Beastie Boys - Sabotage"),
    applePreview(286588617,  "KRS-One - Step Into A World (Rapture's Delight)"),
    applePreview(721250898,  "The Chemical Brothers - Setting Sun"),
    applePreview(1445884058, "Underworld - Born Slippy (Nuxx)"),
    applePreview(1674203786, "De La Soul - Stakes Is High"),
    applePreview(1443181328, "The Folk Implosion - Free To Go"),
    applePreview(1440811252, "Johnny Cash - Hurt"),
    applePreview(1443912092, "Semisonic - Closing Time"),
  ];

  /* Songs whose stored id drifted to a non-embeddable upload (the auto-relink
     saves whatever it lands on, which can itself go bad). On every load we pin
     these titles back to a hand-verified, embeddable id so they stop getting
     crossed out. Keyed by exact default title. */
  const ID_FIXUPS = {
    "Darude - Sandstorm": "PSYxT9GM0fQ",
    "Chumbawamba - Tubthumping": "cuNU20bDTGU",
  };

  let tracks = [];
  let idx = 0;
  let activeName = DEFAULT_NAME;
  let savedPlaylists = {};
  let mode = "stopped";
  let player = null;
  let loadedId = null;
  let ytReady = false;
  let ytFailed = false;
  let pendingPlay = false;
  let shuffle = false;
  let repeat = false;
  let volume = 70;
  let audioTrackId = null;
  let audioObjectUrl = null;
  let audioLoadToken = 0;
  const audio = new Audio();
  const badTracks = new Set();
  let autoSkipRun = 0; // consecutive auto-skips through unavailable tracks
  let cb = {
    onState: () => {}, onTrack: () => {}, onNote: () => {}, onSource: () => {},
    search: null, lookupApple: null, activateService: null,
  };

  /* External music service (Spotify Connect). When set, titled tracks play
     through it; local files and streams keep playing locally. */
  let svc = null;
  let svcPoll = 0, svcState = null, svcNearEnd = false, svcPlayToken = 0;
  const serviceTrack = track => !!svc && !!track && (
    track.type === "spotify" ? svc.name === "spotify" :
      !track.sourceLocked && (youtubeTrack(track) || track.type === "radio")
  );
  // Each service caches its own resolved id on the track.
  const SVC_URI_KEYS = { spotify: "spotifyUri" };
  const svcUriKey = () => (svc && SVC_URI_KEYS[svc.name]) || "spotifyUri";
  const svcLabel = () => String((svc && (svc.display || svc.name)) || "SERVICE").toUpperCase();

  function youtubeTrack(track) {
    return !!track && (track.type === "youtube" || (!track.type && /^[A-Za-z0-9_-]{11}$/.test(track.id || "")));
  }

  function appleTrack(track) {
    return !!track && track.type === "apple" && /^\d+$/.test(String(track.appleId || ""));
  }

  const titleKey = title => String(title || "").trim().toLowerCase();
  function looksLikeLegacyDefault(data, list) {
    // Older ClaudeAmp builds saved the bundled catalog as `custom:true`, so a
    // normal version check could not distinguish it from a playlist the user
    // made. Match the catalog itself before migrating it to Apple's previews.
    if (!Array.isArray(list) || list.length < 45 || list.length > 55) return false;
    const defaultTitles = new Set(DEFAULT_TRACKS.map(track => titleKey(track.title)));
    const overlap = list.filter(track => defaultTitles.has(titleKey(track.title))).length;
    const appleCount = list.filter(appleTrack).length;
    const legacySources = list.filter(track => !appleTrack(track)).length;
    const defaultishName = /claudeamp|90s|default|current playlist/i.test(String(data && data.name || ""));
    return appleCount < 45 && overlap >= 42 && (defaultishName || legacySources >= 35);
  }

  function normalizeTrack(track) {
    const value = { ...(track || {}) };
    if (!value.type) value.type = /^[A-Za-z0-9_-]{11}$/.test(value.id || "") ? "youtube" : "missing";
    if (!value.id) value.id = `${value.type}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    value.title = String(value.title || value.fileName || value.url || "Untitled");
    value.dur = Math.max(0, Math.round(+value.dur || 0));
    return value;
  }

  const cloneTracks = list => (list || []).map(track => normalizeTrack(JSON.parse(JSON.stringify(track))));
  const replaceBosstones = list => (list || []).map(track =>
    /mighty mighty bosstones/i.test(String(track && track.title || ""))
      ? normalizeTrack({ ...BOSSTONES_REPLACEMENT }) : track);
  // The bundled catalog's ORDER changes between releases (the owner
  // reshuffles it). save() stamps every playlist custom:true, so a stored
  // playlist that is still exactly the bundled catalog - the same Apple
  // ids, in any order - follows the current order here, keeping each
  // track's stored fields. Anything the user added or removed is left alone.
  const DEFAULT_IDS = DEFAULT_TRACKS.map(track => String(track.id));
  const followDefaultOrder = list => {
    if (!Array.isArray(list) || list.length !== DEFAULT_IDS.length) return list;
    const byId = new Map(list.map(track => [String(track && track.id), track]));
    if (byId.size !== DEFAULT_IDS.length || !DEFAULT_IDS.every(id => byId.has(id))) return list;
    return DEFAULT_IDS.map(id => byId.get(id));
  };
  function current() { return tracks[idx] || null; }

  function save() {
    try {
      localStorage.setItem(ACTIVE_KEY, JSON.stringify({
        v: TRACKS_V, custom: true, tracks, idx, name: activeName,
      }));
    } catch (_) {}
  }

  function saveLibrary() {
    try { localStorage.setItem(LIBRARY_KEY, JSON.stringify(savedPlaylists)); } catch (_) {}
  }

  function load() {
    try {
      const library = JSON.parse(localStorage.getItem(LIBRARY_KEY) || "null");
      if (library && typeof library === "object") {
        savedPlaylists = library;
        let libraryChanged = false;
        for (const playlist of Object.values(savedPlaylists)) {
          if (!playlist || !Array.isArray(playlist.tracks)) continue;
          const before = JSON.stringify(playlist.tracks);
          playlist.tracks = followDefaultOrder(replaceBosstones(playlist.tracks));
          if (JSON.stringify(playlist.tracks) !== before) libraryChanged = true;
        }
        if (libraryChanged) saveLibrary();
      }
    } catch (_) { savedPlaylists = {}; }
    try {
      const data = JSON.parse(localStorage.getItem(ACTIVE_KEY) || "null");
      if (data && Array.isArray(data.tracks) && (data.custom || data.v === TRACKS_V)) {
        const migrated = replaceBosstones(cloneTracks(data.tracks));
        const storedTracks = followDefaultOrder(migrated);
        // A reorder must not change which song is current.
        const playing = migrated[Math.max(0, data.idx || 0)];
        if (storedTracks !== migrated && playing)
          data.idx = Math.max(0, storedTracks.findIndex(track => track === playing));
        if (looksLikeLegacyDefault(data, storedTracks)) {
          tracks = DEFAULT_TRACKS.map(track => normalizeTrack({ ...track }));
          idx = Math.min(Math.max(0, data.idx || 0), tracks.length - 1);
          activeName = DEFAULT_NAME;
          save();
          return;
        }
        tracks = storedTracks;
        // Repair any known song whose id drifted to a dead/blocked upload.
        for (const track of tracks) {
          const good = ID_FIXUPS[track.title];
          if (good && youtubeTrack(track) && track.id !== good) { track.id = good; track.type = "youtube"; }
        }
        // A version bump means the resolution logic changed: cached per-service
        // links may be the very wrong picks the bump is fixing, so drop them
        // (they re-resolve on next play) while keeping the playlist itself.
        // Legacy keys from removed services (YouTube Music/Tidal/Apple) go too.
        if (data.v !== TRACKS_V)
          for (const track of tracks)
            for (const key of ["spotifyUri", "tidalUri", "ytMusicUri", "appleUri"])
              delete track[key];
        idx = tracks.length ? Math.min(Math.max(0, data.idx || 0), tracks.length - 1) : 0;
        activeName = data.name || "Current Playlist";
        save();
        return;
      }
    } catch (_) {}
    tracks = DEFAULT_TRACKS.map(track => normalizeTrack({ ...track }));
    idx = 0;
    activeName = DEFAULT_NAME;
  }

  function setMode(nextMode) {
    if (nextMode === "playing") autoSkipRun = 0; // a track actually played: reset the skip cascade
    if (mode !== nextMode) {
      mode = nextMode;
      if ("mediaSession" in navigator) {
        try { navigator.mediaSession.playbackState = mode === "playing" ? "playing" : "paused"; } catch (_) {}
      }
      cb.onState(mode);
    }
  }
  function updateMediaMetadata() {
    if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
    const track = current();
    if (!track) { navigator.mediaSession.metadata = null; return; }
    const parts = String(track.title || "Untitled").split(/\s+-\s+/, 2);
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.songTitle || (parts.length > 1 ? parts[1] : track.title),
        artist: track.artist || (parts.length > 1 ? parts[0] : "ClaudeAmp"),
        album: track.album || activeName || "ClaudeAmp",
      });
    } catch (_) {}
  }
  function wireMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const handlers = {
      play,
      pause,
      stop,
      previoustrack: prev,
      nexttrack: () => next(false),
      seekbackward: details => {
        const { t, d } = time();
        if (d) seekTo(Math.max(0, t - (details.seekOffset || 10)) / d);
      },
      seekforward: details => {
        const { t, d } = time();
        if (d) seekTo(Math.min(d, t + (details.seekOffset || 10)) / d);
      },
      seekto: details => {
        const { d } = time();
        if (d && Number.isFinite(details.seekTime)) seekTo(details.seekTime / d);
      },
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch (_) {}
    }
  }
  function sourceChanged() { updateMediaMetadata(); cb.onSource(current()); }
  function stopAudio(reset) {
    audio.pause();
    if (reset) try { audio.currentTime = 0; } catch (_) {}
  }
  function stopYoutube() {
    if (ytReady && player) try { player.pauseVideo(); } catch (_) {}
  }
  function stopServiceOutput() {
    if (!svc) return;
    svcPlayToken++;
    try { svc.pause().catch(() => {}); } catch (_) {}
  }
  function releaseAudioUrl() {
    if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
    audioObjectUrl = null;
  }

  function wireAudio() {
    audio.preload = "metadata";
    audio.addEventListener("playing", () => {
      if (current() && current().id === audioTrackId) setMode("playing");
    });
    audio.addEventListener("pause", () => {
      if (current() && current().id === audioTrackId && mode === "playing") setMode("paused");
    });
    audio.addEventListener("waiting", () => {
      if (current() && current().id === audioTrackId) setMode("loading");
    });
    audio.addEventListener("loadedmetadata", () => {
      const track = current();
      if (!track || track.id !== audioTrackId) return;
      // A 30s Apple preview must not overwrite the song's real duration.
      if (svc && svc.local && serviceTrack(track)) return;
      if (Number.isFinite(audio.duration) && Math.abs((track.dur || 0) - audio.duration) > 1) {
        track.dur = Math.round(audio.duration);
        save(); cb.onTrack();
      }
    });
    audio.addEventListener("ended", () => {
      if (repeat) { audio.currentTime = 0; audio.play().catch(() => {}); }
      else next(true);
    });
    audio.addEventListener("error", () => {
      const track = current();
      if (!track || track.id !== audioTrackId) return;
      badTracks.add(track.id);
      setMode("stopped");
      cb.onNote(track.type === "missing" ? "LOCAL FILE NEEDS RELINKING" :
        track.type === "apple" ? "ITUNES PREVIEW IS NO LONGER AVAILABLE" :
          "AUDIO FORMAT COULD NOT BE PLAYED");
      cb.onTrack();
    });
  }

  let appleLookup = null;
  function applyAppleResult(track, result) {
    if (!track || !result || !result.previewUrl) return false;
    track.url = result.previewUrl;
    track.storeUrl = result.link || track.storeUrl || "";
    track.artwork = result.artwork || track.artwork || "";
    track.artist = result.artists || track.artist || "";
    track.songTitle = result.name || track.songTitle || "";
    track.album = result.album || track.album || "";
    track.dur = Math.max(1, Math.round(result.previewDuration || 30));
    badTracks.delete(track.id);
    return true;
  }

  async function hydrateAppleTracks() {
    if (!cb.lookupApple || appleLookup) return appleLookup;
    const targets = tracks.filter(track => appleTrack(track) && !track.url);
    if (!targets.length) return [];
    appleLookup = (async () => {
      try {
        const results = await cb.lookupApple(targets.map(track => track.appleId));
        const byId = new Map((Array.isArray(results) ? results : [])
          .map(result => [String(result.id || ""), result]));
        let changed = false;
        for (const track of targets) {
          const result = byId.get(String(track.appleId));
          if (result) changed = applyAppleResult(track, result) || changed;
          else if (track.defaultPreview) badTracks.add(track.id);
        }
        if (changed) save();
        cb.onTrack(); sourceChanged();
        return results;
      } catch (_) {
        return [];
      } finally {
        appleLookup = null;
      }
    })();
    return appleLookup;
  }

  async function resolveApple(track, playNow) {
    if (!appleTrack(track)) return;
    if (track.url) { loadAudio(playNow); return; }
    setMode("loading");
    cb.onNote("LOADING ITUNES PREVIEW: " + track.title.slice(0, 36));
    await hydrateAppleTracks();
    if (current() !== track) return;
    if (track.url) { loadAudio(playNow); return; }
    badTracks.add(track.id); setMode("stopped"); cb.onTrack();
    cb.onNote("ITUNES PREVIEW UNAVAILABLE - PICK ANOTHER TRACK");
  }

  function init(callbacks) {
    Object.assign(cb, callbacks);
    load();
    wireAudio();
    wireMediaSession();
    cb.onTrack();
    sourceChanged();
    hydrateAppleTracks();

    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.onerror = markYoutubeOffline;
    window.onYouTubeIframeAPIReady = () => {
      try {
        const firstYoutube = tracks.find(youtubeTrack) || { id: YOUTUBE_PLACEHOLDER_ID };
        player = new YT.Player("yt-holder", {
          width: "100%", height: "100%", videoId: firstYoutube.id,
          playerVars: { controls: 0, disablekb: 1, rel: 0, playsinline: 1 },
          events: {
            onReady() {
              ytReady = true;
              loadedId = firstYoutube.id;
              player.setVolume(volume);
              if (pendingPlay && youtubeTrack(current())) { pendingPlay = false; play(); }
              sourceChanged(); cb.onTrack();
            },
            onStateChange(event) {
              if (!youtubeTrack(current()) || loadedId !== current().id) return;
              const state = YT.PlayerState;
              if (event.data === state.PLAYING) setMode("playing");
              else if (event.data === state.PAUSED) setMode("paused");
              else if (event.data === state.BUFFERING) setMode("loading");
              else if (event.data === state.ENDED) {
                if (repeat) { player.seekTo(0, true); player.playVideo(); }
                else next(true);
              } else if (event.data === state.CUED || event.data === state.UNSTARTED) setMode("stopped");
            },
            onError() {
              const track = current();
              if (!youtubeTrack(track)) return;
              badTracks.add(track.id);
              // With a bridge, heal in place: re-point the track at the
              // best official embeddable upload, like radio tuning does.
              if (cb.search && !relinking.has(track)) { relinkTrack(track); return; }
              cb.onNote("TRACK NOT EMBEDDABLE - SKIPPING");
              cb.onTrack();
              if (badTracks.size < tracks.length) next(true);
              else setMode("stopped");
            },
          },
        });
      } catch (_) { markYoutubeOffline(); }
    };
    document.head.appendChild(tag);
    setTimeout(() => { if (!ytReady && !ytFailed) markYoutubeOffline(); }, 8000);
  }

  function markYoutubeOffline() {
    if (ytReady) return;
    ytFailed = true;
    // With an external service active, YouTube being unreachable is irrelevant.
    if (youtubeTrack(current()) && !svc) setMode("offline");
    sourceChanged();
  }

  async function loadAudio(playNow) {
    const track = current();
    if (!track || !["local", "stream", "apple"].includes(track.type)) return;
    stopYoutube();
    stopServiceOutput();
    const token = ++audioLoadToken;
    if (audioTrackId !== track.id) {
      setMode("loading");
      releaseAudioUrl();
      let src = track.url || "";
      if (track.type === "local") {
        try {
          const blob = await MediaLibrary.getBlob(track.blobKey);
          if (!blob) throw new Error("missing blob");
          if (token !== audioLoadToken || current() !== track) return;
          audioObjectUrl = URL.createObjectURL(blob);
          src = audioObjectUrl;
        } catch (_) {
          track.type = "missing";
          badTracks.add(track.id);
          setMode("stopped"); save(); cb.onTrack(); sourceChanged();
          cb.onNote("LOCAL FILE NEEDS RELINKING");
          return;
        }
      }
      if (token !== audioLoadToken || current() !== track) return;
      if (!src) {
        badTracks.add(track.id); setMode("stopped"); cb.onTrack();
        cb.onNote(track.type === "apple" ? "ITUNES PREVIEW UNAVAILABLE" : "AUDIO SOURCE IS MISSING");
        return;
      }
      audioTrackId = track.id;
      audio.src = src;
      audio.load();
    }
    if (playNow) {
      audio.play().catch(() => {
        setMode("paused");
        cb.onNote("PRESS PLAY AGAIN TO START LOCAL AUDIO");
      });
    }
  }

  function loadYoutube(playNow) {
    const track = current();
    if (!youtubeTrack(track)) return;
    stopAudio(false);
    stopServiceOutput();
    if (ytFailed) { setMode("offline"); cb.onNote("YOUTUBE PLAYER OFFLINE"); return; }
    if (!ytReady) { pendingPlay = playNow; setMode("loading"); return; }
    if (loadedId !== track.id) {
      loadedId = track.id;
      if (playNow) player.loadVideoById(track.id);
      else player.cueVideoById(track.id);
    } else if (playNow) player.playVideo();
  }

  /* Radio tracks ship as artist+title only; the first play resolves one
     through the bridge's YouTube search, then it becomes a normal youtube
     track. Relinks and retunes use the same chooser. */
  /* OFFICIAL-FIRST ranking: YouTube hosts the official catalog on
     auto-generated "Artist - Topic" channels (official audio), VEVO, and the
     artists' own channels - and those uploads are usually embeddable. Rank
     official tiers first, then most-viewed (the canonical upload), instead of
     the old fewest-views heuristic that surfaced sketchy re-uploads. */
  function officialScore(video, artist) {
    const channel = String(video.channel || "").toUpperCase().trim();
    const title = String(video.title || "").toUpperCase();
    const a = String(artist || "").toUpperCase().trim();
    if (channel.endsWith(" - TOPIC")) return 4;   // auto-generated official audio
    if (channel.includes("VEVO")) return 3;
    if (a && (channel === a || channel === a + " OFFICIAL" ||
        (a.length > 3 && channel.startsWith(a)))) return 2;   // the artist's own channel
    if (/OFFICIAL (AUDIO|VIDEO|MUSIC VIDEO|HD VIDEO)/.test(title)) return 2;
    return 0;
  }
  /* Rank the search hits official-first (Topic/VEVO/official uploads, then
     most-viewed). Returns the ordered candidate list; chooseUpload takes the
     top, while relinkTrack walks the list testing real embeddability. */
  function rankUploads(results, track) {
    const usable = (Array.isArray(results) ? results : [])
      .filter(video => /^[A-Za-z0-9_-]{11}$/.test(video.id || ""));
    const words = String(track.query || track.title).toUpperCase()
      .split(/[^A-Z0-9']+/).filter(word => word.length > 1);
    const plausible = usable.filter(video => {
      if (video.duration < 60 || video.duration > 1200) return false;
      if (track.dur && Math.abs(video.duration - track.dur) > Math.max(45, track.dur * 0.4)) return false;
      // Match against title AND channel: official "Artist - Topic" uploads
      // title only the song name, with the artist in the channel.
      const hay = (String(video.title || "") + " " + String(video.channel || "")).toUpperCase();
      const hits = words.filter(word => hay.includes(word)).length;
      return words.length ? hits >= Math.ceil(words.length * 0.6) : true;
    });
    const artist = String(track.query || track.title).split(/\s+-\s+/, 2)[0];
    const pool = (plausible.length ? plausible : usable).slice(0, 12);
    pool.sort((a, b) =>
      officialScore(b, artist) - officialScore(a, artist) ||
      (Number.isFinite(b.views) ? b.views : -1) - (Number.isFinite(a.views) ? a.views : -1));
    return pool;
  }
  function chooseUpload(results, track) {
    return rankUploads(results, track)[0] || null;
  }

  /* Verify embeddability for real: load each candidate into a hidden, muted
     player and resolve with the FIRST that actually reaches PLAYING. This is
     how we stop committing a "replacement" that is itself embed-blocked - the
     #1 reason tracks stayed unavailable even after a relink. Topic uploads,
     which rank first, are almost always embeddable, so this usually resolves
     on the first probe. Returns the winning candidate object, or null. */
  let embedProbeSequence = 0;
  function probeEmbeddable(candidates, onTry) {
    return new Promise(resolve => {
      if (!candidates.length || !window.YT || !window.YT.Player || ytFailed) { resolve(null); return; }
      const holder = document.createElement("div");
      holder.id = "yt-embedprobe-" + (++embedProbeSequence);
      holder.style.cssText = "position:fixed;left:-9999px;top:0;width:64px;height:36px;";
      document.body.appendChild(holder);
      let i = 0, chk = null, timer = 0, settled = false, done = false;
      const finish = result => {
        if (done) return; done = true;
        clearTimeout(timer);
        try { if (chk) chk.destroy(); } catch (_) {}
        holder.remove();
        resolve(result);
      };
      const advance = () => { settled = true; i++; tryNext(); };
      const tryNext = () => {
        clearTimeout(timer);
        settled = false;
        if (i >= candidates.length) { finish(null); return; }
        if (onTry) onTry(candidates[i], i);
        timer = setTimeout(() => { if (!settled) advance(); }, 7000);
        try { chk.loadVideoById(candidates[i].id); }
        catch (_) { advance(); }
      };
      chk = new YT.Player(holder.id, {
        width: "64", height: "36",
        playerVars: { controls: 0, disablekb: 1, playsinline: 1 },
        events: {
          onReady() { try { chk.mute(); } catch (_) {} tryNext(); },
          onStateChange(e) {
            if (settled) return;
            if (e.data === YT.PlayerState.PLAYING) {
              settled = true; clearTimeout(timer);
              try { chk.stopVideo(); } catch (_) {}
              finish(candidates[i]);
            }
          },
          onError() { if (!settled) advance(); },
        },
      });
    });
  }

  /* Search results are promises, not proof. Verify each YouTube candidate in
     a real hidden IFrame player and only hand playable embeds to the UI. Four
     small workers keep the check responsive without opening a dozen players
     at once. */
  async function filterPlayableYoutube(results) {
    const input = (Array.isArray(results) ? results : []).slice(0, 10);
    if (!input.length || !ytReady || ytFailed) return [];
    const playable = new Array(input.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < input.length) {
        const at = cursor++;
        playable[at] = (await probeEmbeddable([input[at]])) ? input[at] : null;
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, input.length) }, worker));
    return playable.filter(Boolean).slice(0, 8);
  }

  /* A fixed-ID track whose upload refuses embedding gets the radio
     treatment once: search the bridge, take the best official embeddable
     upload, swap the id, and resume if it was playing. */
  const relinking = new Set();
  async function relinkTrack(track) {
    relinking.add(track);
    setMode("loading");
    cb.onNote("EMBED BLOCKED - FINDING A PLAYABLE VERSION: " + track.title.slice(0, 26));
    try {
      const ranked = rankUploads(await cb.search(track.query || track.title), track)
        .filter(video => video.id !== track.id)
        .slice(0, 6);
      if (!ranked.length) throw new Error("no alternate found");
      // Test candidates for real embeddability and take the first that plays,
      // so we never swap in another blocked upload.
      const choice = await probeEmbeddable(ranked, (video, i) =>
        cb.onNote("TESTING PLAYABLE VERSION " + (i + 1) + "/" + ranked.length + "..."));
      if (!choice) throw new Error("no embeddable version");
      if (!tracks.includes(track)) return;
      const wasCurrent = current() === track;
      badTracks.delete(track.id);
      track.id = choice.id;
      if (choice.duration) track.dur = Math.round(choice.duration);
      save(); cb.onTrack();
      if (wasCurrent) { sourceChanged(); play(); }
    } catch (_) {
      cb.onNote("NO EMBEDDABLE ALTERNATE - SKIPPING");
      cb.onTrack();
      // Cap the cascade: don't blow through the whole playlist auto-skipping
      // unavailable tracks. Stop after a few and let the user choose.
      autoSkipRun++;
      if (autoSkipRun < 4 && badTracks.size < tracks.length) next(true);
      else {
        autoSkipRun = 0;
        setMode("stopped");
        cb.onNote("SEVERAL TRACKS AREN'T AVAILABLE HERE - STOPPED. PICK ANOTHER OR CONNECT A SERVICE.");
      }
    }
  }

  let radioLookup = null;
  async function resolveRadio(track) {
    if (!cb.search) { cb.onNote("RADIO NEEDS THE DESKTOP APP OR BRIDGE.JS"); return; }
    if (radioLookup === track) return;
    radioLookup = track;
    setMode("loading");
    cb.onNote("TUNING: " + track.title.slice(0, 40));
    try {
      const choice = chooseUpload(await cb.search(track.query || track.title), track);
      if (!choice) throw new Error("no matches");
      if (!tracks.includes(track)) return; // the playlist changed mid-lookup
      const wasCurrent = current() === track;
      badTracks.delete(track.id);
      track.type = "youtube";
      track.id = choice.id;
      if (!track.dur && choice.duration) track.dur = Math.round(choice.duration);
      save(); cb.onTrack();
      if (wasCurrent) { sourceChanged(); play(); }
    } catch (error) {
      if (tracks.includes(track)) badTracks.add(track.id);
      setMode("stopped");
      cb.onNote("RADIO TUNE FAILED: " + String(error.message || "lookup error").toUpperCase().slice(0, 60));
    } finally {
      radioLookup = null;
    }
  }

  /* Walk the whole playlist and re-point every YouTube/radio entry at the
     best official upload the bridge search can find for it. */
  let retuneBusy = false;
  async function retuneAll() {
    if (!cb.search) { cb.onNote("RETUNE NEEDS THE DESKTOP APP OR BRIDGE.JS"); return; }
    if (retuneBusy) { cb.onNote("RETUNE IS ALREADY RUNNING"); return; }
    retuneBusy = true;
    stop();
    const targets = tracks.filter(track => youtubeTrack(track) || track.type === "radio");
    let done = 0, changed = 0, failed = 0;
    for (const track of targets) {
      if (!tracks.includes(track)) continue; // removed while we worked
      done++;
      cb.onNote("RETUNING " + done + "/" + targets.length + ": " + track.title.slice(0, 32));
      try {
        const choice = chooseUpload(await cb.search(track.query || track.title), track);
        if (!choice) throw new Error("no match");
        if (!tracks.includes(track)) continue;
        if (choice.id !== track.id) changed++;
        badTracks.delete(track.id);
        track.type = "youtube";
        track.id = choice.id;
        if (choice.duration) track.dur = Math.round(choice.duration);
        save(); cb.onTrack();
      } catch (_) { failed++; }
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    retuneBusy = false;
    cb.onNote("RETUNE DONE: " + changed + " RELINKED, " + failed + " FAILED, " +
      Math.max(0, targets.length - changed - failed) + " ALREADY BEST");
  }

  /* ------------------- external service playback ------------------- */
  function setService(adapter) {
    if (svc === adapter) return;
    const wasActive = mode === "playing" || mode === "loading";
    svcPlayToken++; // invalidate any in-flight playViaService for the old service
    if (svc) { try { svc.pause().catch(() => {}); } catch (_) {} }
    svc = adapter || null;
    clearInterval(svcPoll); svcPoll = 0; svcState = null; svcNearEnd = false;
    badTracks.clear(); cb.onTrack(); sourceChanged();
    if (svc) { stopYoutube(); stopAudio(true); }
    if (wasActive) play(); else setMode("stopped");
  }

  // Prefer a sane-length result whose title overlaps the query; among those
  // keep Spotify's own relevance order (first match wins).
  function pickServiceResult(results, track) {
    const usable = (Array.isArray(results) ? results : []).filter(item => item && item.uri);
    const clean = value => String(value || "").toUpperCase()
      .split(/[^A-Z0-9']+/).filter(word => word.length > 1);
    // "Artist - Title": the SONG TITLE tokens are the hard requirement. The
    // old any-50%-of-words filter let artist-only matches through, which is
    // exactly how interviews, covers and other songs got picked.
    const query = String(track.query || track.title);
    const parts = query.split(/\s+-\s+/, 2);
    const artistWords = parts.length > 1 ? clean(parts[0]) : [];
    const titleWords = clean(parts.length > 1 ? parts[1] : query);
    const wantSeconds = Math.max(0, Number(track.dur) || 0);
    let best = null, bestScore = -Infinity;
    usable.forEach((item, index) => {
      const seconds = (item.durationMs || 0) / 1000;
      if (seconds && (seconds < 45 || seconds > 1200)) return;
      const hay = (String(item.name || "") + " " + String(item.artists || "")).toUpperCase();
      const titleHits = titleWords.filter(word => hay.includes(word)).length;
      if (titleWords.length && titleHits < Math.max(1, Math.ceil(titleWords.length * 0.8))) return;
      let score = titleHits * 4 + artistWords.filter(word => hay.includes(word)).length * 2;
      if (wantSeconds && seconds) {
        // The right song runs about as long as the track we know.
        const drift = Math.abs(seconds - wantSeconds) / wantSeconds;
        if (drift < 0.05) score += 6;
        else if (drift < 0.15) score += 4;
        else if (drift < 0.3) score += 1;
        else if (drift > 0.6) score -= 4;
      }
      score -= index * 0.01; // provider ranking as the tiebreak
      if (score > bestScore) { bestScore = score; best = item; }
    });
    // No blind usable[0] fallback: playing the WRONG song reads as broken,
    // a clean "not found - skipping" does not.
    return best;
  }

  async function playViaService(track) {
    stopYoutube(); stopAudio(false);
    setMode("loading");
    // Drop the previous track's polled state so time()/the end-detector can't
    // act on stale numbers during the switch.
    svcState = null; svcNearEnd = false;
    const token = ++svcPlayToken;
    try {
      let uri = track[svcUriKey()];
      if (!uri) {
        const pick = pickServiceResult(await svc.search(track.query || track.title), track);
        if (!pick) throw new Error("no match");
        if (token !== svcPlayToken || current() !== track) return;
        uri = track[svcUriKey()] = pick.uri;
        if (pick.durationMs) track.dur = Math.round(pick.durationMs / 1000);
        // NOTE: a radio track keeps type "radio" — its id is not a YouTube id,
        // so retyping would corrupt it for the YouTube path later.
        save(); cb.onTrack();
      }
      if (svc.local) {
        // The resolved uri is a plain official audio stream (Apple previews):
        // play it in-skin through the audio element, whose event handlers
        // drive mode/auto-advance from here.
        releaseAudioUrl();
        audioLoadToken++;
        audioTrackId = track.id;
        audio.src = uri;
        audio.load();
        audio.play().catch(() => {
          setMode("paused");
          cb.onNote("PRESS PLAY AGAIN TO START THE PREVIEW");
        });
        cb.onNote(svcLabel() + " OFFICIAL PREVIEW (30S)");
        return;
      }
      await svc.play(uri);
      if (token !== svcPlayToken || current() !== track) return;
      if (svc.handoff) {
        // No transport API: the official track is now playing in the user's
        // own app; the skin can't drive or observe that playback.
        setMode("stopped");
        cb.onNote("PLAYING IN " + svcLabel() + " - USE NEXT/PREV HERE FOR MORE TRACKS");
        return;
      }
      setMode("playing");
      svcNearEnd = false;
      startServicePoll();
    } catch (error) {
      if (token !== svcPlayToken || current() !== track) return;
      const SVC = svcLabel();
      const message = String((error && error.message) || error);
      if (/no.?device/i.test(message)) {
        setMode("paused");
        cb.onNote("OPEN " + SVC + " ON ANY DEVICE, THEN PRESS PLAY AGAIN");
      } else if (/premium/i.test(message)) {
        setMode("stopped");
        cb.onNote(SVC + " PREMIUM IS REQUIRED FOR PLAYBACK");
      } else if (/no match/.test(message)) {
        badTracks.add(track.id);
        setMode("stopped");
        cb.onNote("NOT FOUND ON " + SVC + " - SKIPPING");
        cb.onTrack();
        if (badTracks.size < tracks.length) next(true);
      } else {
        setMode("stopped");
        cb.onNote(SVC + ": " + message.toUpperCase().slice(0, 56));
      }
    }
  }

  let serviceActivation = null;
  async function activateTrackService(track) {
    if (!track || track.type !== "spotify" || !cb.activateService || serviceActivation) return;
    setMode("loading");
    cb.onNote("CONNECTING TO SPOTIFY...");
    serviceActivation = (async () => {
      try {
        const adapter = await cb.activateService("spotify");
        if (!adapter) throw new Error("spotify is not connected");
        if (current() !== track) return;
        setService(adapter);
      } catch (error) {
        setMode("stopped");
        cb.onNote("SPOTIFY: " + String(error.message || error).toUpperCase().slice(0, 56));
      } finally {
        serviceActivation = null;
      }
    })();
    return serviceActivation;
  }

  function startServicePoll() {
    if (svcPoll) return;
    svcPoll = setInterval(async () => {
      if (!svc) { clearInterval(svcPoll); svcPoll = 0; return; }
      const track = current();
      // Only while actually playing: during "loading" a tick would read the
      // PREVIOUS track's state and flip modes/end-flags prematurely.
      if (!serviceTrack(track) || mode !== "playing") return;
      const tokenAtTick = svcPlayToken;
      let state;
      try { state = await svc.state(); } catch (_) { return; }
      if (tokenAtTick !== svcPlayToken || current() !== track) return; // stale tick
      svcState = state;
      if (state.playing) {
        setMode("playing");
        if (state.durationMs) svcNearEnd = state.progressMs > state.durationMs - 4500;
      } else if (mode === "playing") {
        if (svcNearEnd) {
          svcNearEnd = false;
          if (repeat && track[svcUriKey()]) svc.play(track[svcUriKey()]).catch(() => {});
          else next(true);
        } else setMode("paused");
      }
    }, 1200);
  }

  function play() {
    const track = current();
    if (!track) { cb.onNote("PLAYLIST IS EMPTY"); return; }
    if (track.type === "missing") { cb.onNote("LOCAL FILE NEEDS RELINKING"); return; }
    if (track.type === "spotify" && (!svc || svc.name !== "spotify")) {
      activateTrackService(track);
      return;
    }
    if (serviceTrack(track)) {
      // Resume in place after a pause; only a fresh/unresolved track (or one
      // stopped back to 0) restarts from the top. Handoff services (Tidal,
      // YT Music) have no transport, so "play" always re-opens the track.
      if (svc.local && mode === "paused" && audioTrackId === track.id) {
        audio.play().catch(() => {});
        return;
      }
      if (!svc.handoff && !svc.local && mode === "paused" && track[svcUriKey()]) {
        svc.resume().catch(() => { playViaService(track); });
        setMode("playing");
        startServicePoll();
        return;
      }
      playViaService(track);
      return;
    }
    if (track.type === "radio") { resolveRadio(track); return; }
    if (appleTrack(track) && !track.url) { resolveApple(track, true); return; }
    if (youtubeTrack(track)) loadYoutube(true);
    else loadAudio(true);
  }

  function playTrack(i) {
    if (i < 0 || i >= tracks.length) return;
    idx = i; save(); cb.onTrack(); sourceChanged(); play();
  }

  function pause() {
    if (serviceTrack(current())) {
      if (svc.local) { if (mode === "playing") audio.pause(); return; }
      if (svc.handoff) return; // playback lives in the user's own app
      if (mode === "playing") {
        svcPlayToken++;
        setMode("paused"); // optimistic; recover below if the relay failed
        svc.pause().catch(() => {
          svc.state().then(state => {
            if (mode === "paused" && state.playing) { svcState = state; setMode("playing"); }
          }).catch(() => {});
        });
      }
      return;
    }
    if (youtubeTrack(current())) {
      if (ytReady && mode === "playing") player.pauseVideo();
    } else if (mode === "playing") audio.pause();
  }

  function stop() {
    pendingPlay = false;
    if (svc && svc.local && serviceTrack(current())) {
      svcPlayToken++;
      stopAudio(true);
      setMode("stopped");
      return;
    }
    // Also covers a just-emptied playlist (current() === null): whatever the
    // service was playing for us must still stop.
    if (svc && (serviceTrack(current()) || !current())) {
      svcPlayToken++;
      svcState = null; svcNearEnd = false;
      if (mode === "playing" || mode === "loading" || mode === "paused") {
        svc.pause().catch(() => {});
        svc.seek(0).catch(() => {});
      }
      setMode("stopped");
      return;
    }
    if (youtubeTrack(current())) {
      if (ytReady && current()) {
        try { player.stopVideo(); player.cueVideoById(current().id); loadedId = current().id; } catch (_) {}
      }
    } else stopAudio(true);
    setMode("stopped");
  }

  function playable(track) { return track && track.type !== "missing" && !badTracks.has(track.id); }
  function pick(direction) {
    if (!tracks.length) return 0;
    if (tracks.length < 2 && !repeat) return idx;
    if (shuffle) {
      const candidates = tracks.map((track, i) => ({ track, i })).filter(row => row.i !== idx && playable(row.track));
      return candidates.length ? candidates[Math.floor(Math.random() * candidates.length)].i : idx;
    }
    let nextIndex = idx;
    for (let guard = 0; guard < tracks.length; guard++) {
      nextIndex = (nextIndex + direction + tracks.length) % tracks.length;
      if (playable(tracks[nextIndex])) return nextIndex;
    }
    return idx;
  }

  function selectIndex(nextIndex, keepPlaying) {
    if (!tracks.length) { idx = 0; stop(); cb.onTrack(); sourceChanged(); return; }
    idx = Math.max(0, Math.min(nextIndex, tracks.length - 1));
    save(); cb.onTrack(); sourceChanged();
    if (keepPlaying) play(); else setMode("stopped");
  }
  function next(auto) {
    if (!tracks.length) return;
    const wasActive = mode === "playing" || mode === "loading" || auto;
    selectIndex(pick(1), wasActive);
  }
  function prev() {
    if (!tracks.length) return;
    const wasActive = mode === "playing" || mode === "loading";
    if (time().t > 3) { seekTo(0); return; }
    selectIndex(pick(-1), wasActive);
  }

  function time() {
    const track = current();
    if (!track) return { t: 0, d: 0 };
    if (serviceTrack(track)) {
      if (svc.local) {
        // Apple previews play through the audio element; report its clock.
        return {
          t: audioTrackId === track.id && Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
          d: audioTrackId === track.id && Number.isFinite(audio.duration) && audio.duration
            ? audio.duration : 30,
        };
      }
      if (!svcState) return { t: 0, d: track.dur || 0 };
      // Extrapolate between 1.2s polls so the seek bar moves smoothly.
      const extra = mode === "playing" && svcState.playing
        ? (performance.now() - (svcState.at || performance.now())) : 0;
      return {
        t: Math.max(0, ((svcState.progressMs || 0) + extra) / 1000),
        d: (svcState.durationMs || 0) / 1000 || track.dur || 0,
      };
    }
    if (!youtubeTrack(track)) {
      return {
        t: audioTrackId === track.id && Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
        d: audioTrackId === track.id && Number.isFinite(audio.duration) ? audio.duration : track.dur || 0,
      };
    }
    if (!ytReady || ytFailed) return { t: 0, d: track.dur || 0 };
    try { return { t: player.getCurrentTime() || 0, d: player.getDuration() || track.dur || 0 }; }
    catch (_) { return { t: 0, d: track.dur || 0 }; }
  }

  function seekTo(fraction) {
    const track = current();
    if (!track) return;
    const duration = time().d;
    if (!duration) return;
    const value = Math.max(0, Math.min(1, fraction)) * duration;
    if (serviceTrack(track)) {
      if (svc.local) {
        if (audioTrackId === track.id) try { audio.currentTime = value; } catch (_) {}
        return;
      }
      const ms = Math.round(value * 1000);
      if (svcState) { svcState.progressMs = ms; svcState.at = performance.now(); }
      svc.seek(ms).catch(() => {});
      return;
    }
    if (youtubeTrack(track)) {
      if (ytReady && !ytFailed) player.seekTo(value, true);
    } else if (audioTrackId === track.id) audio.currentTime = value;
  }

  function setVolume(value) {
    volume = Math.round(Math.max(0, Math.min(1, value)) * 100);
    audio.volume = volume / 100;
    if (ytReady) try { player.setVolume(volume); } catch (_) {}
    if (svc) svc.setVolume(volume).catch(() => {});
  }

  function parseId(input) {
    input = (input || "").trim();
    const match = input.match(/(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/);
    if (match) return match[1];
    return /^[A-Za-z0-9_-]{11}$/.test(input) ? input : null;
  }

  function addTrack(input, title) {
    const value = String(input || "").trim();
    const videoId = parseId(value);
    let track;
    if (videoId) track = { type: "youtube", id: videoId, title: String(title || "").trim() || "YouTube " + videoId, dur: 0 };
    else if (/^https?:\/\//i.test(value)) track = {
      type: "stream", id: "stream:" + value, url: value,
      title: String(title || "").trim() || value.replace(/^https?:\/\//i, ""), dur: 0,
    };
    else return false;
    tracks.push(normalizeTrack(track));
    if (tracks.length === 1) idx = 0;
    save(); cb.onTrack(); sourceChanged();
    return true;
  }

  function addTracks(newTracks) {
    const added = [];
    for (const raw of newTracks || []) {
      const track = normalizeTrack(raw);
      const fileName = String(track.fileName || "").toLowerCase();
      const missingIndex = fileName ? tracks.findIndex(item => item.type === "missing" &&
        String(item.fileName || item.ref || "").toLowerCase() === fileName) : -1;
      if (missingIndex >= 0) { tracks[missingIndex] = track; added.push(missingIndex); }
      else { tracks.push(track); added.push(tracks.length - 1); }
    }
    if (tracks.length && idx >= tracks.length) idx = tracks.length - 1;
    save(); cb.onTrack(); sourceChanged();
    return added;
  }

  function removeTracks(indices) {
    const remove = new Set(Array.from(indices || []).filter(i => i >= 0 && i < tracks.length));
    if (!remove.size) return;
    const active = current();
    const wasActive = mode === "playing" || mode === "loading";
    tracks = tracks.filter((_, i) => !remove.has(i));
    idx = active ? tracks.indexOf(active) : 0;
    if (idx < 0) idx = Math.min(Math.min(...remove), Math.max(0, tracks.length - 1));
    badTracks.clear();
    if (!tracks.length) stop();
    else if (!tracks.includes(active)) {
      if (wasActive) play();
      else setMode("stopped");
    }
    save(); cb.onTrack(); sourceChanged();
  }

  function renameTrack(i, title) {
    if (i < 0 || i >= tracks.length || !String(title || "").trim()) return;
    tracks[i].title = String(title).trim();
    save(); cb.onTrack();
  }

  function updateDuration(i, duration) {
    if (i < 0 || i >= tracks.length || !Number.isFinite(duration) || duration <= 0) return;
    tracks[i].dur = Math.round(duration);
    save();
  }

  function replaceTracks(list, name) {
    stop();
    tracks = cloneTracks(list);
    idx = 0;
    activeName = String(name || "Current Playlist");
    badTracks.clear();
    save(); cb.onTrack(); sourceChanged();
  }

  function moveTrack(from, to) {
    if (from < 0 || from >= tracks.length || to < 0 || to >= tracks.length || from === to) return;
    const active = current();
    const [track] = tracks.splice(from, 1);
    tracks.splice(to, 0, track);
    idx = active ? tracks.indexOf(active) : 0;
    save(); cb.onTrack();
  }

  function sortTracks(kind) {
    const active = current();
    const compare = kind === "duration" ? (a, b) => (a.dur || 0) - (b.dur || 0) :
      kind === "file" ? (a, b) => String(a.fileName || a.title).localeCompare(String(b.fileName || b.title)) :
      (a, b) => String(a.title).localeCompare(String(b.title));
    tracks.sort(compare);
    idx = active ? tracks.indexOf(active) : 0;
    save(); cb.onTrack();
  }

  function randomizeTracks() {
    const active = current();
    for (let i = tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
    }
    idx = active ? tracks.indexOf(active) : 0;
    save(); cb.onTrack();
  }

  function cropTo(indices) {
    const keep = new Set(Array.from(indices || []));
    replaceTracks(tracks.filter((_, i) => keep.has(i)), activeName);
  }
  function resetTracks() {
    replaceTracks(DEFAULT_TRACKS.map(track => ({ ...track })), "ClaudeAmp 90s Previews");
    hydrateAppleTracks();
  }

  function savePlaylist(name) {
    name = String(name || "").trim();
    if (!name) return false;
    activeName = name;
    savedPlaylists[name] = { name, tracks: cloneTracks(tracks), updated: Date.now() };
    saveLibrary(); save();
    return true;
  }
  function loadPlaylist(name) {
    const playlist = savedPlaylists[name];
    if (!playlist || !Array.isArray(playlist.tracks)) return false;
    replaceTracks(playlist.tracks, name);
    return true;
  }
  function deletePlaylist(name) {
    if (!savedPlaylists[name]) return false;
    delete savedPlaylists[name]; saveLibrary(); return true;
  }
  function newPlaylist(name) {
    replaceTracks([], name || "Untitled Playlist");
    if (name) savePlaylist(name);
  }

  /* Sequentially test every YouTube track in a hidden muted player and
     report the ones the IFrame player refuses: 101/150 = embedding
     disabled, 100 = removed/private, 2/5 = bad id. Local/stream entries
     are skipped. Runs in the user's browser; stop playback first. */
  function checkEmbeds(cb) {
    if (!window.YT || !window.YT.Player || ytFailed) {
      cb({ error: "youtube player unavailable (offline?)" });
      return;
    }
    const REASON = { 101: "EMBED-BLOCKED", 150: "EMBED-BLOCKED",
                     100: "UNAVAILABLE", 2: "BAD-ID", 5: "PLAYER-ERROR" };
    const list = tracks
      .map((track, index) => ({ track, n: index + 1 }))
      .filter(item => youtubeTrack(item.track));
    if (!list.length) { cb({ done: true, blocked: [], tested: 0 }); return; }
    const holder = document.createElement("div");
    holder.id = "yt-embedcheck";
    holder.style.cssText =
      "position:fixed;left:-9999px;top:0;width:64px;height:36px;";
    document.body.appendChild(holder);
    const blocked = [];
    let i = 0, chk = null, timer = 0, settled = false;
    const finish = () => {
      clearTimeout(timer);
      try { if (chk) chk.destroy(); } catch (_) {}
      holder.remove();
      cb({ done: true, blocked, tested: list.length });
    };
    const next = () => {
      clearTimeout(timer);
      settled = false;
      if (i >= list.length) { finish(); return; }
      const item = list[i];
      cb({ i, total: list.length, title: item.track.title });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        blocked.push({ n: item.n, id: item.track.id,
                       title: item.track.title, reason: "TIMEOUT" });
        i++; next();
      }, 10000);
      try { chk.loadVideoById(item.track.id); } catch (_) {}
    };
    chk = new YT.Player("yt-embedcheck", {
      width: "64", height: "36",
      playerVars: { controls: 0, disablekb: 1, playsinline: 1 },
      events: {
        onReady() { try { chk.mute(); } catch (_) {} next(); },
        onStateChange(e) {
          if (settled) return;
          if (e.data === YT.PlayerState.PLAYING) {
            settled = true;
            clearTimeout(timer);
            try { chk.stopVideo(); } catch (_) {}
            i++; next();
          }
        },
        onError(e) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const item = list[i];
          blocked.push({ n: item.n, id: item.track.id, title: item.track.title,
                         reason: REASON[e.data] || ("ERROR-" + e.data) });
          i++; next();
        },
      },
    });
  }

  return {
    init, play, pause, stop, next, prev, playTrack, seekTo, setVolume, checkEmbeds, retuneAll,
    filterPlayableYoutube, hydrateAppleTracks,
    setService,
    get service() { return svc ? svc.name : ""; },
    get servicePreview() { return !!(current() && current().type === "apple") || !!(svc && svc.local); },
    time, addTrack, addTracks, removeTracks, renameTrack, updateDuration, replaceTracks,
    moveTrack, sortTracks, randomizeTracks, cropTo, resetTracks,
    savePlaylist, loadPlaylist, deletePlaylist, newPlaylist, parseId,
    get tracks() { return tracks; },
    get idx() { return idx; },
    get mode() { return mode; },
    get current() { return current(); },
    get activeName() { return activeName; },
    get playlistNames() { return Object.keys(savedPlaylists).sort((a, b) => a.localeCompare(b)); },
    get shuffle() { return shuffle; }, set shuffle(value) { shuffle = !!value; },
    get repeat() { return repeat; }, set repeat(value) { repeat = !!value; },
    get offline() { return ytFailed && !svc && youtubeTrack(current()); },
    isBad(id) {
      const track = tracks.find(item => item.id === id);
      return badTracks.has(id) || !!(track && track.type === "missing");
    },
  };
})();
