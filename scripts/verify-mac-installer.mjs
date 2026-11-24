import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [installer, ...extra] = process.argv.slice(2);
if (!installer || extra.length) {
  throw new Error('Usage: node scripts/verify-mac-installer.mjs <installer.dmg>');
}
const { version, productName } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const mount = mkdtempSync(path.join(tmpdir(), 'slate-installer-check-'));
let mounted = false;
try {
  execFileSync('hdiutil', ['attach', path.resolve(installer), '-readonly', '-nobrowse', '-mountpoint', mount], { stdio: 'inherit' });
  mounted = true;
  const app = path.join(mount, `${productName}.app`);
  // Check the distributed app, not just the bundle that existed before DMG creation.
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  const installedVersion = execFileSync('/usr/libexec/PlistBuddy', [
    '-c', 'Print :CFBundleShortVersionString', path.join(app, 'Contents/Info.plist'),
  ], { encoding: 'utf8' }).trim();
  if (installedVersion !== version) {
    throw new Error(`Installer version ${installedVersion} does not match package version ${version}`);
  }
  console.log(`Verified ${productName} ${version} signature inside ${installer}`);
} finally {
  if (mounted) execFileSync('hdiutil', ['detach', mount], { stdio: 'inherit' });
  rmdirSync(mount);
}
