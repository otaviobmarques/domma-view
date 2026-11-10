const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dvBar', { end: () => ipcRenderer.send('dv:bar-end') });
