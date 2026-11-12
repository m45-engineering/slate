const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readDocument, writeDocument, diskMatches } = require('../electron/file-store.cjs');

async function fixture(t, content = '# Original\n') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-files-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'document.md');
  await fs.writeFile(file, content);
  return { file, directory, document: await readDocument(file) };
}

test('opening and saving without editing preserves every byte and mtime', async t => {
  const bytes = Buffer.from('\ufeff#  Title\r\n\r\n* text  \r\n', 'utf8');
  const { file, document } = await fixture(t, bytes);
  const before = await fs.stat(file);
  const result = await writeDocument(file, document.content, document);
  assert.ok(result.document);
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
});

test('edited files retain BOM and CRLF', async t => {
  const { file, document } = await fixture(t, '\ufeff# Original\r\n');
  await writeDocument(file, '# Updated\n\nText\n', document);
  assert.equal(await fs.readFile(file, 'utf8'), '\ufeff# Updated\r\n\r\nText\r\n');
});

test('external modifications are never overwritten by Save', async t => {
  const { file, document } = await fixture(t);
  await fs.writeFile(file, '# Changed by an agent\n');
  assert.equal(await diskMatches(document), false);
  assert.deepEqual(await writeDocument(file, '# My edits\n', document), { conflict: true });
  assert.equal(await fs.readFile(file, 'utf8'), '# Changed by an agent\n');
});

test('externally deleted files are treated as conflicts', async t => {
  const { file, document } = await fixture(t);
  await fs.unlink(file);
  assert.deepEqual(await writeDocument(file, '# My edits\n', document), { conflict: true });
  await assert.rejects(fs.access(file));
});

test('Save retries temporary Windows file locks without losing edits', async t => {
  const { file, document } = await fixture(t);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const rename = fs.rename;
  let attempts = 0;
  t.mock.method(fs, 'rename', async (...args) => {
    if (++attempts <= 2) throw Object.assign(new Error('File is locked'), { code: 'EPERM' });
    return rename(...args);
  });
  assert.ok((await writeDocument(file, '# Saved after lock\n', document)).document);
  assert.equal(attempts, 3);
  assert.equal(await fs.readFile(file, 'utf8'), '# Saved after lock\n');
});

test('a Windows save retry preserves an external edit made while the file was locked', async t => {
  const { file, directory, document } = await fixture(t);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  let attempts = 0;
  t.mock.method(fs, 'rename', async () => {
    attempts++;
    await fs.writeFile(file, '# External edit\n');
    throw Object.assign(new Error('File is locked'), { code: 'EPERM' });
  });
  assert.deepEqual(await writeDocument(file, '# My unsaved edit\n', document), { conflict: true });
  assert.equal(attempts, 1);
  assert.equal(await fs.readFile(file, 'utf8'), '# External edit\n');
  assert.deepEqual(await fs.readdir(directory), ['document.md']);
});

test('permanent Windows file locks fail safely after bounded retries', async t => {
  const { file, directory, document } = await fixture(t);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  let attempts = 0;
  t.mock.method(fs, 'rename', async () => {
    attempts++;
    throw Object.assign(new Error('File is locked'), { code: 'EPERM' });
  });
  await assert.rejects(writeDocument(file, '# My unsaved edit\n', document), { code: 'EPERM' });
  assert.equal(attempts, 6);
  assert.equal(await fs.readFile(file, 'utf8'), '# Original\n');
  assert.deepEqual(await fs.readdir(directory), ['document.md']);
});

test('saving a copy leaves the externally edited original intact', async t => {
  const { file, directory, document } = await fixture(t);
  const copy = path.join(directory, 'copy.md');
  await fs.writeFile(file, 'External edit');
  assert.ok((await writeDocument(copy, 'My edit', document)).document);
  assert.equal(await fs.readFile(file, 'utf8'), 'External edit');
  assert.equal(await fs.readFile(copy, 'utf8'), 'My edit');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['copy.md', 'document.md']);
});

test('saving supports empty documents and retains existing file permissions', async t => {
  const { file, document } = await fixture(t);
  await fs.chmod(file, 0o640);
  await writeDocument(file, '', document);
  assert.equal(await fs.readFile(file, 'utf8'), '');
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o640);
});

test('invalid UTF-8 and unsupported binary paths are rejected', async t => {
  const { file, directory } = await fixture(t);
  await fs.writeFile(file, Buffer.from([0xff, 0xfe]));
  await assert.rejects(readDocument(file));
  await assert.rejects(writeDocument(path.join(directory, 'file.exe'), 'text'), /extension/);
});

test('text and source files round-trip without formatting and retain line endings', async t => {
  const { directory } = await fixture(t);
  const names = ['app.ts', 'view.tsx', 'config.json', 'build.yaml', 'notes.txt', 'main.c', 'api.h', 'tool.py', 'query.sql', 'module.mts', 'model.xmi', 'requirements.reqif', 'data.csv', 'changes.patch', 'page.mdx', '.env.local', 'Dockerfile'];
  for (const name of names) {
    const file = path.join(directory, name);
    const original = '\ufeff# preserve <tags> and `backticks`\r\n\t  spaces  \r\n';
    await fs.writeFile(file, original);
    const opened = await readDocument(file);
    await writeDocument(file, opened.content, opened);
    assert.equal(await fs.readFile(file, 'utf8'), original, name);
    await writeDocument(file, opened.content + 'added\n', opened);
    assert.equal(await fs.readFile(file, 'utf8'), original + 'added\r\n', name);
  }
});

test('binary data disguised as text cannot be opened or saved', async t => {
  const { file, document } = await fixture(t, 'Safe text');
  await fs.writeFile(file, 'text\0binary');
  await assert.rejects(readDocument(file), /binary data/);
  await assert.rejects(writeDocument(file, 'text\0binary', document), /Binary data/);
  assert.equal(await fs.readFile(file, 'utf8'), 'text\0binary');
});

test('oversized files are rejected before loading into the editor', async t => {
  const { file } = await fixture(t);
  await fs.truncate(file, 10 * 1024 * 1024 + 1);
  await assert.rejects(readDocument(file), /10 MB/);
});

test('source-only detection protects metadata, HTML, references, math, and images', async () => {
  const { sourceOnlyReason } = await import('../src/lib/document.ts');
  for (const source of [
    '---\ntitle: Important\n---\n\n# Text',
    '# Hello\n\n<!-- do not lose this -->',
    '![diagram](image.png)',
    '[doc]: https://example.com',
    '$$\nx^2\n$$',
  ]) assert.ok(sourceOnlyReason(source), source);
  assert.equal(sourceOnlyReason('```html\n<div>Example</div>\n```'), null);
  assert.equal(sourceOnlyReason('````markdown\n```html\n<div>Example</div>\n```\n````'), null);
  assert.equal(sourceOnlyReason('# Hello\n\n| A | B |\n| - | - |\n| 1 | 2 |'), null);
});

test('inline code and prices do not trigger unsupported Markdown warnings', async () => {
  const { sourceOnlyReason } = await import('../src/lib/document.ts');
  for (const source of [
    '`$HOME` means your home folder. For example, `$HOME/app`.',
    'Run `printf "$HOME $PATH"` in Terminal.',
    'Use ``a `backtick` and $HOME $PATH`` literally.',
    '`<div>example</div>` and `![image](example.png)` are code.',
    'The price is $5 or $10.',
    'The range is $5–$10.',
    'Escaped \\$x + y\\$ is literal.',
  ]) assert.equal(sourceOnlyReason(source), null, source);
  for (const source of ['$x$', '$x^2 + y^2$', '$$\nx^2\n$$', '`$HOME` alongside $x^2$']) {
    assert.equal(sourceOnlyReason(source), 'math notation', source);
  }
});
