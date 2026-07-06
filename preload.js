const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('motrexPlayer', {
  onPlayVideo: (callback) => {
    ipcRenderer.on('video:play', (_event, payload) => callback(payload));
  }
});
