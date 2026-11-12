const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { readDocument, writeDocument, diskMatches, MAX_BYTES } = require('./file-store.cjs');
const { isTextFile, TEXT_EXTENSIONS } = require('./file-types.cjs');
const { FolderStore } = require('./folder-store.cjs');
const { SessionStore } = require('./session-store.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'slate-app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName('Slate');
const launchedFromSource = Boolean(process.defaultApp);
if (process.platform === 'win32') app.setAppUserModelId('engineering.m45.slate');
const appIcon = path.join(app.getAppPath(), launchedFromSource ? 'public' : 'out', 'slate-icon.png');

let window;
const documents = new Map();
let activeId = null;
let untitledNumber = 0;
let rendererReady = false;
let busy = false;
let confirmation = null;
let nextConfirmationId = 0;
let sessionStore;
let startupPromise;
let quitAllowed = false;
const folder = new FolderStore();
const development = launchedFromSource && process.env.SLATE_DEV_URL === 'http://127.0.0.1:3210';
function targetArgument(args) {
  return args.find(value => {
    if (value.startsWith('-')) return false;
    if (isTextFile(value)) return true;
    try { return fs.statSync(value).isDirectory(); } catch { return false; }
  });
}
function userArguments(argv) {
  if (!launchedFromSource) return argv.slice(1);
  // Debug flags can precede Electron's application entry point.
  const entry = argv.findIndex((value, index) => index > 0 && !value.startsWith('-'));
  return entry < 0 ? [] : argv.slice(entry + 1);
}
let queuedFile = targetArgument(userArguments(process.argv));

function current() { return documents.get(activeId); }
function payload(record = current()) {
  return { id: record.id, path: record.document?.path ?? null, name: record.name,
    content: record.document?.content ?? record.content, unsaved: record.dirty };
}
function snapshot(replaceId) {
  return { documents: [...documents.values()].map(payload), activeId, replaceId };
}
function send(channel, value) { if (window && !window.isDestroyed()) window.webContents.send(channel, value); }
function updateWindow() {
  const record = current();
  window?.setDocumentEdited([...documents.values()].some(item => item.dirty));
  window?.setRepresentedFilename(record?.document?.path ?? '');
  window?.setTitle(record ? `${record.name} — Slate` : 'Slate');
  const saveItem = Menu.getApplicationMenu()?.getMenuItemById('save-document');
  if (saveItem) saveItem.enabled = Boolean(record?.dirty);
}
function setDirty(id, value) {
  const record = documents.get(id);
  if (record) record.dirty = value;
  updateWindow();
}
function stopWatching(record) {
  record.watcher?.close();
  clearTimeout(record.watchTimer);
}
function watchDocument(record) {
  stopWatching(record);
  if (!record.document) return;
  record.watcher = fs.watch(path.dirname(record.document.path), (_event, filename) => {
    if (filename && filename.toString() !== path.basename(record.document.path)) return;
    clearTimeout(record.watchTimer);
    record.watchTimer = setTimeout(async () => {
      const opened = record.document;
      let changed = true;
      try { changed = !(await diskMatches(opened)); } catch { /* Report an unreadable file as changed. */ }
      if (documents.get(record.id) === record && record.document === opened) send('document:disk-change', { id: record.id, changed });
    }, 150);
  });
  record.watcher.on('error', () => send('document:disk-change', { id: record.id, changed: true }));
}
function addDocument(document = null, draft = null) {
  const number = document ? untitledNumber : ++untitledNumber;
  const record = { id: randomUUID(), document,
    name: document?.name ?? draft?.name ?? (number === 1 ? 'Untitled.md' : `Untitled ${number}.md`),
    content: draft?.content ?? '', dirty: Boolean(draft) };
  documents.set(record.id, record);
  watchDocument(record);
  return record;
}
async function rememberSession(reportError = true) {
  try {
    await sessionStore.save({ folder: folder.root, file: current()?.document?.path ?? null,
      files: [...documents.values()].flatMap(record => record.document ? [record.document.path] : []) });
  } catch {
    const message = 'Slate could not remember this workspace. Your documents are still available to edit and save.';
    if (reportError) send('document:error', message);
    return message;
  }
}
async function activate(record, announce = true, replace = false) {
  activeId = record.id;
  updateWindow();
  if (record.document) app.addRecentDocument(record.document.path);
  // A displayed tab must be ready for the next command, not still saving its session under the operation lock.
  const notice = await rememberSession(false);
  if (announce) send('document:loaded', snapshot(replace ? record.id : undefined));
  if (notice) send('document:error', notice);
}
async function mayCloseDocument(record) {
  if (!record.dirty) return true;
  if (!rendererReady) return false;
  if (activeId !== record.id) await activate(record);
  return new Promise(resolve => {
    const id = ++nextConfirmationId;
    confirmation = { id, documentId: record.id, resolve };
    send('document:confirm-changes', { id });
  });
}
async function mayCloseWorkspace() {
  for (const record of documents.values()) {
    if (!(await mayCloseDocument(record))) return false;
    if (record.dirty) {
      // An accepted prompt that did not save is an explicit discard.
      record.dirty = false;
      record.content = '';
      updateWindow();
      send('document:loaded', snapshot(record.id));
    }
  }
  return true;
}
function cancelConfirmation() {
  confirmation?.resolve(false);
  confirmation = null;
}

async function report(error) {
  send('document:error', error.message);
}

// Dialog and file operations are serialized so overlapping open/save requests cannot switch the active file mid-save.
async function exclusive(action, quiet = false) {
  if (busy) return { canceled: true };
  busy = true;
  try { return await action(); }
  catch (error) { if (!quiet) await report(error); return { error: error.message }; }
  finally { busy = false; }
}

async function openFile(filePath) {
  const canonical = await fs.promises.realpath(path.resolve(filePath));
  const existing = [...documents.values()].find(record => record.document?.path === canonical);
  if (existing) { await activate(existing); return { document: payload(existing) }; }
  const doc = await readDocument(canonical);
  if (!folder.root) {
    await folder.open(path.dirname(doc.path));
    send('folder:changed', folder.snapshot());
  }
  const record = addDocument(doc);
  await activate(record);
  window.show();
  window.focus();
  return { document: payload(record) };
}

async function openDialog() {
  const result = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'Text and code files', extensions: TEXT_EXTENSIONS }, { name: 'All files', extensions: ['*'] }] });
  if (result.canceled) return { canceled: true };
  return openFile(result.filePaths[0]);
}

async function openTarget(target) {
  if ((await fs.promises.stat(target)).isDirectory()) {
    const snapshot = await folder.open(target);
    send('folder:changed', snapshot);
    await rememberSession();
    return { folder: snapshot };
  }
  return openFile(target);
}

function trusted(event) {
  return event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame;
}

function handle(channel, callback) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trusted(event)) throw new Error('Untrusted document request.');
    return callback(...args);
  });
}

async function restoreStartup() {
  let saved = { folder: null, file: null, files: [] };
  try { saved = await sessionStore.load(); }
  catch { send('document:error', 'Slate could not read the previous workspace.'); }
  const requested = queuedFile;
  queuedFile = null;
  let notice = '';
  const inside = (root, file) => {
    const relative = path.relative(root, file);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  const restoreFolder = async folderPath => {
    if (!folderPath) return;
    try { await folder.open(folderPath); }
    catch { notice = 'The last folder is no longer available. You can open another folder.'; }
  };
  const restoreFile = async (filePath, explicit = false) => {
    try {
      const doc = await readDocument(await fs.promises.realpath(filePath));
      if (!folder.root) await folder.open(path.dirname(doc.path));
      return addDocument(doc);
    } catch (error) {
      notice = explicit ? `Could not open the requested file: ${error.message}` : folder.root ? 'The last file is no longer available. Your folder is still open.' : 'The last workspace is no longer available. Open a folder or file to continue.';
    }
  };
  if (requested) {
    try {
      const target = await fs.promises.realpath(requested);
      if ((await fs.promises.stat(target)).isDirectory()) {
        await folder.open(target);
        for (const file of saved.files.filter(file => inside(target, file))) await restoreFile(file);
      } else {
        if (saved.folder && inside(saved.folder, target)) await restoreFolder(saved.folder);
        await restoreFile(target, true);
      }
    } catch (error) { notice = `Could not open the requested path: ${error.message}`; }
  } else {
    await restoreFolder(saved.folder);
    for (const file of saved.files) await restoreFile(file);
  }
  const restored = [...documents.values()].find(record => record.document?.path === saved.file)
    ?? [...documents.values()][0] ?? addDocument();
  send('folder:changed', folder.snapshot());
  await activate(restored, false);
  if (notice) send('document:error', notice);
}

handle('document:ready', async () => {
  rendererReady = true;
  startupPromise ??= exclusive(restoreStartup);
  await startupPromise;
  return snapshot();
});
handle('document:open', () => exclusive(openDialog));
handle('document:confirm-result', (id, accepted) => {
  if (!confirmation || confirmation.id !== id || confirmation.saving) return;
  confirmation.resolve(accepted === true);
  confirmation = null;
});
handle('folder:ready', () => folder.snapshot());
handle('folder:open', () => exclusive(async () => {
  const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'], title: 'Open folder in Slate' });
  if (result.canceled) return { canceled: true };
  const snapshot = await folder.open(result.filePaths[0]);
  send('folder:changed', snapshot);
  await rememberSession();
  return { folder: snapshot };
}));
handle('folder:list', async relativePath => {
  try { return await folder.list(relativePath); }
  catch (error) { return { error: error.message }; }
});
handle('folder:search', async (query, refresh) => {
  try { return await folder.search(query, refresh === true); }
  catch (error) { return { error: error.message }; }
});
handle('folder:open-file', relativePath => exclusive(async () => openFile(await folder.resolve(relativePath))));
handle('folder:create', (parent, name, kind) => exclusive(async () => {
  const created = await folder.create(parent, name, kind);
  if (kind === 'file') await openFile(created.absolute);
  return { changed: true, path: created.path };
}));
async function changeEntry(relativePath, operation, deleting = false) {
  const from = await folder.resolveEntry(relativePath);
  const isAffected = record => record.document && (record.document.path === from || record.document.path.startsWith(from + path.sep));
  let affected = [...documents.values()].filter(isAffected);
  if (deleting) {
    for (const record of affected) {
      if (!(await mayCloseDocument(record))) {
        send('document:loaded', snapshot());
        return { canceled: true };
      }
    }
  }
  // A Save As during confirmation may move a tab's file outside the deleted item.
  affected = affected.filter(isAffected);
  for (const record of affected) stopWatching(record);
  let notice;
  try {
    const result = await operation();
    for (const record of affected) {
      if (result.to) {
        const nextPath = path.join(result.to, path.relative(result.from, record.document.path));
        record.document = { ...record.document, path: nextPath, name: path.basename(nextPath) };
        record.name = record.document.name;
      } else documents.delete(record.id);
    }
    if (!documents.has(activeId)) activeId = ([...documents.values()][0] ?? addDocument()).id;
    updateWindow();
    notice = await rememberSession(false);
  } finally {
    for (const record of affected) if (documents.has(record.id)) watchDocument(record);
  }
  // A displayed new path must be ready for Save, with persistence and watchers settled.
  send('document:loaded', snapshot());
  if (notice) send('document:error', notice);
  return { changed: true };
}
handle('folder:rename', (relativePath, name) => exclusive(async () => {
  const from = await folder.resolveEntry(relativePath);
  if ([...documents.values()].some(record => record.document?.path === from) && !isTextFile(name)) throw new Error('An open file needs a supported text or code extension.');
  return changeEntry(relativePath, () => folder.rename(relativePath, name));
}));
handle('folder:move', (relativePath, destinationPath) => exclusive(async () => {
  if (destinationPath !== undefined) {
    if (typeof destinationPath !== 'string') throw new Error('Choose a destination folder.');
    return changeEntry(relativePath, () => folder.move(relativePath, destinationPath));
  }
  const from = await folder.resolveEntry(relativePath);
  const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'], defaultPath: folder.root, title: `Move ${path.basename(from)} to folder` });
  if (result.canceled) return { canceled: true };
  const destination = path.relative(folder.root, await fs.promises.realpath(result.filePaths[0]));
  return changeEntry(relativePath, () => folder.move(relativePath, destination));
}));
handle('folder:trash', relativePath => exclusive(() => changeEntry(relativePath, () => folder.trash(relativePath, absolute => shell.trashItem(absolute)), true)));

async function newDocument(draft) {
  if (draft && (typeof draft.name !== 'string' || typeof draft.content !== 'string' || Buffer.byteLength(draft.content, 'utf8') > MAX_BYTES)) throw new Error('Invalid recovery draft.');
  const record = addDocument(null, draft ? { name: path.basename(draft.name), content: draft.content } : null);
  await activate(record);
  return { document: payload(record) };
}
handle('document:new', draft => exclusive(() => newDocument(draft)));
handle('document:activate', id => exclusive(async () => {
  const record = documents.get(id);
  if (record) await activate(record);
}));
async function closeDocument(id) {
  const record = documents.get(id);
  if (!record) return true;
  if (!(await mayCloseDocument(record))) return false;
  const index = [...documents.keys()].indexOf(id);
  stopWatching(record);
  documents.delete(id);
  const next = activeId === id ? [...documents.values()][Math.max(0, index - 1)] ?? addDocument() : current();
  await activate(next);
  return true;
}
handle('document:close', id => exclusive(async () => ({ canceled: !(await closeDocument(id)) })));
handle('document:close-many', (ids, keepId) => exclusive(async () => {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('Invalid tab selection.');
  for (const id of new Set(ids)) if (!(await closeDocument(id))) return { canceled: true };
  if (documents.has(keepId)) await activate(documents.get(keepId));
}));
handle('document:reorder', ids => exclusive(async () => {
  if (!Array.isArray(ids) || ids.length !== documents.size || new Set(ids).size !== documents.size || ids.some(id => !documents.has(id))) throw new Error('Invalid tab order.');
  const ordered = ids.map(id => documents.get(id));
  documents.clear();
  for (const record of ordered) documents.set(record.id, record);
  await rememberSession();
  send('document:loaded', snapshot());
}));
handle('document:reload', () => exclusive(async () => {
  const record = current();
  if (!record?.document || !(await mayCloseDocument(record))) return { canceled: true };
  record.document = await readDocument(record.document.path);
  record.dirty = false;
  watchDocument(record);
  await activate(record, true, true);
  return { document: payload(record) };
}));
async function saveDocument(content, saveAs, options) {
  if (typeof content !== 'string') throw new Error('Invalid document content.');
  const record = documents.get(options?.id ?? activeId);
  if (!record || (options && options.path !== (record.document?.path ?? null))) return { canceled: true };
  let filePath = record.document?.path;
  if (!filePath || saveAs) {
    const result = await dialog.showSaveDialog(window, {
      defaultPath: filePath || (folder.root ? path.join(folder.root, record.name) : record.name), filters: [{ name: 'Text and code files', extensions: TEXT_EXTENSIONS }, { name: 'All files', extensions: ['*'] }],
    });
    if (result.canceled) return { canceled: true };
    filePath = result.filePath;
  }
  // Match the canonical root used by the folder navigator (macOS aliases /var to /private/var).
  filePath = path.join(await fs.promises.realpath(path.dirname(filePath)), path.basename(filePath));
  try { filePath = await fs.promises.realpath(filePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if ([...documents.values()].some(other => other !== record && other.document?.path === filePath)) throw new Error('This file is already open in another tab. Switch to that tab to save it.');
  const result = await writeDocument(filePath, content, record.document);
  if (result.conflict) { send('document:disk-change', { id: record.id, changed: true }); return { conflict: true }; }
  // The renderer retains this tab's cursor and undo history after saving.
  record.document = result.document;
  record.name = result.document.name;
  record.dirty = false;
  updateWindow();
  app.addRecentDocument(record.document.path);
  watchDocument(record);
  await rememberSession();
  return { document: payload(record) };
}
handle('document:save', async (content, saveAs, options) => {
  if (options?.confirmationId !== undefined) {
    const pending = confirmation;
    if (!pending || pending.id !== options.confirmationId || pending.documentId !== options.id || pending.saving) return { canceled: true };
    // The outer open/close operation owns the lock while it awaits the user's choice.
    // Only its associated Save may run inside that operation.
    pending.saving = true;
    try { return await saveDocument(content, saveAs, options); }
    catch (error) { return { error: error.message }; }
    finally { pending.saving = false; }
  }
  return exclusive(() => saveDocument(content, saveAs, options));
});
ipcMain.on('document:dirty', (event, id, value) => { if (trusted(event)) setDirty(id, value === true); });

function command(value) { send('document:command', value); }
function createMenu() {
  const fileMenu = [
    { label: 'New', accelerator: 'CmdOrCtrl+N', click: () => void exclusive(() => newDocument()) },
    { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => void exclusive(openDialog) },
    { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => command('open-folder') },
    { type: 'separator' },
    { id: 'save-document', label: 'Save', enabled: Boolean(current()?.dirty), accelerator: 'CmdOrCtrl+S', click: () => command('save') },
    { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => command('save-as') },
    { type: 'separator' }, { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => command('close-tab') },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'Slate', submenu: [
      { label: 'About Slate', role: 'about' }, { type: 'separator' },
      { role: 'services' }, { type: 'separator' },
      { label: 'Hide Slate', role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { label: 'Quit Slate', role: 'quit' },
    ] }] : []),
    { label: 'File', submenu: fileMenu }, { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Toggle Markdown', accelerator: 'CmdOrCtrl+Shift+M', click: () => command('toggle-mode') },
      { type: 'separator' },
      { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => command('zoom-reset') },
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => command('zoom-in') },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => command('zoom-out') },
      { type: 'separator' }, { role: 'togglefullscreen' },
      ...(launchedFromSource ? [{ role: 'toggleDevTools' }] : []),
    ] },
    { role: 'windowMenu' },
  ]));
}

function createWindow() {
  window = new BrowserWindow({
    width: 1120, height: 820, minWidth: 700, minHeight: 500,
    title: 'Slate', icon: appIcon, backgroundColor: '#ffffff', show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 20, y: 23 },
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  const createdWindow = window;
  createdWindow.once('ready-to-show', () => { if (!createdWindow.isDestroyed()) createdWindow.show(); });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('did-start-loading', cancelConfirmation);
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  let closing = false;
  window.on('close', (event) => {
    if (closing || quitAllowed) return;
    if (busy) { event.preventDefault(); return; }
    if (![...documents.values()].some(record => record.dirty)) return;
    event.preventDefault();
    void exclusive(async () => { if (await mayCloseWorkspace()) { closing = true; window.close(); } });
  });
  window.on('closed', () => { cancelConfirmation(); for (const record of documents.values()) stopWatching(record); window = null; rendererReady = false; });
  for (const record of documents.values()) watchDocument(record);
  createMenu();
  void window.loadURL(development ? process.env.SLATE_DEV_URL : 'slate-app://app/');
}

function receiveFile(file) {
  if (!file) return;
  if (rendererReady) void exclusive(() => openTarget(file));
  else queuedFile = file;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('before-quit', event => {
    if (quitAllowed || !window) return;
    event.preventDefault();
    if (busy) return;
    void exclusive(async () => {
      if (await mayCloseWorkspace()) { quitAllowed = true; app.quit(); }
    });
  });
  app.on('open-file', (event, file) => { event.preventDefault(); receiveFile(file); });
  app.on('second-instance', (_event, argv, workingDirectory) => {
    if (!window) createWindow();
    window.show(); window.focus();
    const target = targetArgument(userArguments(argv));
    receiveFile(target ? path.resolve(workingDirectory, target) : undefined);
  });
  app.whenReady().then(() => {
    app.dock?.setIcon(appIcon);
    app.setAboutPanelOptions({ applicationName: 'Slate', applicationVersion: app.getVersion(), copyright: 'Copyright © 2026 M45 Engineering', iconPath: appIcon });
    sessionStore = new SessionStore(app.getPath('userData'));
    protocol.handle('slate-app', (request) => {
      const url = new URL(request.url);
      if (url.host !== 'app') return new Response('Not found', { status: 404 });
      const root = path.join(app.getAppPath(), 'out');
      const resource = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!resource.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(resource).toString());
    });
    if (!development) {
      const csp = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'";
      const { session } = require('electron');
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
      });
    }
    createWindow();
    app.on('activate', () => { if (!window) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
