const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { SessionStore } = require('../electron/session-store.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-session-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: new SessionStore(path.join(root, 'preferences')) };
}

test('remembers folder and file across fresh store instances', async t => {
  const { root, store } = await fixture(t);
  const session = { folder: root, file: path.join(root, 'notes.md') };
  await store.save(session);
  assert.deepEqual(await new SessionStore(path.dirname(store.filename)).load(), { ...session, files: [session.file] });
  assert.equal((await fs.readFile(store.filename, 'utf8')).includes('content'), false);
});

test('missing and malformed preferences start with an empty session', async t => {
  const { store } = await fixture(t);
  assert.deepEqual(await store.load(), { folder: null, file: null, files: [] });
  await fs.mkdir(path.dirname(store.filename), { recursive: true });
  await fs.writeFile(store.filename, '{broken');
  assert.deepEqual(await store.load(), { folder: null, file: null, files: [] });
});

test('ignores unknown formats and relative paths', async t => {
  const { root, store } = await fixture(t);
  await fs.mkdir(path.dirname(store.filename), { recursive: true });
  await fs.writeFile(store.filename, JSON.stringify({ version: 9, folder: root }));
  assert.deepEqual(await store.load(), { folder: null, file: null, files: [] });
  await fs.writeFile(store.filename, JSON.stringify({ version: 1, folder: root, file: '../notes.md' }));
  assert.deepEqual(await store.load(), { folder: root, file: null, files: [] });
});

test('the latest completed workspace wins and opening a blank document clears the file', async t => {
  const { root, store } = await fixture(t);
  await Promise.all([
    store.save({ folder: root, file: path.join(root, 'first.md') }),
    store.save({ folder: root, file: path.join(root, 'second.md') }),
    store.save({ folder: root, file: null, files: [] }),
  ]);
  assert.deepEqual(await store.load(), { folder: root, file: null, files: [] });
  assert.deepEqual(await fs.readdir(path.dirname(store.filename)), ['workspace.json']);
});


test('restores multiple saved tabs in order and reads legacy single-file sessions', async t => {
  const { root, store } = await fixture(t);
  const files = [path.join(root, 'one.md'), path.join(root, 'two.ts')];
  await store.save({ folder: root, file: files[1], files: [...files, files[0], '../ignored'] });
  assert.deepEqual(await store.load(), { folder: root, file: files[1], files });
  await fs.writeFile(store.filename, JSON.stringify({ version: 1, folder: root, file: files[0] }));
  assert.deepEqual(await store.load(), { folder: root, file: files[0], files: [files[0]] });
});
