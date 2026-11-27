const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const execute = promisify(execFile);
const MAX_GIT_BYTES = 2 * 1024 * 1024;

function decodeText(bytes) {
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('This version is not UTF-8 text.'); }
  if (content.includes('\0')) throw new Error('This version contains binary data.');
  return content.replace(/\r\n/g, '\n');
}

// Deliberately private: callers get a document snapshot, never a command runner.
async function git(cwd, args, optional = false) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', LC_ALL: 'C' });
  try {
    return (await execute('git', ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], {
      cwd, env, encoding: 'buffer', timeout: 8000, maxBuffer: MAX_GIT_BYTES, windowsHide: true,
    })).stdout;
  } catch (error) {
    if (optional && error.code === 1) return null;
    if (error.code === 'ENOENT') throw new Error('Git is not installed or is not available to Slate. Install Git, then reopen Slate.');
    const detail = error.stderr?.toString() || '';
    if (detail.includes('not a git repository')) throw new Error('This document is not in a Git repository. Open a file or folder from an existing local repository.');
    if (error.killed) throw new Error('Reading Git history took too long. Try again.');
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('This committed document is too large to compare (2 MB limit).');
    throw new Error('Slate could not read this repository. Check its permissions and that its Git history is available locally.');
  }
}

async function text(cwd, args, optional = false) {
  const result = await git(cwd, args, optional);
  return result === null ? null : result.toString('utf8').trim();
}

async function readBlob(root, revision, relative) {
  if (!revision) return { content: '', exists: false };
  const entry = await text(root, ['ls-tree', '-z', revision, '--', `:(literal)${relative}`]);
  if (!entry) return { content: '', exists: false };
  const match = entry.match(/^(100644|100755) blob ([a-f0-9]{40,64})\t/);
  if (!match) throw new Error('Only regular text files can be compared.');
  const bytes = await git(root, ['cat-file', 'blob', match[2]]);
  return { content: decodeText(bytes), exists: true };
}

async function readGitDocument(file, revision = null) {
  if (revision !== null && (typeof revision !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision))) throw new Error('Choose a revision from this document’s history.');
  // Resolve only the path supplied by the main process's open-document record.
  const directory = await fs.realpath(path.dirname(file));
  if (directory.split(path.sep).includes('.git') || path.basename(file) === '.git') throw new Error('Choose a document inside the repository, outside its Git metadata.');
  const root = await text(directory, ['rev-parse', '--show-toplevel']);
  const relative = path.relative(root, path.join(directory, path.basename(file))).split(path.sep).join('/');
  if (!relative || relative.startsWith('../') || relative.split('/').includes('.git')) throw new Error('Choose a document inside the repository.');
  const branch = await text(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true);
  const head = await text(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], true);
  const history = [];
  if (head) {
    const log = await text(root, ['log', '--no-show-signature', '--no-notes', '-30', '--format=%H%x00%aI%x00%an%x00%s', head, '--', `:(literal)${relative}`]);
    for (const line of log.split('\n').filter(Boolean)) {
      const [hash, date, author, subject] = line.split('\0');
      history.push({ hash, date, author, subject });
    }
  }
  if (revision && !history.some(item => item.hash === revision)) throw new Error('This revision is no longer in the displayed history. Refresh and choose again.');
  const selected = revision || head;
  const baseline = await readBlob(root, selected, relative);
  let base = null;
  let ahead = null;
  let behind = null;
  for (const name of ['main', 'master']) {
    const hash = await text(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], true);
    if (hash && head) {
      base = name;
      [behind, ahead] = (await text(root, ['rev-list', '--left-right', '--count', `${hash}...${head}`])).split(/\s+/).map(Number);
      break;
    }
  }
  const finalHead = await text(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], true);
  const finalBranch = await text(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true);
  if (head !== finalHead || branch !== finalBranch) throw new Error('The branch changed while reading history. Refresh to compare with the current branch.');
  return { root, branch, head, relative, history, baseline: { ...baseline, revision: selected }, base, ahead, behind };
}

async function readGitChanges(folder, mode = 'local') {
  if (!['local', 'branch'].includes(mode)) throw new Error('Choose On this computer or Review preview.');
  const directory = await fs.realpath(folder);
  const root = await text(directory, ['rev-parse', '--show-toplevel']);
  const branch = await text(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true);
  const head = await text(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], true);
  if (mode === 'branch') {
    if (!head) throw new Error('No changes have been recorded in history yet. Choose On this computer to see your file edits.');
    // Use local main explicitly, never silently substitute a different target.
    const base = await text(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/main'], true);
    if (!base) throw new Error('The main version is not available on this computer. Ask someone who manages the project to make it available using their Git tool, then refresh.');
    const ancestors = await text(root, ['merge-base', '--all', base, head], true);
    if (!ancestors) throw new Error('This work and main have no shared history, so Slate cannot compare them.');
    const bases = ancestors.split('\n');
    if (bases.length !== 1) throw new Error('Slate cannot identify a single starting version for this work. Use your Git tool to review this comparison.');
    const mergeBase = bases[0];
    const fields = (await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=none', '--name-status', '-z', '-M', mergeBase, head, '--'])).toString('utf8').split('\0');
    const files = [];
    for (let index = 0; fields[index];) {
      const status = fields[index++][0];
      const first = fields[index++];
      const renamed = status === 'R' || status === 'C';
      files.push({ path: renamed ? fields[index++] : first, status, previous: renamed ? first : null });
    }
    const commits = Number(await text(root, ['rev-list', '--count', `${base}..${head}`]));
    await verifyHead(root, head, branch);
    if (base !== await text(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/main'], true)) throw new Error('The main version changed while reading. Refresh the comparison.');
    return { root, folder: root, mode, branch, head, base, mergeBase, commits, files };
  }
  const scope = path.relative(root, directory).split(path.sep).join('/');
  const result = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', `:(literal)${scope || '.'}`]);
  const fields = result.toString('utf8').split('\0');
  const files = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field) continue;
    const status = field.slice(0, 2), name = field.slice(3);
    const previous = /[RC]/.test(status) ? fields[++index] : null;
    const relative = path.relative(directory, path.join(root, name));
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    const localPath = relative.split(path.sep).join('/');
    const deleted = status === '??' && files.find(file => file.path === localPath && file.status[0] === 'D');
    if (deleted) deleted.status = 'D?';
    else files.push({ path: localPath, status, previous });
  }
  await verifyHead(root, head, branch);
  return { root, folder: directory, mode, branch, head, base: null, mergeBase: null, commits: 0, files };
}

async function verifyHead(root, head, branch) {
  if (head !== await text(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], true) || branch !== await text(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true)) throw new Error('The current work version changed while reading. Refresh the comparison.');
}

async function readGitChange(folder, mode, filename, expected) {
  if (typeof filename !== 'string' || !filename || path.isAbsolute(filename) || filename.split(/[\\/]/).some(part => part === '..' || part === '.git')) throw new Error('Choose a file from the changes list.');
  const snapshot = await readGitChanges(folder, mode);
  if (!expected || expected.head !== snapshot.head || expected.base !== snapshot.base) throw new Error('The comparison changed. Refresh the file list before continuing.');
  const file = snapshot.files.find(item => item.path === filename);
  if (!file) throw new Error('This file is no longer in the changes list. Refresh to see the latest changes.');
  const relative = path.relative(snapshot.root, path.join(snapshot.folder, file.path)).split(path.sep).join('/');
  const before = await readBlob(snapshot.root, mode === 'branch' ? snapshot.mergeBase : snapshot.head, file.previous || relative);
  let after;
  if (mode === 'branch') after = await readBlob(snapshot.root, snapshot.head, relative);
  else {
    const absolute = path.join(snapshot.folder, file.path);
    try {
      const stat = await fs.lstat(absolute);
      if (!stat.isFile()) throw new Error('Only regular text files can be previewed.');
      const resolved = await fs.realpath(absolute);
      const local = path.relative(snapshot.folder, resolved);
      if (path.isAbsolute(local) || local.startsWith(`..${path.sep}`)) throw new Error('This file resolves outside the open folder.');
      if (stat.size > MAX_GIT_BYTES) throw new Error('This file is too large to preview (2 MB limit).');
      const bytes = await fs.readFile(resolved);
      if (bytes.length > MAX_GIT_BYTES) throw new Error('This file is too large to preview (2 MB limit).');
      after = { content: decodeText(bytes), exists: true };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      after = { content: '', exists: false };
    }
  }
  if (before.content.length > 200_000 || after.content.length > 200_000) throw new Error('This file is too large for an inline preview (200,000 character limit).');
  return { before: before.content, after: after.content, beforeExists: before.exists, afterExists: after.exists };
}

module.exports = { readGitDocument, readGitChanges, readGitChange };
