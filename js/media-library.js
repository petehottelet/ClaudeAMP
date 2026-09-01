/* ClaudeAmp — durable local media, lightweight tags, and playlist files. */
"use strict";

const MediaLibrary = (() => {
  const DB_NAME = "claudeamp.media";
  const DB_VERSION = 1;
  const STORE = "files";
  const AUDIO_EXT = /\.(mp3|wav|wave|ogg|oga|opus|m4a|mp4|aac|flac|webm)$/i;
  const PLAYLIST_EXT = /\.(m3u|m3u8|pls|json)$/i;

  function uid() {
    if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE))
          request.result.createObjectStore(STORE, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Media database unavailable"));
    });
  }

  async function withStore(mode, action) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Media database operation failed"));
      tx.oncomplete = () => db.close();
      tx.onabort = () => { db.close(); reject(tx.error || new Error("Media database transaction aborted")); };
    });
  }

  function putFile(file, key) {
    return withStore("readwrite", store => store.put({
      key,
      blob: file,
      fileName: file.name,
      type: file.type,
      size: file.size,
      lastModified: file.lastModified,
    }));
  }

  async function getBlob(key) {
    const row = await withStore("readonly", store => store.get(key));
    return row && row.blob;
  }

  function cleanText(value) {
    return String(value || "").replace(/^\uFEFF/, "").replace(/\0/g, "").trim();
  }

  function decodeTag(bytes) {
    if (!bytes || !bytes.length) return "";
    const encoding = bytes[0];
    const body = bytes.slice(1);
    try {
      if (encoding === 1) return cleanText(new TextDecoder("utf-16").decode(body));
      if (encoding === 2) return cleanText(new TextDecoder("utf-16be").decode(body));
      if (encoding === 3) return cleanText(new TextDecoder("utf-8").decode(body));
      return cleanText(new TextDecoder("windows-1252").decode(body));
    } catch (_) {
      return cleanText(String.fromCharCode(...body.slice(0, 512)));
    }
  }

  function syncSafe(bytes, offset) {
    return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) |
      ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
  }

  async function readTags(file) {
    const tags = {};
    try {
      const header = new Uint8Array(await file.slice(0, 10).arrayBuffer());
      if (String.fromCharCode(...header.slice(0, 3)) === "ID3") {
        const version = header[3];
        const tagSize = Math.min(syncSafe(header, 6) + 10, file.size, 1024 * 1024);
        const bytes = new Uint8Array(await file.slice(0, tagSize).arrayBuffer());
        let pos = 10;
        const names = { TIT2: "songTitle", TPE1: "artist", TALB: "album", TRCK: "trackNo" };
        while (pos + 10 <= bytes.length) {
          const id = String.fromCharCode(...bytes.slice(pos, pos + 4));
          if (!/^[A-Z0-9]{4}$/.test(id)) break;
          const size = version === 4 ? syncSafe(bytes, pos + 4) :
            (((bytes[pos + 4] << 24) >>> 0) + (bytes[pos + 5] << 16) +
             (bytes[pos + 6] << 8) + bytes[pos + 7]);
          if (!size || pos + 10 + size > bytes.length) break;
          if (names[id]) tags[names[id]] = decodeTag(bytes.slice(pos + 10, pos + 10 + size));
          pos += 10 + size;
        }
      }
    } catch (_) {}

    try {
      if ((!tags.songTitle || !tags.artist) && file.size >= 128) {
        const tail = new Uint8Array(await file.slice(file.size - 128).arrayBuffer());
        if (String.fromCharCode(...tail.slice(0, 3)) === "TAG") {
          const latin = bytes => cleanText(new TextDecoder("windows-1252").decode(bytes));
          if (!tags.songTitle) tags.songTitle = latin(tail.slice(3, 33));
          if (!tags.artist) tags.artist = latin(tail.slice(33, 63));
          if (!tags.album) tags.album = latin(tail.slice(63, 93));
        }
      }
    } catch (_) {}
    return tags;
  }

  function durationOf(blob) {
    return new Promise(resolve => {
      const audio = new Audio();
      const url = URL.createObjectURL(blob);
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        audio.removeAttribute("src");
        resolve(Number.isFinite(value) ? Math.round(value) : 0);
      };
      audio.preload = "metadata";
      audio.onloadedmetadata = () => finish(audio.duration);
      audio.onerror = () => finish(0);
      audio.src = url;
      setTimeout(() => finish(0), 12000);
    });
  }

  function fileStem(name) {
    return String(name || "TRACK").replace(/\.[^.]+$/, "");
  }

  async function importFile(file) {
    const blobKey = uid();
    const [tags, dur] = await Promise.all([readTags(file), durationOf(file)]);
    await putFile(file, blobKey);
    const songTitle = tags.songTitle || fileStem(file.name);
    return {
      type: "local",
      id: "local:" + blobKey,
      blobKey,
      fileName: file.name,
      mime: file.type || "audio/*",
      size: file.size,
      lastModified: file.lastModified,
      songTitle,
      artist: tags.artist || "",
      album: tags.album || "",
      trackNo: tags.trackNo || "",
      title: tags.artist ? `${tags.artist} - ${songTitle}` : songTitle,
      dur,
    };
  }

  async function importFiles(files, onProgress) {
    const audioFiles = Array.from(files || []).filter(isAudioFile);
    const tracks = [];
    for (let i = 0; i < audioFiles.length; i++) {
      if (onProgress) onProgress(i + 1, audioFiles.length, audioFiles[i].name);
      try { tracks.push(await importFile(audioFiles[i])); } catch (_) {}
    }
    return tracks;
  }

  function isAudioFile(file) {
    if (!file) return false;
    const name = file.name || "";
    // Windows reports M3U/PLS files with audio/* MIME types. Extension takes
    // precedence so the playlist document never becomes a bogus audio track.
    if (PLAYLIST_EXT.test(name)) return false;
    return (file.type || "").startsWith("audio/") || AUDIO_EXT.test(name);
  }

  function isPlaylistFile(file) {
    return !!file && PLAYLIST_EXT.test(file.name || "");
  }

  function basename(ref) {
    const clean = String(ref || "").split(/[?#]/)[0].replace(/\\/g, "/");
    try { return decodeURIComponent(clean.slice(clean.lastIndexOf("/") + 1)); }
    catch (_) { return clean.slice(clean.lastIndexOf("/") + 1); }
  }

  function parseM3u(text) {
    const entries = [];
    let pending = null;
    for (const raw of String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("#EXTINF:")) {
        const match = line.match(/^#EXTINF:([\d-]+)\s*,\s*(.*)$/i);
        pending = match ? { dur: Math.max(0, +match[1] || 0), title: match[2].trim() } : null;
      } else if (!line.startsWith("#")) {
        entries.push({ ref: line, title: pending && pending.title, dur: pending && pending.dur });
        pending = null;
      }
    }
    return entries;
  }

  function parsePls(text) {
    const rows = {};
    for (const raw of String(text || "").split(/\r?\n/)) {
      const match = raw.match(/^(File|Title|Length)(\d+)=(.*)$/i);
      if (!match) continue;
      const i = +match[2];
      rows[i] ||= {};
      rows[i][match[1].toLowerCase()] = match[3].trim();
    }
    return Object.keys(rows).sort((a, b) => a - b).map(i => ({
      ref: rows[i].file,
      title: rows[i].title,
      dur: Math.max(0, +rows[i].length || 0),
    })).filter(entry => entry.ref);
  }

  function parsePlaylist(text, fileName) {
    if (/\.json$/i.test(fileName || "")) {
      const parsed = JSON.parse(text);
      const tracks = Array.isArray(parsed) ? parsed : parsed.tracks;
      if (!Array.isArray(tracks)) throw new Error("Not a ClaudeAmp playlist");
      return tracks.map(track => ({ track }));
    }
    return /\.pls$/i.test(fileName || "") ? parsePls(text) : parseM3u(text);
  }

  function sourceFor(track) {
    if (track.type === "youtube" || (!track.type && track.id))
      return "https://www.youtube.com/watch?v=" + track.id;
    if (track.type === "stream") return track.url;
    return track.fileName || track.ref || track.title;
  }

  function exportM3u(tracks) {
    const lines = ["#EXTM3U"];
    for (const track of tracks) {
      lines.push(`#EXTINF:${Math.round(track.dur || -1)},${track.title || "Untitled"}`);
      lines.push(sourceFor(track));
    }
    return lines.join("\r\n") + "\r\n";
  }

  function exportPls(tracks) {
    const lines = ["[playlist]"];
    tracks.forEach((track, i) => {
      lines.push(`File${i + 1}=${sourceFor(track)}`);
      lines.push(`Title${i + 1}=${track.title || "Untitled"}`);
      lines.push(`Length${i + 1}=${Math.round(track.dur || -1)}`);
    });
    lines.push(`NumberOfEntries=${tracks.length}`, "Version=2");
    return lines.join("\r\n") + "\r\n";
  }

  function safeName(value) {
    return String(value || "ClaudeAmp Playlist").replace(/[<>:"/\\|?*]+/g, "-").trim() || "ClaudeAmp Playlist";
  }

  function download(fileName, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return {
    getBlob, importFiles, isAudioFile, isPlaylistFile, parsePlaylist,
    exportM3u, exportPls, download, safeName, basename,
  };
})();
