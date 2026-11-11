const fs = require('node:fs/promises');
const path = require('node:path');
const { isTextFile } = require('./file-types.cjs');

const HIDDEN_DIRECTORIES = new Set(['.git', 'node_modules', '.next', '.venv', '__pycache__']);

function validateName(name) {
  if (typeof name !== 'string' || !name || name !== name.trim() || name === '.' || name === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(name) || name.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error('Enter a valid file or folder name without path separators.');
  }
}

class FolderStore {
  root = null;
  searchIndex = null;

  async open(folderPath) {
    const root = await fs.realpath(folderPath);
    if (!(await fs.stat(root)).isDirectory()) throw new Error('Choose a folder.');
    this.root = root;
    this.searchIndex = null;
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
    this.searchIndex = null;
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

  async trash(relativePath, trashItem) {
    const from = await this.resolveEntry(relativePath);
    await trashItem(from);
    this.searchIndex = null;
    return { from, to: null };
  }

  async create(parentPath, name, kind) {
    validateName(name);
    if (kind !== 'file' && kind !== 'directory') throw new Error('Choose a file or folder.');
    if (kind === 'file' && !isTextFile(name)) throw new Error('Use a supported text or code extension, such as .md, .txt, or .ts.');
    const parent = await this.resolve(parentPath);
    if (!(await fs.stat(parent)).isDirectory()) throw new Error('Choose a parent folder.');
    const absolute = path.join(parent, name);
    try {
      if (kind === 'directory') await fs.mkdir(absolute);
      else await fs.writeFile(absolute, '', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('A file or folder with that name already exists. Nothing was replaced.');
      throw error;
    }
    this.searchIndex = null;
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
        editable: entry.isFile() && isTextFile(entry.name),
      })),
      truncated: visible.length > 1500,
    };
  }

  async buildSearchIndex() {
    if (!this.root) throw new Error('Open a folder first.');
    const root = this.root;
    const queue = [root];
    const entries = [];
    let visited = 0;
    while (queue.length && visited < 50000) {
      const directory = queue.pop();
      let children;
      try { children = await fs.readdir(directory, { withFileTypes: true }); }
      catch { continue; } // A folder may be removed or become unreadable during indexing.
      for (const child of children) {
        if (HIDDEN_DIRECTORIES.has(child.name)) continue;
        visited++;
        if (visited > 50000) break;
        const absolute = path.join(directory, child.name);
        if (child.isDirectory()) queue.push(absolute);
        else if (child.isFile() && isTextFile(child.name)) entries.push({
          name: child.name, path: path.relative(root, absolute).split(path.sep).join('/'), kind: 'file', editable: true,
        });
      }
    }
    return { entries, truncated: visited > 50000 || queue.length > 0 };
  }

  async search(query, refresh = false) {
    if (typeof query !== 'string' || query.length > 200) throw new Error('Enter a filename of up to 200 characters.');
    if (refresh) this.searchIndex = null;
    this.searchIndex ??= this.buildSearchIndex().catch(error => { this.searchIndex = null; throw error; });
    const index = await this.searchIndex;
    const term = query.trim().toLowerCase();
    const matches = index.entries.filter(entry => entry.path.toLowerCase().includes(term));
    matches.sort((a, b) => Number(!a.name.toLowerCase().startsWith(term)) - Number(!b.name.toLowerCase().startsWith(term)) || a.path.localeCompare(b.path));
    return { entries: matches.slice(0, 100), total: matches.length, truncated: index.truncated };
  }
}

module.exports = { FolderStore };
