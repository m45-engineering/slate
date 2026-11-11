const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FolderStore } = require('../electron/folder-store.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-folder-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'docs'));
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.mkdir(path.join(root, '.github'));
  await fs.writeFile(path.join(root, 'README.md'), '# Read me');
  await fs.writeFile(path.join(root, 'package.json'), '{}');
  await fs.writeFile(path.join(root, 'docs', 'design.markdown'), '# Design');
  const store = new FolderStore();
  await store.open(root);
  return { root, store };
}

test('lists one directory at a time, folders first, with editable text and code files', async t => {
  const { store } = await fixture(t);
  const listing = await store.list();
  assert.deepEqual(listing.entries.map(entry => entry.name), ['.github', 'docs', 'package.json', 'README.md']);
  assert.equal(listing.entries.find(entry => entry.name === 'README.md').editable, true);
  assert.equal(listing.entries.find(entry => entry.name === 'package.json').editable, true);
  assert.deepEqual((await store.list('docs')).entries.map(entry => entry.path), ['docs/design.markdown']);
});

test('refresh picks up files created by another tool', async t => {
  const { root, store } = await fixture(t);
  await fs.writeFile(path.join(root, 'added.md'), 'New document');
  assert.ok((await store.list()).entries.find(entry => entry.name === 'added.md'));
});

test('folder access rejects traversal and symlinks leaving the selected folder', async t => {
  const { root, store } = await fixture(t);
  await assert.rejects(store.resolve('..'), /outside/);
  await assert.rejects(store.resolve(path.dirname(root)), /relative/);
  if (process.platform !== 'win32') {
    await fs.symlink(path.dirname(root), path.join(root, 'outside'));
    await assert.rejects(store.list('outside'), /outside/);
    assert.equal((await store.list()).entries.find(entry => entry.name === 'outside').kind, 'link');
  }
});

test('filename search includes text and source without expanding folders and refreshes its index', async t => {
  const { root, store } = await fixture(t);
  assert.deepEqual((await store.search('DESIGN')).entries.map(entry => entry.path), ['docs/design.markdown']);
  assert.equal((await store.search('package')).total, 1);
  await fs.writeFile(path.join(root, 'docs', 'helpers.ts'), 'export const value = 42;');
  await fs.writeFile(path.join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.deepEqual((await store.search('helpers', true)).entries.map(entry => entry.path), ['docs/helpers.ts']);
  assert.equal((await store.search('image')).total, 0);
  await fs.writeFile(path.join(root, 'docs', 'design-review.md'), '# Review');
  assert.equal((await store.search('design', true)).total, 2);
  assert.equal((await store.search('no-such-file')).total, 0);
});

test('renames and moves files and folders, preserving contents and refreshing search', async t => {
  const { root, store } = await fixture(t);
  await store.search('design');
  const renamed = await store.rename('docs/design.markdown', 'plan.md');
  assert.equal(renamed.to, path.join(store.root, 'docs', 'plan.md'));
  assert.equal(await fs.readFile(renamed.to, 'utf8'), '# Design');
  assert.equal((await store.search('design')).total, 0);
  await store.move('docs/plan.md', '');
  assert.equal(await fs.readFile(path.join(root, 'plan.md'), 'utf8'), '# Design');
  await store.rename('docs', 'notes');
  await fs.writeFile(path.join(root, 'notes', 'nested.txt'), 'Keep me');
  await fs.mkdir(path.join(root, 'archive'));
  await store.move('notes', 'archive');
  assert.equal(await fs.readFile(path.join(root, 'archive', 'notes', 'nested.txt'), 'utf8'), 'Keep me');
});

test('file actions reject overwrites, invalid names, root edits, and moving a folder inside itself', async t => {
  const { root, store } = await fixture(t);
  await assert.rejects(store.rename('README.md', 'package.json'), /already exists/);
  await assert.rejects(store.rename('README.md', '../outside.md'), /valid.*name/);
  await assert.rejects(store.rename('README.md', 'CON.txt'), /valid.*name/);
  await assert.rejects(store.rename('', 'renamed'), /workspace folder/);
  await fs.mkdir(path.join(root, 'docs', 'child'));
  await assert.rejects(store.move('docs', 'docs/child'), /inside itself/);
  await assert.rejects(store.move('README.md', '..'), /outside/);
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), '# Read me');
  assert.equal(await fs.readFile(path.join(root, 'package.json'), 'utf8'), '{}');
});

test('trash delegates to the OS operation and a failed trash leaves the source available', async t => {
  const { root, store } = await fixture(t);
  await assert.rejects(store.trash('README.md', async () => { throw new Error('Trash unavailable'); }), /Trash unavailable/);
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), '# Read me');
  await fs.mkdir(path.join(root, '.trash'));
  await store.trash('README.md', source => fs.rename(source, path.join(root, '.trash', path.basename(source))));
  await assert.rejects(fs.access(path.join(root, 'README.md')));
  assert.equal(await fs.readFile(path.join(root, '.trash', 'README.md'), 'utf8'), '# Read me');
});

test('symbolic links cannot be renamed or trashed through the workspace', async t => {
  if (process.platform === 'win32') return t.skip('Creating symlinks requires a Windows privilege.');
  const { root, store } = await fixture(t);
  await fs.symlink(path.join(root, 'README.md'), path.join(root, 'linked.md'));
  await assert.rejects(store.rename('linked.md', 'new.md'), /Symbolic links/);
  await assert.rejects(store.trash('linked.md', async () => assert.fail('must not trash a symlink')), /Symbolic links/);
});

test('creates files and folders at the root and in a selected folder and refreshes search', async t => {
  const { root, store } = await fixture(t);
  assert.equal((await store.search('created')).total, 0);
  assert.equal((await store.create('', 'created.md', 'file')).path, 'created.md');
  assert.equal(await fs.readFile(path.join(root, 'created.md'), 'utf8'), '');
  assert.equal((await store.search('created')).total, 1);
  const folder = await store.create('docs', 'drafts', 'directory');
  assert.equal(folder.path, 'docs/drafts');
  assert.equal((await fs.stat(path.join(root, folder.path))).isDirectory(), true);
  assert.equal((await store.create(folder.path, 'script.ts', 'file')).path, 'docs/drafts/script.ts');
  assert.equal(await fs.readFile(path.join(root, 'docs/drafts/script.ts'), 'utf8'), '');
});

test('creation never replaces an existing file or folder', async t => {
  const { root, store } = await fixture(t);
  await assert.rejects(store.create('', 'README.md', 'file'), /already exists/);
  await assert.rejects(store.create('', 'README.md', 'directory'), /already exists/);
  await assert.rejects(store.create('', 'docs', 'directory'), /already exists/);
  await assert.rejects(store.create('', 'docs', 'file'), /already exists/);
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), '# Read me');
  assert.equal((await fs.stat(path.join(root, 'docs'))).isDirectory(), true);
});

test('creation rejects traversal, invalid names, unsupported files, and non-folder parents', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.create('', '../escaped.md', 'file'), /valid.*name/);
  await assert.rejects(store.create('', 'CON', 'directory'), /valid.*name/);
  await assert.rejects(store.create('..', 'escaped.md', 'file'), /outside/);
  await assert.rejects(store.create('README.md', 'child.md', 'file'), /parent folder/);
  await assert.rejects(store.create('', 'image.png', 'file'), /supported.*extension/);
  await assert.rejects(store.create('', 'name', 'link'), /file or folder/);
});
