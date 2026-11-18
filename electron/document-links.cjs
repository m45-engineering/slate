const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');

function resolveDocumentLink(href, documentPath, folderPath) {
  if (typeof href !== 'string' || !href.trim() || /[\x00-\x1f\x7f]/.test(href)) throw new Error('Invalid link.');
  const value = href.trim();
  const base = pathToFileURL(documentPath || path.join(folderPath || path.sep, 'Untitled.md'));
  const url = new URL(value.startsWith('//') ? `https:${value}` : value, base);
  if (url.protocol === 'https:' || url.protocol === 'http:') return { kind: 'web', url: url.href };
  if (url.protocol !== 'file:') throw new Error('Slate opens web links and documents in the open folder.');
  if (!folderPath) throw new Error('Open a folder before following a document link.');
  return { kind: 'file', path: path.relative(folderPath, fileURLToPath(url)), fragment: url.hash };
}

module.exports = { resolveDocumentLink };
