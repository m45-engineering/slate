const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readGitDocument, readGitChanges, readGitChange } = require('../electron/git-store.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-git-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Slate Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'fixture');
  return { root, git, file: path.join(root, 'spec.md') };
}

async function fingerprint(root) {
  const files = {};
  async function visit(directory) {
    for (const name of await fs.readdir(directory)) {
      const file = path.join(directory, name), stat = await fs.lstat(file);
      if (stat.isDirectory()) await visit(file);
      else if (stat.isFile()) files[path.relative(root, file)] = `${stat.mtimeMs}:${createHash('sha256').update(await fs.readFile(file)).digest('hex')}`;
    }
  }
  await visit(root);
  return files;
}

test('Git inspection reads revisions and staged/unstaged changes without changing any files or index', async t => {
  const { root, git, file } = await fixture(t);
  await fs.writeFile(file, '# Spec\n\nOld words.\n');
  await fs.writeFile(path.join(root, 'deleted.md'), 'deleted later');
  git('add', '.'); git('commit', '-qm', 'Baseline');
  const original = git('rev-parse', 'HEAD');
  await fs.writeFile(file, '# Spec\n\nRecorded words.\n');
  git('add', 'spec.md'); git('commit', '-qm', 'Update wording');
  git('branch', 'main');
  git('switch', '-qc', 'work');
  await fs.writeFile(file, '# Spec\n\nStaged words.\n'); git('add', 'spec.md');
  await fs.writeFile(file, '# Spec\n\nUnstaged words.\n');
  await fs.writeFile(path.join(root, 'new [file].md'), 'new');
  await fs.unlink(path.join(root, 'deleted.md'));
  const before = await fingerprint(root);
  const snapshot = await readGitDocument(file);
  assert.equal(snapshot.branch, 'work');
  assert.equal(snapshot.baseline.content, '# Spec\n\nRecorded words.\n');
  assert.equal(snapshot.history.length, 2);
  assert.equal(snapshot.ahead, 0);
  assert.equal((await readGitDocument(file, original)).baseline.content, '# Spec\n\nOld words.\n');
  const overview = await readGitChanges(root);
  assert.equal(overview.files.find(item => item.path === 'spec.md').status, 'MM');
  assert.equal(overview.files.find(item => item.path === 'deleted.md').status, ' D');
  assert.equal(overview.files.find(item => item.path === 'new [file].md').status, '??');
  assert.deepEqual(await fingerprint(root), before);
});

test('new repositories, detached heads, literal filenames and renamed files are handled', async t => {
  const { root, git } = await fixture(t);
  const file = path.join(root, 'a [1].md');
  await fs.writeFile(file, 'before');
  assert.equal((await readGitDocument(file)).baseline.exists, false);
  git('add', '.'); git('commit', '-qm', 'First');
  assert.equal((await readGitDocument(file)).baseline.content, 'before');
  git('mv', 'a [1].md', 'renamed.md');
  const changed = (await readGitChanges(root)).files[0];
  assert.equal(changed.path, 'renamed.md'); assert.equal(changed.previous, 'a [1].md');
  assert.equal(changed.status, 'R ');
  git('checkout', '--detach', '-q');
  assert.equal((await readGitDocument(path.join(root, 'renamed.md'))).branch, null);
});

test('external diff and filesystem monitor settings do not run, and invalid revisions are rejected', async t => {
  const { root, git, file } = await fixture(t);
  await fs.writeFile(file, 'safe'); git('add', '.'); git('commit', '-qm', 'Baseline');
  const marker = path.join(root, 'must-not-exist');
  const script = path.join(root, 'external.sh');
  await fs.writeFile(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  git('branch', 'main');
  await fs.writeFile(file, 'safe branch update'); git('add', 'spec.md'); git('commit', '-qm', 'Update');
  git('config', 'core.fsmonitor', script); git('config', 'diff.external', script);
  await readGitDocument(file); await readGitChanges(root);
  const branch = await readGitChanges(root, 'branch');
  await readGitChange(root, 'branch', 'spec.md', branch);
  await assert.rejects(fs.access(marker));
  await assert.rejects(readGitDocument(file, '--exec=unsafe'), /Choose a revision/);
  await assert.rejects(readGitDocument(file, 'a'.repeat(40)), /no longer/);
  await assert.rejects(readGitDocument(path.join(root, '.git', 'config')), /inside the repository/);
});

test('nested folder overview stays scoped and binary baselines are refused', async t => {
  const { root, git, file } = await fixture(t);
  await fs.mkdir(path.join(root, 'docs'));
  await fs.writeFile(file, 'outside'); await fs.writeFile(path.join(root, 'docs', 'a.md'), 'inside');
  git('add', '.'); git('commit', '-qm', 'Baseline');
  await fs.writeFile(file, 'outside changed'); await fs.writeFile(path.join(root, 'docs', 'a.md'), 'inside changed');
  assert.deepEqual((await readGitChanges(path.join(root, 'docs'))).files.map(item => item.path), ['a.md']);
  await fs.writeFile(file, Buffer.from([0, 1, 2])); git('add', '.'); git('commit', '-qm', 'Binary');
  await assert.rejects(readGitDocument(file), /binary/);
});

test('PR preview compares the shared ancestor with committed branch content across the repository without writes', async t => {
  const { root, git, file } = await fixture(t);
  await fs.mkdir(path.join(root, 'docs'));
  await fs.writeFile(file, 'original\n');
  await fs.writeFile(path.join(root, 'docs', 'old.md'), 'rename this document\n');
  await fs.writeFile(path.join(root, 'deleted.md'), 'removed on branch\n');
  git('add', '.'); git('commit', '-qm', 'Shared ancestor');
  const ancestor = git('rev-parse', 'HEAD');
  git('branch', 'main');
  git('switch', '-qc', 'feature');
  await fs.writeFile(file, 'committed branch words\n');
  git('mv', 'docs/old.md', 'docs/new.md');
  git('rm', '-q', 'deleted.md');
  await fs.writeFile(path.join(root, 'added.md'), 'added on branch\n');
  git('add', '.'); git('commit', '-qm', 'Branch work');
  git('switch', '-qc', 'target-work', 'main');
  await fs.writeFile(path.join(root, 'only-on-main.md'), 'not part of the PR\n');
  git('add', '.'); git('commit', '-qm', 'Main advanced independently');
  git('branch', '-f', 'main', 'HEAD'); git('switch', '-q', 'feature');
  await fs.writeFile(file, 'staged draft\n'); git('add', 'spec.md');
  await fs.writeFile(file, 'unsaved-to-Git disk edit\n');
  await fs.writeFile(path.join(root, 'untracked.md'), 'not in PR');
  const before = await fingerprint(root);
  const snapshot = await readGitChanges(path.join(root, 'docs'), 'branch');
  assert.equal(path.normalize(snapshot.folder), await fs.realpath(root));
  assert.equal(snapshot.mergeBase, ancestor);
  assert.equal(snapshot.commits, 1);
  assert.deepEqual(snapshot.files.map(item => [item.path, item.status]), [['added.md', 'A'], ['deleted.md', 'D'], ['docs/new.md', 'R'], ['spec.md', 'M']]);
  const preview = await readGitChange(root, 'branch', 'spec.md', snapshot);
  assert.equal(preview.before, 'original\n'); assert.equal(preview.after, 'committed branch words\n');
  assert.equal((await readGitChange(root, 'branch', 'deleted.md', snapshot)).afterExists, false);
  const renamed = await readGitChange(root, 'branch', 'docs/new.md', snapshot);
  assert.equal(renamed.before, renamed.after);
  assert.deepEqual(await fingerprint(root), before);
  git('branch', '-f', 'main', ancestor);
  await assert.rejects(readGitChange(root, 'branch', 'spec.md', snapshot), /comparison changed/);
});

test('saved file previews handle additions and deletions and reject binary files, links, and paths outside the list', async t => {
  const { root, git, file } = await fixture(t);
  await fs.writeFile(file, 'before\n');
  await fs.writeFile(path.join(root, 'deleted.md'), 'deleted\n');
  git('add', '.'); git('commit', '-qm', 'Baseline');
  await fs.writeFile(file, 'after\n');
  await fs.unlink(path.join(root, 'deleted.md'));
  await fs.writeFile(path.join(root, 'new.md'), 'new\n');
  await fs.writeFile(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2]));
  await fs.symlink(file, path.join(root, 'link.md'));
  const snapshot = await readGitChanges(root);
  const before = await fingerprint(root);
  assert.deepEqual(await readGitChange(root, 'local', 'spec.md', snapshot), { before: 'before\n', after: 'after\n', beforeExists: true, afterExists: true });
  assert.equal((await readGitChange(root, 'local', 'deleted.md', snapshot)).after, '');
  assert.equal((await readGitChange(root, 'local', 'new.md', snapshot)).beforeExists, false);
  await assert.rejects(readGitChange(root, 'local', 'binary.dat', snapshot), /binary/);
  await assert.rejects(readGitChange(root, 'local', 'link.md', snapshot), /regular text/);
  await assert.rejects(readGitChange(root, 'local', '../outside.md', snapshot), /Choose a file/);
  await assert.rejects(readGitChange(root, 'local', '.git/config', snapshot), /Choose a file/);
  await assert.rejects(readGitChange(root, 'local', 'missing.md', snapshot), /no longer/);
  await assert.rejects(readGitChanges(root, '--output=write'), /Choose On this computer/);
  assert.deepEqual(await fingerprint(root), before);
  git('rm', '--cached', '-q', 'spec.md');
  const replacement = await readGitChanges(root);
  assert.equal(replacement.files.filter(item => item.path === 'spec.md').length, 1);
  assert.equal(replacement.files.find(item => item.path === 'spec.md').status, 'D?');
  assert.equal((await readGitChange(root, 'local', 'spec.md', replacement)).after, 'after\n');
});

test('branch comparison explains missing history and main and handles identical and detached heads', async t => {
  const { root, git, file } = await fixture(t);
  await assert.rejects(readGitChanges(root, 'branch'), /No changes have been recorded/);
  await fs.writeFile(file, 'baseline'); git('add', '.'); git('commit', '-qm', 'Baseline');
  await assert.rejects(readGitChanges(root, 'branch'), /main version is not available/);
  git('branch', 'main');
  assert.deepEqual((await readGitChanges(root, 'branch')).files, []);
  git('checkout', '--detach', '-q');
  assert.equal((await readGitChanges(root, 'branch')).branch, null);
});
