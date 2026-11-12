const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isTextFile } = require('./file-types.cjs');

const MAX_BYTES = 10 * 1024 * 1024;
async function readDocument(filePath) {
  if (!isTextFile(filePath)) throw new Error('Choose a supported text or source-code file extension.');
  const handle = await fs.open(filePath, 'r');
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Choose a text file.');
    if (stat.size > MAX_BYTES) throw new Error('Slate supports documents up to 10 MB.');
    bytes = await handle.readFile();
    if (bytes.length > MAX_BYTES) throw new Error('Slate supports documents up to 10 MB.');
  } finally {
    await handle.close();
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('This file is not valid UTF-8 text. Binary files cannot be edited in Slate.'); }
  if (text.includes('\0')) throw new Error('This file contains binary data and cannot be edited as text.');
  return {
    path: filePath,
    name: path.basename(filePath),
    content: text.replace(/\r\n/g, '\n'),
    bytes,
    bom: bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
    crlf: text.includes('\r\n'),
  };
}

async function diskMatches(document) {
  try {
    const bytes = await fs.readFile(document.path);
    return bytes.equals(document.bytes);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeDocument(filePath, content, previous = null) {
  if (!isTextFile(filePath)) throw new Error('Save with a supported text or source-code file extension.');
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
    throw new Error('Slate supports documents up to 10 MB.');
  }
  if (content.includes('\0')) throw new Error('Binary data cannot be saved as a text document.');
  if (previous && previous.path === filePath && !(await diskMatches(previous))) {
    return { conflict: true };
  }
  // A save without an edit must not reformat a file or change its modification time.
  if (previous?.path === filePath && content === previous.content) return { document: previous };
  let text = content;
  if (previous?.crlf) text = text.replace(/\r?\n/g, '\r\n');
  if (previous?.bom) text = '\ufeff' + text;
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let mode = 0o600;
  try { mode = (await fs.stat(filePath)).mode; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    const handle = await fs.open(temp, 'wx', mode);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (let attempt = 0; ; attempt++) {
      // Recheck on every attempt so an external edit during a Windows file lock is preserved.
      if (previous?.path === filePath && !(await diskMatches(previous))) return { conflict: true };
      try { await fs.rename(temp, filePath); break; }
      catch (error) {
        // Windows indexers and virus scanners can briefly hold the destination open.
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
      }
    }
  } finally {
    await fs.rm(temp, { force: true });
  }
  return { document: await readDocument(filePath) };
}

module.exports = { readDocument, writeDocument, diskMatches, MAX_BYTES };
