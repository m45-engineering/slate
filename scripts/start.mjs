import { spawn } from 'node:child_process';
import { desktopExecutable } from './desktop-executable.mjs';

const desktop = spawn(await desktopExecutable(), ['.', ...process.argv.slice(2).filter(value => value !== '--')], {
  stdio: 'inherit', env: { ...process.env, SLATE_DEV_URL: '' },
});
desktop.on('error', error => { console.error(error.message); process.exitCode = 1; });
desktop.on('exit', code => { process.exitCode = code || 0; });
