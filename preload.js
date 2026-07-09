const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('motrexPlayer', {
  onPlayVideo: (callback) => {
    ipcRenderer.on('video:play', (_event, payload) => callback(payload));
  },
  onVideoStatus: (callback) => {
    ipcRenderer.on('video:status', (_event, status) => callback(status));
  },
  onMqttStatus: (callback) => {
    ipcRenderer.on('mqtt:status', (_event, status) => callback(status));
  }
});
