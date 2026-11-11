import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));

export async function desktopExecutable() {
  const electron = require('electron');
  if (process.platform !== 'darwin') return electron;

  // macOS takes the app identity from its bundle. Brand a cached copy so the
  // development launcher leaves the installed Electron dependency untouched.
  const version = require('electron/package.json').version;
  const icon = join(root, 'build/icon.icns');
  const fingerprint = createHash('sha256').update(version).update(process.arch)
    .update(await readFile(icon)).update(await readFile(fileURLToPath(import.meta.url)))
    .digest('hex').slice(0, 16);
  const cache = join(root, 'tmp/desktop-runtime');
  const directory = join(cache, `${version}-${fingerprint}`);
  const executable = join(directory, 'Slate.app/Contents/MacOS/Slate');
  const ready = join(directory, 'ready');
  if (await readFile(ready, 'utf8').catch(() => '') === fingerprint) return executable;

  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, '.metadata_never_index'), '');
  const staging = await mkdtemp(join(cache, 'prepare-'));
  const bundle = join(staging, 'Slate.app');
  await cp(resolve(electron, '../../..'), bundle, { recursive: true, verbatimSymlinks: true });
  await cp(icon, join(bundle, 'Contents/Resources/Slate.icns'));
  const plist = join(bundle, 'Contents/Info.plist');
  for (const [key, value] of Object.entries({
    CFBundleName: 'Slate', CFBundleDisplayName: 'Slate',
    CFBundleIdentifier: 'engineering.m45.slate.development',
    CFBundleExecutable: 'Slate', CFBundleIconFile: 'Slate.icns',
  })) execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, plist]);
  await rename(join(bundle, 'Contents/MacOS/Electron'), join(bundle, 'Contents/MacOS/Slate'));
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'pipe' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'pipe' });
  await writeFile(join(staging, 'ready'), fingerprint);
  try { await rename(staging, directory); }
  catch (error) { if (await readFile(ready, 'utf8').catch(() => '') !== fingerprint) throw error; }
  return executable;
}
