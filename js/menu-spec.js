/* ClaudeAmp — one menu definition, two renderings: the Winamp-style
   in-app hamburger (js/app.js) and the native macOS menu bar
   (electron/main.cjs). Loaded as a browser script by index.html AND
   required by the main process, so labels, ids, and shortcuts can never
   drift between the two.

   Item shape: { id, label, accelerator?, kind? } with kind "action"
   (default), "check", or "radio" (+ group). Every id must have a
   handler in js/app.js's MENU_COMMANDS - test/menu-spec.test.cjs pins
   that, along with id and accelerator uniqueness and the absence of a
   macOS Services item (this app registers no services). */
"use strict";
/* global module */

var CLAUDEAMP_MENU = [
  { menu: "app", items: [
    { id: "about", label: "About ClaudeAmp…" },
    { type: "separator" },
    { id: "settings", label: "Settings…", accelerator: "CmdOrCtrl+," },
  ] },
  { menu: "File", items: [
    { id: "open-audio", label: "Open Audio Files…", accelerator: "CmdOrCtrl+O" },
    { type: "separator" },
    { id: "saved-playlists", label: "Saved Playlists…", accelerator: "CmdOrCtrl+L" },
    { id: "jump-to-track", label: "Jump to Track…", accelerator: "CmdOrCtrl+J" },
  ] },
  { menu: "View", items: [
    { id: "toggle-win-main", label: "Main Window", kind: "check", accelerator: "CmdOrCtrl+1" },
    { id: "toggle-win-chat", label: "Chat", kind: "check", accelerator: "CmdOrCtrl+2" },
    { id: "toggle-win-eq", label: "Equalizer", kind: "check", accelerator: "CmdOrCtrl+3" },
    { id: "toggle-win-pl", label: "Playlist", kind: "check", accelerator: "CmdOrCtrl+4" },
    { id: "toggle-win-usage", label: "Usage Monitor", kind: "check", accelerator: "CmdOrCtrl+5" },
    { id: "toggle-win-mb", label: "Visualization", kind: "check", accelerator: "CmdOrCtrl+6" },
    { id: "toggle-win-term", label: "Terminal", kind: "check", accelerator: "CmdOrCtrl+7" },
    { type: "separator" },
    { id: "mode-chat", label: "Mode: AI Chat", kind: "radio", group: "mode" },
    { id: "mode-shell", label: "Mode: Real Terminal", kind: "radio", group: "mode" },
    { type: "separator" },
    { id: "zoom-1", label: "Zoom 1x", kind: "radio", group: "zoom", accelerator: "CmdOrCtrl+0" },
    { id: "zoom-1.5", label: "Zoom 1.5x", kind: "radio", group: "zoom" },
    { id: "zoom-2", label: "Zoom 2x", kind: "radio", group: "zoom" },
    { id: "zoom-2.5", label: "Zoom 2.5x", kind: "radio", group: "zoom" },
    { id: "zoom-3", label: "Zoom 3x", kind: "radio", group: "zoom" },
    { type: "separator" },
    { id: "zoom-in", label: "Zoom In", accelerator: "CmdOrCtrl+=" },
    { id: "zoom-out", label: "Zoom Out", accelerator: "CmdOrCtrl+-" },
  ] },
  { menu: "Account", items: [
    { id: "logout", label: "Log Out" },
  ] },
  { menu: "Help", items: [
    { id: "help-docs", label: "ClaudeAmp Docs" },
    { id: "help-changelog", label: "Changelog" },
    { id: "help-issue", label: "Report a Bug" },
  ] },
  // Not part of the menu bar: the macOS Dock menu draws from these.
  { menu: "dock", items: [
    { id: "play-pause", label: "Play / Pause" },
    { id: "next-track", label: "Next Track" },
    { id: "prev-track", label: "Previous Track" },
    { type: "separator" },
    { id: "show-terminal", label: "Show Terminal" },
  ] },
];

if (typeof module !== "undefined" && module.exports) module.exports = CLAUDEAMP_MENU;
if (typeof window !== "undefined") window.CLAUDEAMP_MENU = CLAUDEAMP_MENU;
