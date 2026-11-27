const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('slate', {
  platform: process.platform,
  workspaceId: process.argv.find(argument => argument.startsWith('--slate-workspace-id='))?.split('=')[1] || 'main',
  ready: () => ipcRenderer.invoke('document:ready'),
  open: () => ipcRenderer.invoke('document:open'),
  openLink: (href, id) => ipcRenderer.invoke('document:open-link', href, id),
  openDefault: (id) => ipcRenderer.invoke('document:open-default', id),
  revealDocument: (id) => ipcRenderer.invoke('document:reveal', id),
  newDocument: (draft) => ipcRenderer.invoke('document:new', draft),
  save: (content, saveAs, options) => ipcRenderer.invoke('document:save', content, saveAs, options),
  exportPdf: (content, id) => ipcRenderer.invoke('document:export-pdf', content, id),
  gitDocument: (id, revision = null) => ipcRenderer.invoke('document:git', id, revision),
  copyText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  copyImage: (png) => ipcRenderer.invoke('clipboard:write-image', png),
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
  gitChanges: (mode = 'local') => ipcRenderer.invoke('folder:git-changes', mode),
  gitChange: (mode, path, expected) => ipcRenderer.invoke('folder:git-change', mode, path, expected),
  openFolder: () => ipcRenderer.invoke('folder:open'),
  listFolder: (relativePath) => ipcRenderer.invoke('folder:list', relativePath),
  searchContents: (query, matchCase) => ipcRenderer.invoke('folder:search-contents', query, matchCase),
  cancelContentSearch: () => ipcRenderer.invoke('folder:cancel-search'),
  searchFolder: (query, refresh) => ipcRenderer.invoke('folder:search', query, refresh),
  openFile: (relativePath) => ipcRenderer.invoke('folder:open-file', relativePath),
  revealEntry: (relativePath) => ipcRenderer.invoke('folder:reveal', relativePath),
  createEntry: (parent, name, kind, content) => ipcRenderer.invoke('folder:create', parent, name, kind, content),
  renameEntry: (path, name) => ipcRenderer.invoke('folder:rename', path, name),
  moveEntry: (path, destination) => ipcRenderer.invoke('folder:move', path, destination),
  moveFiles: (paths, destination) => ipcRenderer.invoke('folder:move-files', paths, destination),
  importFiles: (files, destination) => ipcRenderer.invoke('folder:import', files.map(file => webUtils.getPathForFile(file)), destination),
  trashEntry: (path) => ipcRenderer.invoke('folder:trash', path),
  onFolder: (callback) => subscribe('folder:changed', callback),
});
