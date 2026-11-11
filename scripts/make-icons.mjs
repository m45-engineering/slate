// Regenerate Slate branding from the installed Lucide Notebook Pen icon.
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotebookPen } from 'lucide-react';

const require = createRequire(import.meta.url);
const nextRequire = createRequire(require.resolve('next/package.json'));
const sharp = nextRequire('sharp');
await mkdir(new URL('../public/', import.meta.url), { recursive: true });
const mark = renderToStaticMarkup(createElement(NotebookPen, { size: 24, strokeWidth: 1.5 }));
const darkMark = mark.replace('width="24" height="24"', 'x="248" y="248" width="528" height="528"').replace('stroke="currentColor"', 'stroke="#181818"');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><title>Slate</title><rect x="64" y="64" width="896" height="896" rx="200" fill="#ffffff"/>${darkMark}</svg>`;
await writeFile(new URL('../build/icon.svg', import.meta.url), svg + '\n');
await writeFile(new URL('../public/slate-mark.svg', import.meta.url), mark.replace('stroke="currentColor"', 'stroke="#181818"') + '\n');
await writeFile(new URL('../public/lucide-LICENSE.txt', import.meta.url), await readFile(new URL('../node_modules/lucide-react/LICENSE', import.meta.url)));

await sharp(Buffer.from(svg)).png().toFile(fileURLToPath(new URL('../build/icon.png', import.meta.url)));

await sharp(Buffer.from(svg)).png().toFile(fileURLToPath(new URL('../public/slate-icon.png', import.meta.url)));

// ICO can carry a PNG frame; both Explorer and electron-builder support it.
const png = await sharp(Buffer.from(svg)).resize(256, 256).png().toBuffer();
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
await writeFile(new URL('../build/icon.ico', import.meta.url), Buffer.concat([header, png]));

// macOS ICNS frames are PNG files with an eight-byte type/length header.
const frames = [];
for (const [type, size] of [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]]) {
  const data = await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
  const frame = Buffer.alloc(8); frame.write(type); frame.writeUInt32BE(data.length + 8, 4);
  frames.push(frame, data);
}
const icnsHeader = Buffer.alloc(8); icnsHeader.write('icns');
icnsHeader.writeUInt32BE(8 + frames.reduce((total, frame) => total + frame.length, 0), 4);
await writeFile(new URL('../build/icon.icns', import.meta.url), Buffer.concat([icnsHeader, ...frames]));


const background = `<svg xmlns="http://www.w3.org/2000/svg" width="660" height="420" viewBox="0 0 660 420">
  <rect width="660" height="420" fill="#ffffff"/>
  <text x="330" y="64" text-anchor="middle" font-family="Helvetica Neue,Arial,sans-serif" font-size="30" font-weight="500" fill="#181818">Slate</text>
  <path d="M291 207h78m-15-15 15 15-15 15" fill="none" stroke="#525252" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="330" y="351" text-anchor="middle" font-family="Helvetica Neue,Arial,sans-serif" font-size="16" fill="#181818">Drag Slate to Applications</text>
  <text x="330" y="381" text-anchor="middle" font-family="Helvetica Neue,Arial,sans-serif" font-size="12" fill="#525252">M45 Engineering</text>
</svg>`;
await writeFile(new URL('../build/dmg-background.svg', import.meta.url), background + '\n');
await sharp(Buffer.from(background)).png().toFile(fileURLToPath(new URL('../build/dmg-background.png', import.meta.url)));
