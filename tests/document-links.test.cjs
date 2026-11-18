const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveDocumentLink } = require('../electron/document-links.cjs');
const { FolderStore } = require('../electron/folder-store.cjs');

test('resolves encoded document paths relative to the current document or unsaved document folder', () => {
  const root = path.resolve('/workspace');
  const doc = path.join(root, 'docs', 'guide.md');
  for (const href of ['../other%20note.md', pathToFileURL(path.join(root, 'other note.md')).href]) {
    assert.deepEqual(resolveDocumentLink(href, doc, root), { kind: 'file', path: 'other note.md', fragment: '' });
  }
  assert.deepEqual(resolveDocumentLink('docs/guide.md', null, root), { kind: 'file', path: path.join('docs', 'guide.md'), fragment: '' });
  assert.deepEqual(resolveDocumentLink('../other%20note.md#caf%C3%A9', doc, root), { kind: 'file', path: 'other note.md', fragment: '#caf%C3%A9' });
  assert.throws(() => resolveDocumentLink('guide.md', null, null), /Open a folder/);
});

test('classifies only HTTP and HTTPS as browser links, with a full normalized URL', () => {
  for (const url of ['https://example.com/a?b=c#d', 'http://example.com/help']) {
    assert.deepEqual(resolveDocumentLink(url), { kind: 'web', url });
  }
  assert.deepEqual(resolveDocumentLink('//example.com/docs'), { kind: 'web', url: 'https://example.com/docs' });
  for (const href of ['javascript:alert(1)', 'data:text/html,test', 'mailto:user@example.com', 'slate-app://app/', '', 'https://example.com/\nspoof']) {
    assert.throws(() => resolveDocumentLink(href));
  }
});

test('document links cannot escape the open folder, including through symbolic links', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-links-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'workspace');
  await fs.mkdir(root);
  await fs.writeFile(path.join(temp, 'outside.md'), '# Outside');
  const links = ['../outside.md', '%2e%2e/outside.md', pathToFileURL(path.join(temp, 'outside.md')).href];
  // Windows requires an additional privilege to create symbolic links.
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(temp, 'outside.md'), path.join(root, 'shortcut.md'));
    links.push('shortcut.md');
  }
  const folder = new FolderStore();
  await folder.open(root);
  for (const href of links) {
    const link = resolveDocumentLink(href, path.join(root, 'index.md'), root);
    await assert.rejects(folder.resolve(link.path), /outside the open folder/);
  }
});
