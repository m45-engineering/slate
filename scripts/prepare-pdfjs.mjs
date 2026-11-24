import { cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const source = path.dirname(require.resolve('pdfjs-dist/package.json'));
const destination = new URL('../public/pdfjs/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const name of ['cmaps', 'standard_fonts', 'wasm']) {
  await cp(path.join(source, name), new URL(name, destination), { recursive: true });
}
await cp(path.join(source, 'build/pdf.worker.min.mjs'), new URL('pdf.worker.min.mjs', destination));
await cp(path.join(source, 'LICENSE'), new URL('LICENSE', destination));
