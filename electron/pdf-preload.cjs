const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('slatePdf', {
  document: () => ipcRenderer.invoke('pdf:document'),
  ready: error => ipcRenderer.send('pdf:ready', error),
});
