import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { desktopExecutable } from './desktop-executable.mjs';
const require = createRequire(import.meta.url);
const devUrl = 'http://127.0.0.1:3210';
const next = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', '3210'], { stdio: 'inherit' });
let desktop;
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  desktop?.kill(); next.kill();
  process.exitCode = code;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
next.on('exit', code => stop(code || 0));
const deadline = Date.now() + 60000;
while (!stopping && Date.now() < deadline) {
  try {
    const response = await fetch(devUrl);
    if (response.ok) {
      desktop = spawn(await desktopExecutable(), ['.', ...process.argv.slice(2).filter(value => value !== '--')], { stdio: 'inherit', env: { ...process.env, SLATE_DEV_URL: devUrl } });
      desktop.on('exit', code => stop(code || 0));
      break;
    }
  } catch { /* Next.js is still starting. */ }
  await new Promise(resolve => setTimeout(resolve, 300));
}
if (!desktop && !stopping) { console.error('Next.js did not start within 60 seconds.'); stop(1); }
