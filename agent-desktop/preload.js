// Ponte mínima entre a página do agente (servidor Domma) e o Windows. Nada além disto fica exposto.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dvNative', {
  version: ipcRenderer.sendSync('dv:version'),
  platform: process.platform,
  info: () => ipcRenderer.invoke('dv:info'),
  input: (m) => ipcRenderer.send('dv:input', m),
  nextScreen: () => ipcRenderer.invoke('dv:next-screen'),
  blackscreen: (on) => ipcRenderer.send('dv:blackscreen', !!on),
  reboot: () => ipcRenderer.send('dv:reboot'),
  sessionBar: (info) => ipcRenderer.send('dv:session-bar', info || null),
  attention: (soft) => ipcRenderer.send('dv:attention', !!soft),
  setupCode: () => ipcRenderer.invoke('dv:setup-code'),
  getServer: () => ipcRenderer.invoke('dv:get-server'),
  setServer: (url) => ipcRenderer.invoke('dv:set-server', url),
  retry: () => ipcRenderer.send('dv:retry'),
  onEndRequest: (cb) => ipcRenderer.on('dv:end-request', () => cb()),
  onAskSupport: (cb) => ipcRenderer.on('dv:ask-support', () => cb()),
});
