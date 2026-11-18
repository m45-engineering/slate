const { contextBridge, ipcRenderer } = require('electron');
const channel = process.argv.find(argument => argument.startsWith('--slate-pdf-channel='))?.split('=')[1];

contextBridge.exposeInMainWorld('slatePdf', {
  document: () => ipcRenderer.invoke(`${channel}:document`),
  ready: error => ipcRenderer.send(`${channel}:ready`, error),
});
