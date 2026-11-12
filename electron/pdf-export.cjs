const { BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function exportPdf({ parent, name, content, documentPath, url }) {
  const suggested = name.replace(/\.(md|markdown)$/i, '') + '.pdf';
  const choice = await dialog.showSaveDialog(parent, {
    title: 'Export PDF', buttonLabel: 'Export',
    defaultPath: documentPath ? path.join(path.dirname(documentPath), suggested) : suggested,
    filters: [{ name: 'PDF document', extensions: ['pdf'] }],
  });
  if (choice.canceled || !choice.filePath) return { canceled: true };
  const destination = /\.pdf$/i.test(choice.filePath) ? choice.filePath : choice.filePath + '.pdf';
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  const preview = new BrowserWindow({
    show: false, width: 900, height: 1100,
    webPreferences: { preload: path.join(__dirname, 'pdf-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  preview.webContents.on('will-navigate', event => event.preventDefault());
  const trusted = event => event.sender === preview.webContents && event.senderFrame === preview.webContents.mainFrame;
  let timer;
  let onReady;
  try {
    ipcMain.handle('pdf:document', event => {
      if (!trusted(event)) throw new Error('Untrusted PDF request.');
      return { name, content };
    });
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('The document took too long to render.')), 60_000);
      onReady = (event, error) => {
        if (!trusted(event)) return;
        if (typeof error === 'string' && error) reject(new Error(error));
        else resolve();
      };
      ipcMain.on('pdf:ready', onReady);
      preview.webContents.once('render-process-gone', () => reject(new Error('The PDF renderer closed unexpectedly.')));
      preview.once('closed', () => reject(new Error('The PDF renderer was closed.')));
      void preview.loadURL(url).catch(reject);
    });
    clearTimeout(timer);
    const bytes = await preview.webContents.printToPDF({
      pageSize: 'A4', printBackground: true, preferCSSPageSize: true,
      margins: { top: 20 / 25.4, bottom: 20 / 25.4, left: 18 / 25.4, right: 18 / 25.4 },
      displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: '<div style="width:100%;text-align:center;font-family:sans-serif;font-size:9px;color:#666"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      generateTaggedPDF: true, generateDocumentOutline: true,
    });
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, destination);
    return { path: destination };
  } finally {
    clearTimeout(timer);
    ipcMain.removeHandler('pdf:document');
    if (onReady) ipcMain.removeListener('pdf:ready', onReady);
    if (!preview.isDestroyed()) preview.destroy();
    await fs.rm(temporary, { force: true });
  }
}

module.exports = { exportPdf };
