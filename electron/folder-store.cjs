const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { MAX_BYTES } = require('./file-store.cjs');
const { isTextFile, isOpenableFile } = require('./file-types.cjs');
const { readGitSearchFiles } = require('./git-store.cjs');

const HIDDEN_DIRECTORIES = new Set(['.git', 'node_modules', '.next', '.venv', '__pycache__']);

function validateName(name) {
  if (typeof name !== 'string' || !name || name !== name.trim() || name === '.' || name === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(name) || name.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error('Enter a valid file or folder name without path separators.');
  }
}

class FolderStore {
  root = null;
  searchIndex = null;
  searchAbort = null;
  contentAbort = null;

  cancelContentSearch() {
    this.contentAbort?.abort();
    this.contentAbort = null;
  }

  invalidateSearchIndex() {
    this.cancelContentSearch();
    this.searchAbort?.abort();
    this.searchAbort = null;
    this.searchIndex = null;
  }

  async open(folderPath) {
    const root = await fs.realpath(folderPath);
    if (!(await fs.stat(root)).isDirectory()) throw new Error('Choose a folder.');
    this.root = root;
    this.invalidateSearchIndex();
    return this.snapshot();
  }

  snapshot() {
    return this.root ? { path: this.root, name: path.basename(this.root) || this.root } : null;
  }

  async resolve(relativePath = '') {
    if (!this.root) throw new Error('Open a folder first.');
    if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) throw new Error('Invalid relative path.');
    const candidate = path.resolve(this.root, relativePath);
    const resolved = await fs.realpath(candidate);
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) throw new Error('This path is outside the open folder.');
    return resolved;
  }

  async resolveEntry(relativePath) {
    const absolute = await this.resolve(relativePath);
    if (absolute === this.root) throw new Error('The open workspace folder cannot be renamed, moved, or deleted.');
    const entry = await fs.lstat(path.resolve(this.root, relativePath));
    if (entry.isSymbolicLink()) throw new Error('Symbolic links cannot be changed from the sidebar.');
    if (!entry.isFile() && !entry.isDirectory()) throw new Error('Choose a regular file or folder.');
    return absolute;
  }

  async relocate(relativePath, destination) {
    const from = await this.resolveEntry(relativePath);
    if (from === destination) return { from, to: destination };
    if (destination.startsWith(from + path.sep)) throw new Error('A folder cannot be moved inside itself.');
    try {
      await fs.lstat(destination);
      throw new Error('A file or folder with that name already exists. Nothing was replaced.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(from, destination);
    this.invalidateSearchIndex();
    return { from, to: destination };
  }

  async rename(relativePath, name) {
    validateName(name);
    const from = await this.resolveEntry(relativePath);
    return this.relocate(relativePath, path.join(path.dirname(from), name));
  }

  async move(relativePath, destinationFolder) {
    const from = await this.resolveEntry(relativePath);
    const parent = await this.resolve(destinationFolder);
    if (!(await fs.stat(parent)).isDirectory()) throw new Error('Choose a destination folder.');
    return this.relocate(relativePath, path.join(parent, path.basename(from)));
  }

  async planFileMoves(relativePaths, destinationFolder) {
    if (!Array.isArray(relativePaths) || !relativePaths.length || relativePaths.some(item => typeof item !== 'string')) throw new Error('Select files to move.');
    const parent = await this.resolve(destinationFolder);
    if (!(await fs.stat(parent)).isDirectory()) throw new Error('Choose a destination folder.');
    const sources = new Set();
    const destinations = new Set();
    const moves = [];
    // Reject known conflicts across the whole selection before moving any file.
    for (const relativePath of relativePaths) {
      const from = await this.resolveEntry(relativePath);
      if (!(await fs.stat(from)).isFile()) throw new Error('Select regular files to move together.');
      if (sources.has(from)) continue;
      sources.add(from);
      const to = path.join(parent, path.basename(from));
      if (from === to) continue;
      const key = process.platform === 'linux' ? to : to.toLowerCase();
      if (destinations.has(key)) throw new Error('Selected files have the same destination name. Nothing was moved.');
      try {
        await fs.lstat(to);
        throw new Error(`${path.basename(to)} already exists in the destination. Nothing was moved.`);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      destinations.add(key);
      moves.push({ path: relativePath, destination: path.relative(this.root, to).split(path.sep).join('/') });
    }
    return moves;
  }

  async importFiles(sources, destinationFolder) {
    if (!Array.isArray(sources) || !sources.length || sources.some(source => typeof source !== 'string' || !path.isAbsolute(source))) {
      throw new Error('Drop files from Finder or another file manager.');
    }
    const parent = await this.resolve(destinationFolder);
    if (!(await fs.stat(parent)).isDirectory()) throw new Error('Choose a destination folder.');
    const destinations = new Set();
    const files = [];
    // Check the whole selection before copying so known conflicts do not import a partial batch.
    for (const source of sources) {
      if (!(await fs.lstat(source)).isFile()) throw new Error('Drop regular files. Folders and symbolic links cannot be imported.');
      const name = path.basename(source);
      validateName(name);
      const destination = path.join(parent, name);
      if (destinations.has(destination)) throw new Error(`More than one dropped file is named ${name}. Nothing was copied.`);
      try {
        await fs.lstat(destination);
        throw new Error(`${name} already exists in this folder. Nothing was replaced.`);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      destinations.add(destination);
      files.push({ source, destination });
    }
    try {
      for (const file of files) await fs.copyFile(file.source, file.destination, constants.COPYFILE_EXCL);
    } finally { this.invalidateSearchIndex(); }
  }

  async trash(relativePath, trashItem) {
    const from = await this.resolveEntry(relativePath);
    await trashItem(from);
    this.invalidateSearchIndex();
    return { from, to: null };
  }

  async create(parentPath, name, kind, content = '') {
    validateName(name);
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_BYTES || content.includes('\0')) throw new Error('Invalid initial file content.');
    if (kind === 'directory' && content) throw new Error('A folder cannot have file content.');
    if (kind !== 'file' && kind !== 'directory') throw new Error('Choose a file or folder.');
    if (kind === 'file' && !isTextFile(name)) throw new Error('Use a supported text or code extension, such as .md, .txt, or .ts.');
    const parent = await this.resolve(parentPath);
    if (!(await fs.stat(parent)).isDirectory()) throw new Error('Choose a parent folder.');
    const absolute = path.join(parent, name);
    try {
      if (kind === 'directory') await fs.mkdir(absolute);
      else await fs.writeFile(absolute, content, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('A file or folder with that name already exists. Nothing was replaced.');
      throw error;
    }
    this.invalidateSearchIndex();
    return { absolute, path: path.relative(this.root, absolute).split(path.sep).join('/') };
  }

  async list(relativePath = '') {
    const absolute = await this.resolve(relativePath);
    const children = await fs.readdir(absolute, { withFileTypes: true });
    const visible = children.filter(entry => !HIDDEN_DIRECTORIES.has(entry.name)).sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    return {
      entries: visible.slice(0, 1500).map(entry => ({
        name: entry.name,
        path: path.relative(this.root, path.join(absolute, entry.name)).split(path.sep).join('/'),
        kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'link',
        editable: entry.isFile() && isOpenableFile(entry.name),
      })),
      truncated: visible.length > 1500,
    };
  }

  async buildSearchIndex(signal) {
    if (!this.root) throw new Error('Open a folder first.');
    const root = this.root;
    const queue = [root];
    const entries = [];
    let unreadableFolders = 0;
    while (queue.length) {
      signal.throwIfAborted();
      const directory = queue.pop();
      let children;
      // Read in batches so a wide folder does not need one enormous directory listing.
      try { children = await fs.opendir(directory, { bufferSize: 256 }); }
      catch (error) {
        if (directory === root) throw error;
        unreadableFolders++;
        continue;
      }
      for await (const child of children) {
        signal.throwIfAborted();
        if (HIDDEN_DIRECTORIES.has(child.name)) continue;
        const absolute = path.join(directory, child.name);
        if (child.isDirectory()) queue.push(absolute);
        else if (child.isFile() && isOpenableFile(child.name)) entries.push({
          name: child.name, path: path.relative(root, absolute).split(path.sep).join('/'), kind: 'file', editable: true,
        });
      }
    }
    signal.throwIfAborted();
    return { entries, unreadableFolders };
  }

  async searchContents(query, matchCase = false) {
    this.cancelContentSearch();
    if (!this.root) throw new Error('Open a folder first.');
    if (typeof query !== 'string' || query.length > 200 || /[\r\n]/.test(query)) throw new Error('Enter a single line of text up to 200 characters.');
    const result = { entries: [], total: 0, unreadableFolders: 0, skippedFiles: 0, usedGitIgnore: false };
    if (!query) return result;
    const controller = new AbortController();
    this.contentAbort = controller;
    const { signal } = controller;
    const root = this.root;
    // Scan afresh: both file contents and directory entries can change outside Slate.
    try {
      const gitFiles = await readGitSearchFiles(root, signal);
      signal.throwIfAborted();
      result.usedGitIgnore = gitFiles !== null;
      const index = gitFiles === null ? await this.buildSearchIndex(signal) : {
        entries: gitFiles.filter(relative => !relative.split('/').some(part => HIDDEN_DIRECTORIES.has(part))).map(relative => ({
          name: path.basename(relative), path: relative, kind: 'file', editable: true,
        })), unreadableFolders: 0,
      };
      result.unreadableFolders = index.unreadableFolders;
      const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? '' : 'i');
      index.entries.sort((a, b) => a.path.localeCompare(b.path));
      for (const entry of index.entries) {
        signal.throwIfAborted();
        if (!isTextFile(entry.name)) continue;
        let handle;
        try {
          // Recheck containment before reading; an indexed entry may have been replaced.
          const absolute = await this.resolve(entry.path);
          signal.throwIfAborted();
          if (absolute !== path.join(root, entry.path)) { result.skippedFiles++; continue; }
          handle = await fs.open(absolute, 'r');
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > MAX_BYTES) { result.skippedFiles++; continue; }
          // A bounded read also protects against a file growing during the scan.
          const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_BYTES + 1));
          let length = 0;
          while (length < buffer.length) {
            signal.throwIfAborted();
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
            if (!bytesRead) break;
            length += bytesRead;
          }
          if (length > stat.size || buffer.subarray(0, length).includes(0)) { result.skippedFiles++; continue; }
          const content = buffer.toString('utf8', 0, length);
          const match = pattern.exec(content);
          if (!match) continue;
          result.total++;
          if (result.entries.length === 100) continue;
          const from = match.index;
          const lineStart = content.lastIndexOf('\n', from - 1) + 1;
          const nextNewline = content.indexOf('\n', from);
          const lineEnd = nextNewline === -1 ? content.length : nextNewline;
          const start = Math.max(lineStart, from - 60);
          const end = Math.min(lineEnd, from + match[0].length + 120);
          const prefix = start > lineStart ? '…' : '';
          result.entries.push({ ...entry, match: {
            line: content.slice(0, from).split('\n').length,
            preview: prefix + content.slice(start, end).replace(/\r$/, '') + (end < lineEnd ? '…' : ''),
            start: prefix.length + from - start, length: match[0].length,
          } });
        } catch (error) {
          signal.throwIfAborted();
          result.skippedFiles++;
        } finally { await handle?.close(); }
      }
      signal.throwIfAborted();
      return result;
    } finally { if (this.contentAbort === controller) this.contentAbort = null; }
  }

  async search(query, refresh = false) {
    if (typeof query !== 'string' || query.length > 200) throw new Error('Enter a filename of up to 200 characters.');
    if (refresh) this.invalidateSearchIndex();
    if (!this.searchIndex) {
      const controller = new AbortController();
      this.searchAbort = controller;
      this.searchIndex = this.buildSearchIndex(controller.signal).catch(error => {
        // A canceled older scan must not discard a newer folder's index.
        if (this.searchAbort === controller) this.invalidateSearchIndex();
        throw error;
      });
    }
    const index = await this.searchIndex;
    const term = query.trim().toLowerCase();
    const matches = index.entries.filter(entry => entry.path.toLowerCase().includes(term));
    matches.sort((a, b) => Number(!a.name.toLowerCase().startsWith(term)) - Number(!b.name.toLowerCase().startsWith(term)) || a.path.localeCompare(b.path));
    return { entries: matches.slice(0, 100), total: matches.length, unreadableFolders: index.unreadableFolders };
  }
}

module.exports = { FolderStore };
