const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { isTextFile } = require('./file-types.cjs');
const { SessionStore } = require('./session-store.cjs');
const { createWorkspaceWindow } = require('./workspace-window.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'slate-app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName('Slate');
const launchedFromSource = Boolean(process.defaultApp);
if (process.platform === 'win32') app.setAppUserModelId('engineering.m45.slate');
const appIcon = path.join(app.getAppPath(), launchedFromSource ? 'public' : 'out', 'slate-icon.png');
const workspaces = new Map();
const channels = new Set();
let sessionStore;
let quitAllowed = false;
let quitting = false;

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
let pendingTarget = targetArgument(userArguments(process.argv));


function focusedWorkspace() {
  return workspaces.get(BrowserWindow.getFocusedWindow()?.webContents.id) ?? [...workspaces.values()].at(-1);
}

function persist(fallback) {
  const focused = focusedWorkspace();
  const ordered = [...workspaces.values()].sort((a, b) => Number(b === focused) - Number(a === focused));
  return sessionStore.saveWindows(ordered.length ? ordered.map(workspace => workspace.getSession()) : [fallback]);
}

function trustedWorkspace(event) {
  const workspace = workspaces.get(event.sender.id);
  if (!workspace || event.senderFrame !== workspace.window.webContents.mainFrame) throw new Error('Untrusted document request.');
  return workspace;
}

function newWorkspace(saved = { id: randomUUID(), folder: null, file: null, files: [] }, target) {
  if (quitting) return;
  let contentsId;
  const workspace = createWorkspaceWindow({
    id: saved.id, initialState: saved, target,
    persist: () => persist(),
    onClosed: fallback => {
      workspaces.delete(contentsId);
      if (!quitAllowed) void persist(fallback).catch(error => focusedWorkspace()?.showError(`Could not remember the workspace. ${error.message}`));
    },
    newWindow: () => newWorkspace(),
    isQuitting: () => quitAllowed,
  });
  contentsId = workspace.window.webContents.id;
  workspaces.set(contentsId, workspace);
  for (const channel of workspace.handlers.keys()) {
    if (channels.has(channel)) continue;
    channels.add(channel);
    ipcMain.handle(channel, (event, ...args) => trustedWorkspace(event).handlers.get(channel)(...args));
  }
  return workspace;
}

ipcMain.on('document:dirty', (event, id, value) => {
  const workspace = workspaces.get(event.sender.id);
  if (workspace && event.senderFrame === workspace.window.webContents.mainFrame) workspace.setDirty(id, value === true);
});

function receiveFile(file) {
  if (!file) return;
  const workspace = focusedWorkspace();
  if (workspace) workspace.receiveFile(file);
  else if (sessionStore) newWorkspace(undefined, file);
  else pendingTarget = file;
}

async function restoreWindows(target) {
  let saved;
  try { saved = await sessionStore.loadWindows(); }
  catch { saved = [{ id: 'main', folder: null, file: null, files: [] }]; }
  if (target) newWorkspace(saved[0], target);
  else for (const workspace of saved) newWorkspace(workspace);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('before-quit', event => {
    if (quitAllowed || !workspaces.size) return;
    event.preventDefault();
    if (quitting || [...workspaces.values()].some(workspace => workspace.isBusy())) return;
    quitting = true;
    void (async () => {
      try {
        // A user can keep typing in another window while a save prompt is open.
        // Check again after all prompts and pending workspace writes settle.
        do {
          for (const workspace of workspaces.values()) if (await workspace.confirmClose() !== true) return;
          await persist();
        } while ([...workspaces.values()].some(workspace => workspace.hasUnsaved()));
        quitAllowed = true;
        app.quit();
      } catch (error) {
        focusedWorkspace()?.showError(`Could not save the workspace before quitting. ${error.message}`);
      } finally { quitting = false; }
    })();
  });
  app.on('open-file', (event, file) => { event.preventDefault(); receiveFile(file); });
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const target = targetArgument(userArguments(argv));
    if (argv.includes('--new-window')) newWorkspace(undefined, target ? path.resolve(workingDirectory, target) : undefined);
    else {
      const workspace = focusedWorkspace() ?? newWorkspace();
      workspace.window.show(); workspace.window.focus();
      receiveFile(target ? path.resolve(workingDirectory, target) : undefined);
    }
  });
  app.whenReady().then(async () => {
    app.dock?.setIcon(appIcon);
    app.setAboutPanelOptions({ applicationName: 'Slate', applicationVersion: app.getVersion(), copyright: 'Copyright © 2026 M45 Engineering', iconPath: appIcon });
    sessionStore = new SessionStore(app.getPath('userData'));
    protocol.handle('slate-app', request => {
      const url = new URL(request.url);
      if (url.host !== 'app') return new Response('Not found', { status: 404 });
      const root = path.join(app.getAppPath(), 'out');
      const resource = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!resource.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(resource).toString());
    });
    if (!(launchedFromSource && process.env.SLATE_DEV_URL === 'http://127.0.0.1:3210')) {
      const csp = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'";
      const { session } = require('electron');
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
      });
    }
    await restoreWindows(pendingTarget);
    pendingTarget = null;
    app.on('activate', () => { if (!workspaces.size) void restoreWindows(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
