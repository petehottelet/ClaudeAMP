/* ClaudeAmp — narrow native shell bridge. */
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("claudeampNative", {
  platform: process.platform,
  verifyMode: process.argv.includes("--claudeamp-verify"),
  quit: () => ipcRenderer.send("claudeamp:quit"),
  updateShape: rects => ipcRenderer.send("claudeamp:update-shape", rects),
  setInteractive: on => ipcRenderer.send("claudeamp:set-interactive", !!on),
  setHeld: on => ipcRenderer.send("claudeamp:set-held", !!on),
  onBoundsChanged: callback => {
    const listener = () => callback();
    ipcRenderer.on("claudeamp:bounds-changed", listener);
    return () => ipcRenderer.removeListener("claudeamp:bounds-changed", listener);
  },
});

contextBridge.exposeInMainWorld("claudeAmpDesktop", Object.freeze({
  isDesktop: true,
  minimize: () => ipcRenderer.send("claudeamp:minimize"),
  close: () => ipcRenderer.send("claudeamp:close"),
  chooseWorkspace: () => ipcRenderer.invoke("claudeamp:choose-workspace"),
  bridgeToken: () => ipcRenderer.invoke("claudeamp:bridge-token"),
  setAccess: value => ipcRenderer.invoke("claudeamp:set-access", value),
  getKeys: () => ipcRenderer.invoke("claudeamp:get-keys"),
  setKey: payload => ipcRenderer.invoke("claudeamp:set-key", payload),
  openClaudeLogin: () => ipcRenderer.invoke("claudeamp:open-claude-login"),
  openCodexLogin: () => ipcRenderer.invoke("claudeamp:open-codex-login"),
  onClaudeLoginComplete: callback => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on("claudeamp:claude-login-complete", listener);
    return () => ipcRenderer.removeListener("claudeamp:claude-login-complete", listener);
  },
  onCodexLoginComplete: callback => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on("claudeamp:codex-login-complete", listener);
    return () => ipcRenderer.removeListener("claudeamp:codex-login-complete", listener);
  },
  onUpdateAvailable: callback => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on("claudeamp:update-available", listener);
    return () => ipcRenderer.removeListener("claudeamp:update-available", listener);
  },
}));

contextBridge.exposeInMainWorld("claudeampTerm", Object.freeze({
  open: size => ipcRenderer.invoke("claudeamp:term-open", size),
  input: data => ipcRenderer.send("claudeamp:term-input", data),
  resize: size => ipcRenderer.send("claudeamp:term-resize", size),
  close: () => ipcRenderer.send("claudeamp:term-close"),
  onData: callback => { ipcRenderer.on("claudeamp:term-data", (_event, data) => callback(data)); },
  onExit: callback => { ipcRenderer.on("claudeamp:term-exit", (_event, info) => callback(info)); },
  onDebug: callback => { ipcRenderer.on("claudeamp:term-debug", (_event, line) => callback(line)); },
}));
