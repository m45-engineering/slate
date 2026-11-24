import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// A real two-page PDF with searchable text, produced deterministically for this test.
function samplePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    '',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [index, text] of [[3, 'Slate PDF preview'], [5, 'Searchable satellite requirements']] as const) {
    const stream = `BT /F1 24 Tf 60 700 Td (${text}) Tj ET\n`;
    objects[index] = `<< /Length ${stream.length} >>\nstream\n${stream}endstream`;
  }
  let content = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(content.length); content += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = content.length;
  content += `xref\n0 8\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return content;
}
let application: ElectronApplication;
let page: Page;
let directory: string;
let errors: string[];
async function launch(target?: string) {
  application = await electron.launch({ executablePath: process.env.SLATE_EXECUTABLE || undefined, args: [...(process.env.SLATE_EXECUTABLE ? [] : ['.']), `--user-data-dir=${path.join(directory, 'profile')}`, ...(target ? [path.join(directory, target)] : [])], env: { ...process.env, SLATE_DEV_URL: '' } });
  page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await application.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.setContentSize(1200, 850);
      window.webContents.setBackgroundThrottling(false);
      if (process.env.CI) { window.show(); window.focus(); }
      else { window.hide(); window.show = () => {}; window.focus = () => {}; }
    }
  });
}
async function open(name: string) {
  const result = await page.evaluate(name => window.slate!.openFile(name), name);
  expect(result.error).toBeUndefined();
}
test.beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'slate-previews-'));
  errors = [];
  await writeFile(path.join(directory, 'sample.pdf'), samplePdf());
  await writeFile(path.join(directory, 'drawing.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1200"><rect x="50" y="50" width="1700" height="1100" rx="25" fill="white" stroke="black"/><text x="150" y="200" font-size="50">A clear picture</text><script>window.previewScriptExecuted=true</script></svg>');
  await writeFile(path.join(directory, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  await writeFile(path.join(directory, 'broken.pdf'), 'not a PDF');
  await writeFile(path.join(directory, 'broken.png'), 'not an image');
  await writeFile(path.join(directory, 'report.docx'), 'native document');
  await writeFile(path.join(directory, 'sheet.xlsx'), 'native workbook');
});
test.afterEach(async () => {
  await application?.close();
  await rm(directory, { recursive: true, force: true });
  expect(errors).toEqual([]);
});

test('PDF renders with selectable text, search, navigation, zoom, read-only protection, and restart', async () => {
  await launch('sample.pdf');
  await expect(page.getByLabel('PDF page', { exact: true })).toHaveValue('1');
  const pane = (await page.getByLabel('PDF viewer', { exact: true }).boundingBox())!;
  const main = (await page.locator('.editor-main').boundingBox())!;
  expect(Math.abs(pane.width - main.width)).toBeLessThan(2);
  await expect(page.locator('.textLayer').getByText('Slate PDF preview', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  const source = await readFile(path.join(directory, 'sample.pdf'));
  const denied = await page.evaluate(async () => {
    const state = await window.slate!.ready();
    const doc = state.documents.find(doc => doc.id === state.activeId)!;
    return window.slate!.save('overwrite', true, { id: doc.id, path: doc.path });
  });
  expect(denied.error).toMatch(/read-only/);
  await expect(page.getByText('This file is read-only in Slate.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss message' }).click();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByLabel('PDF page', { exact: true })).toHaveValue('2');
  await expect(page.locator('.textLayer').getByText('Searchable satellite requirements', { exact: true })).toBeVisible();
  await page.getByLabel('PDF zoom', { exact: true }).selectOption('1.5');
  await expect(page.getByLabel('PDF zoom', { exact: true })).toHaveValue('1.5');
  await page.getByRole('button', { name: 'Search PDF', exact: true }).click();
  await page.getByLabel('Find in PDF', { exact: true }).fill('Slate');
  await expect(page.locator('.textLayer .highlight.selected')).toHaveText('Slate');
  await expect(page.locator('.textLayer .highlight.selected')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.25)');
  await expect(page.getByLabel('PDF page', { exact: true })).toHaveValue('1');
  await page.getByLabel('PDF zoom', { exact: true }).selectOption('page-fit');
  await mkdir('tmp/preview-checks', { recursive: true });
  await expect.poll(async () => { const paper = (await page.locator('.page[data-page-number="1"]').boundingBox())!; const viewport = (await page.getByLabel('PDF pages', { exact: true }).boundingBox())!; return paper.y >= viewport.y - 1 && paper.y + paper.height <= viewport.y + viewport.height + 1; }).toBe(true);
  await page.screenshot({ path: 'tmp/preview-checks/pdf.png' });
  expect(await readFile(path.join(directory, 'sample.pdf'))).toEqual(source);
  await application.close();
  await launch();
  await expect(page.locator('.textLayer').getByText('Slate PDF preview', { exact: true })).toBeVisible();
});

test('images fit, zoom, pan, reload and keep SVG scripts inert', async () => {
  await launch('drawing.svg');
  const image = page.getByRole('img', { name: 'drawing.svg', exact: true });
  await expect(image).toBeVisible();
  await expect(page.getByText('1,800 × 1,200 px')).toBeVisible();
  expect(await image.evaluate(image => (image as HTMLImageElement).width)).toBeLessThan(1800);
  expect(await page.evaluate(() => (window as unknown as { previewScriptExecuted?: boolean }).previewScriptExecuted)).toBeUndefined();
  await page.getByLabel('Image zoom').selectOption('1');
  await expect.poll(() => image.evaluate(image => (image as HTMLImageElement).width)).toBe(1800);
  const viewport = page.getByLabel('Image canvas');
  const box = (await viewport.boundingBox())!;
  await page.mouse.move(box.x + 400, box.y + 300);
  await page.mouse.down(); await page.mouse.move(box.x + 200, box.y + 150); await page.mouse.up();
  expect(await viewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(100);
  await page.getByLabel('Image zoom').selectOption('fit');
  await page.screenshot({ path: 'tmp/preview-checks/image.png' });
  await open('pixel.png');
  await expect(page.getByText('1 × 1 px')).toBeVisible();
  await writeFile(path.join(directory, 'pixel.png'), 'broken replacement');
  await expect(page.getByRole('button', { name: 'Reload file' })).toBeVisible();
  await page.getByRole('button', { name: 'Reload file' }).click();
  await expect(page.locator('.preview-message[role=alert]')).toContainText('could not display this image');
});

test('Office documents use default apps without tabs and preview failures are readable', async () => {
  await launch('sample.pdf');
  await expect(page.locator('.textLayer').getByText('Slate PDF preview', { exact: true })).toBeVisible();
  await application.evaluate(({ shell }) => {
    (globalThis as unknown as { opened: string[] }).opened = [];
    shell.openPath = async file => { (globalThis as unknown as { opened: string[] }).opened.push(file); return file.endsWith('.xlsx') ? 'No application is associated with this file.' : ''; };
  });
  const count = await page.getByRole('tab').count();
  await open('report.docx');
  expect(await page.getByRole('tab').count()).toBe(count);
  const failed = await page.evaluate(() => window.slate!.openFile('sheet.xlsx'));
  expect(failed.error).toContain('No application is associated');
  await expect(page.getByRole('status')).toContainText('Could not open sheet.xlsx');
  await page.getByRole('button', { name: 'Dismiss message' }).click();
  await page.getByRole('button', { name: 'Open in default app' }).click();
  expect(await application.evaluate(() => (globalThis as unknown as { opened: string[] }).opened.map(file => file.split(/[\\/]/).pop()))).toEqual(['report.docx', 'sheet.xlsx', 'sample.pdf']);
  await open('broken.pdf');
  await expect(page.locator('.preview-message[role=alert]')).toContainText('could not open this PDF');
  await open('broken.png');
  await expect(page.locator('.preview-message[role=alert]')).toContainText('could not display this image');
  const result = await page.evaluate(async () => { const state = await window.slate!.ready(); return window.slate!.closeTab(state.activeId); });
  expect(result.canceled).toBeFalsy();
  await expect(page.locator('.preview-message[role=alert]')).toContainText('could not open this PDF');
});
