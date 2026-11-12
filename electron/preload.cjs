const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('slate', {
  platform: process.platform,
  ready: () => ipcRenderer.invoke('document:ready'),
  open: () => ipcRenderer.invoke('document:open'),
  newDocument: (draft) => ipcRenderer.invoke('document:new', draft),
  save: (content, saveAs, options) => ipcRenderer.invoke('document:save', content, saveAs, options),
  exportPdf: (content, id) => ipcRenderer.invoke('document:export-pdf', content, id),
  activateTab: (id) => ipcRenderer.invoke('document:activate', id),
  closeTab: (id) => ipcRenderer.invoke('document:close', id),
  closeTabs: (ids, keepId) => ipcRenderer.invoke('document:close-many', ids, keepId),
  reorderTabs: (ids) => ipcRenderer.invoke('document:reorder', ids),
  reload: () => ipcRenderer.invoke('document:reload'),
  setDirty: (id, dirty) => ipcRenderer.send('document:dirty', id, dirty),
  onDocument: (callback) => subscribe('document:loaded', callback),
  onCommand: (callback) => subscribe('document:command', callback),
  onDiskChange: (callback) => subscribe('document:disk-change', callback),
  onConfirmChanges: (callback) => subscribe('document:confirm-changes', callback),
  confirmChanges: (id, accepted) => ipcRenderer.invoke('document:confirm-result', id, accepted),
  onError: (callback) => subscribe('document:error', callback),
  folderReady: () => ipcRenderer.invoke('folder:ready'),
  openFolder: () => ipcRenderer.invoke('folder:open'),
  listFolder: (relativePath) => ipcRenderer.invoke('folder:list', relativePath),
  searchFolder: (query, refresh) => ipcRenderer.invoke('folder:search', query, refresh),
  openFile: (relativePath) => ipcRenderer.invoke('folder:open-file', relativePath),
  createEntry: (parent, name, kind) => ipcRenderer.invoke('folder:create', parent, name, kind),
  renameEntry: (path, name) => ipcRenderer.invoke('folder:rename', path, name),
  moveEntry: (path, destination) => ipcRenderer.invoke('folder:move', path, destination),
  trashEntry: (path) => ipcRenderer.invoke('folder:trash', path),
  onFolder: (callback) => subscribe('folder:changed', callback),
});
