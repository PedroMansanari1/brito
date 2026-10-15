const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("brito", {
  load: () => ipcRenderer.invoke("store:load"),
  save: (state) => ipcRenderer.invoke("store:save", state),
  pickFolder: () => ipcRenderer.invoke("pickFolder"),
  env: () => ipcRenderer.invoke("env"),
  start: (sessionId, root, claudeId) => ipcRenderer.invoke("backend:start", { sessionId, root, claudeId }),
  write: (sessionId, msg) => ipcRenderer.send("backend:write", { sessionId, msg }),
  stop: (sessionId) => ipcRenderer.send("backend:stop", sessionId),
  onEvent: (cb) => ipcRenderer.on("brito:event", (_e, p) => cb(p.sessionId, p.ev)),
});
