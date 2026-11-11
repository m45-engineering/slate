const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const emptySession = () => ({ folder: null, file: null, files: [] });
const absolutePath = value => typeof value === 'string' && path.isAbsolute(value) ? value : null;

class SessionStore {
  constructor(directory) {
    this.filename = path.join(directory, 'workspace.json');
    this.pending = Promise.resolve();
    this.lastSaved = null;
  }

  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.filename, 'utf8'));
      if (![1, 2].includes(saved?.version)) return emptySession();
      const file = absolutePath(saved.file);
      const files = saved.version === 2 && Array.isArray(saved.files) ? [...new Set(saved.files.map(absolutePath).filter(Boolean))] : file ? [file] : [];
      return { folder: absolutePath(saved.folder), file, files };
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return emptySession();
      throw error;
    }
  }

  save({ folder, file, files = file ? [file] : [] }) {
    const serialized = JSON.stringify({ version: 2, folder: absolutePath(folder), file: absolutePath(file), files: [...new Set(files.map(absolutePath).filter(Boolean))] }) + '\n';
    this.pending = this.pending.catch(() => {}).then(async () => {
      if (serialized === this.lastSaved) return;
      await fs.mkdir(path.dirname(this.filename), { recursive: true });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, serialized, { mode: 0o600 });
        await fs.rename(temporary, this.filename);
        this.lastSaved = serialized;
      } finally {
        await fs.rm(temporary, { force: true });
      }
    });
    return this.pending;
  }
}

module.exports = { SessionStore };
