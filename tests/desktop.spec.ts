import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, realpath, writeFile, readFile, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let application: ElectronApplication;
let applicationClosed = false;
let rendererErrors: string[] = [];
let page: Page;
let directory: string;
let file: string;
const original = '# A real document\n\nWords for people and agents.\n\n| Name | Status |\n| --- | --- |\n| Slate | Ready |\n\n```mermaid\nflowchart LR\n  A[Write] --> B[Review]\n```\n\n```typescript\nconst value = 42;\n```\n';

async function launch(target?: string) {
  application = await electron.launch({
    executablePath: process.env.SLATE_EXECUTABLE || undefined,
    args: [...(process.env.SLATE_EXECUTABLE && !process.env.SLATE_UNPACKAGED ? [] : ['.']), `--user-data-dir=${path.join(directory, 'profile')}`, ...(target ? [target] : [])],
    env: { ...process.env, SLATE_DEV_URL: '' },
  });
  applicationClosed = false;
  application.once('close', () => { applicationClosed = true; });
  page = await application.firstWindow();
  page.on('pageerror', error => rendererErrors.push(error.message));
  // Exercise the real app without sending the user's keyboard input into test documents.
  await application.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.hide();
      window.show = () => {};
      window.focus = () => {};
      window.webContents.setBackgroundThrottling(false);
    }
  });
}

async function restart(target?: string) {
  if (!applicationClosed) await application.close();
  await launch(target);
}

test.beforeEach(async () => {
  rendererErrors = [];
  directory = await mkdtemp(path.join(os.tmpdir(), 'slate-desktop-'));
  file = path.join(directory, 'sample.md');
  await writeFile(file, original);
  await launch(file);
  await expect(page.getByRole('heading', { name: 'A real document', exact: true })).toBeVisible();
});

test.afterEach(async () => {
  if (application && !applicationClosed) {
    await application.evaluate(({ app }) => app.exit(0));
    await application.close();
  }
  if (directory) await rm(directory, { recursive: true, force: true });
  expect(rendererErrors).toEqual([]);
});

test('runs as an isolated desktop app with a live Mermaid preview', async () => {
  await expect(page.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible();
  await expect(page.locator('.document-editor table')).toContainText('Ready');
  await expect(page.locator('.code-block').last()).toContainText('const value = 42;');
  await expect(page.getByRole('button', { name: 'sample.md', exact: true })).toHaveAttribute('aria-current', 'page');
  expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined');
  await page.screenshot({ path: 'tmp/slate-desktop.png' });
});

test('Save stays disabled and view changes leave an unchanged file untouched', async () => {
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue(original);
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(page.getByText('Saved to file', { exact: true })).toBeVisible();
  expect(await readFile(file, 'utf8')).toBe(original);
});

test('existing files stay unchanged until explicitly saved', async () => {
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown source' });
  await source.fill('# First edit\n');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await source.fill('# Latest edit\n');
  await page.waitForTimeout(1400); // Longer than the former autosave delay.
  expect(await readFile(file, 'utf8')).toBe(original);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('slate-unsaved-drafts-v2')!)[0].content)).toBe('# Latest edit\n');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => readFile(file, 'utf8')).toBe('# Latest edit\n');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(page.getByText('Saved to file', { exact: true })).toBeVisible();
  expect(await application.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('save-document')?.enabled)).toBe(false);
});

test('new documents and later edits both require explicit Save', async () => {
  const target = path.join(directory, 'new-document.md');
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, target);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown source' });
  await source.fill('# Unsaved draft\n');
  await page.waitForTimeout(1200); // An untitled draft must not open a save dialog by itself.
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await expect(readFile(target, 'utf8')).rejects.toThrow();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => readFile(target, 'utf8').catch(() => null)).toBe('# Unsaved draft\n');
  await source.fill('# Saved explicitly\n');
  await page.waitForTimeout(1400);
  expect(await readFile(target, 'utf8')).toBe('# Unsaved draft\n');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readFile(target, 'utf8')).toBe('# Saved explicitly\n');
  await expect(page.getByText('Saved to file', { exact: true })).toBeVisible();
  await restart();
  await expect(page.getByRole('heading', { name: 'Saved explicitly' })).toBeVisible();
});

test('a delayed save cannot target a different open document', async () => {
  const before = await readFile(file, 'utf8');
  const result = await page.evaluate(() => window.slate!.save('# Wrong document\n', false, { path: '/not-the-open-file.md' }));
  expect(result.canceled).toBe(true);
  expect(await readFile(file, 'utf8')).toBe(before);
});

test('visual text, table edits, and Mermaid source survive saving and reopening', async () => {
  const cell = page.locator('.document-editor td').filter({ hasText: 'Ready' });
  await cell.click();
  await page.keyboard.press('Home');
  await page.keyboard.type('Almost ');
  await page.getByRole('button', { name: 'Edit diagram' }).click();
  const diagramSource = page.getByRole('textbox', { name: 'Mermaid source' });
  await expect(diagramSource).toBeVisible();
  await diagramSource.fill('flowchart LR\n  A[Write] --> B[Review]\n  B --> C[Ship]');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByText('Saved to file', { exact: true })).toBeVisible();
  const saved = await readFile(file, 'utf8');
  expect(saved).toContain('Almost Ready');
  expect(saved).toContain('C[Ship]');
  expect(saved).toContain('```mermaid');
  expect(saved).toContain('const value = 42;');
  await page.reload();
  await expect(page.locator('.document-editor table')).toContainText('Almost Ready');
  await expect(page.getByRole('img', { name: 'Mermaid diagram' })).toContainText('Ship');
});

test('external writes produce a conflict and Save cannot overwrite them', async () => {
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# My draft\n');
  await writeFile(file, '# Agent edit\n');
  await expect(page.getByText('This file changed outside Slate. Your edits are still here.')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+s');
  expect(await readFile(file, 'utf8')).toBe('# Agent edit\n');
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# My draft\n');
});

test('source-only content stays intact and blocks destructive visual conversion', async () => {
  const markdown = '---\ntitle: Metadata\n---\n\n# Text\n\n<!-- keep this -->\n';
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill(markdown);
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByText('Saved to file', { exact: true })).toBeVisible();
  expect(await readFile(file, 'utf8')).toBe(markdown);
});

test('inserting and editing a table writes Markdown, not HTML', async () => {
  const prose = page.getByRole('textbox', { name: 'Document editor' });
  await prose.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.keyboard.type('Column A');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByText('Saved to file', { exact: true })).toBeVisible();
  const saved = await readFile(file, 'utf8');
  expect(saved).toContain('Column A');
  expect(saved).not.toContain('<table');
});

test('folder navigation shows context, refreshes, and opens Markdown files', async () => {
  await mkdir(path.join(directory, 'notes'));
  await writeFile(path.join(directory, 'notes', 'design.md'), '# Design notes\n\nA second document.\n');
  await writeFile(path.join(directory, 'package.json'), '{}');
  await writeFile(path.join(directory, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await expect(page.getByRole('button', { name: 'package.json', exact: true })).toHaveAttribute('aria-disabled', 'false');
  await expect(page.getByRole('button', { name: 'image.png', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('button', { name: 'notes', exact: true }).click();
  await page.getByRole('button', { name: 'design.md', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Design notes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'design.md', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('tab', { name: 'Outline', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Document outline' })).toContainText('Design notes');
  expect(await readFile(path.join(directory, 'notes', 'design.md'), 'utf8')).toContain('A second document.');
});

test('closing a dirty tab honors canceled unsaved-change confirmation', async () => {
  await writeFile(path.join(directory, 'other.md'), '# Other file\n');
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# Unsaved work\n');
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close sample.md', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Save changes?' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# Unsaved work\n');
  await expect(page.getByRole('button', { name: 'sample.md', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('sidebar has readable labels and resizes without adding a menu border', async () => {
  const sidebar = page.getByLabel('Workspace sidebar', { exact: true });
  const label = page.getByRole('button', { name: 'sample.md', exact: true });
  expect(await label.evaluate(el => getComputedStyle(el).fontSize)).toBe('13px');
  const before = await sidebar.boundingBox();
  const handle = page.getByRole('separator', { name: 'Resize sidebar' });
  const box = await handle.boundingBox();
  if (!box || !before) throw new Error('Sidebar resize handle is missing.');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await sidebar.boundingBox())?.width || 0).toBeGreaterThan(before.width + 80);
  const resizedWidth = (await sidebar.boundingBox())!.width;
  await page.reload();
  await expect(label).toBeVisible();
  await expect.poll(async () => Math.abs(((await sidebar.boundingBox())?.width || 0) - resizedWidth)).toBeLessThan(3);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  expect(await menu.evaluate(el => getComputedStyle(el).borderTopWidth)).toBe('0px');
  expect(await menu.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('none');
});

test('filename search opens a result from an unexpanded folder and clears back to the tree', async () => {
  await mkdir(path.join(directory, 'designs'));
  await writeFile(path.join(directory, 'designs', 'architecture.md'), '# Architecture\n');
  const search = page.getByRole('textbox', { name: 'Find file by name' });
  await search.fill('ARCHI');
  await page.getByRole('button', { name: 'architecture.md designs', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Architecture' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear file search' }).click();
  await expect(search).toHaveValue('');
  await expect(page.getByRole('button', { name: 'architecture.md', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.titlebar')).not.toContainText('architecture.md');
});

test('document zoom uses percentages without enlarging the controls or changing the file', async () => {
  const toolbar = page.locator('.titlebar');
  const before = await toolbar.boundingBox();
  expect((await page.locator('.document-editor').boundingBox())!.width).toBeGreaterThan(720);
  await page.getByRole('button', { name: 'Document zoom' }).click();
  await page.getByRole('menuitemradio', { name: '125%', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Document zoom' })).toHaveText('125%');
  expect(await page.locator('.paper').evaluate(el => getComputedStyle(el).zoom)).toBe('1.25');
  expect((await toolbar.boundingBox())!.height).toBe(before!.height);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(await readFile(file, 'utf8')).toBe(original);
});

test('text styles use a shadcn menu with heading previews and preserve the edit selection', async () => {
  await page.getByRole('heading', { name: 'A real document', exact: true }).click();
  await page.getByRole('button', { name: 'Text style' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitemradio')).toHaveCount(7);
  const firstSize = await menu.getByText('Heading 1', { exact: true }).evaluate(el => getComputedStyle(el).fontSize);
  const secondSize = await menu.getByText('Heading 2', { exact: true }).evaluate(el => getComputedStyle(el).fontSize);
  expect(parseFloat(firstSize)).toBeGreaterThan(parseFloat(secondSize));
  await menu.screenshot({ path: 'tmp/text-style-menu.png' });
  await menu.getByRole('menuitemradio', { name: 'Heading 2', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A real document', level: 2 })).toBeVisible();
  await expect(page.locator('select')).toHaveCount(0);
});

test('all visible form controls use shadcn and enabled control text has strong contrast', async () => {
  const audit = await page.locator('button:visible, input:visible, textarea:visible').evaluateAll(elements => {
    const unstyled = elements.filter(el => !(el as HTMLElement).dataset.slot && !(el as HTMLElement).dataset.sidebar).map(el => el.outerHTML);
    const luminance = (value: string) => {
      const channels = (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number).map(v => {
        const c = v / 255;
        return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
      });
      return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    };
    const lowContrast = elements.filter(el => !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true').flatMap(el => {
      let parent: Element | null = el;
      let background = 'rgb(255, 255, 255)';
      while (parent) {
        const color = getComputedStyle(parent).backgroundColor;
        if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') { background = color; break; }
        parent = parent.parentElement;
      }
      const colors = [luminance(getComputedStyle(el).color), luminance(background)].sort((a, b) => b - a);
      const ratio = (colors[0] + .05) / (colors[1] + .05);
      return ratio < 4.5 ? [{ name: el.getAttribute('aria-label') || el.textContent, ratio }] : [];
    });
    return { unstyled, lowContrast };
  });
  expect(audit).toEqual({ unstyled: [], lowContrast: [] });
  await expect(page.locator('select, [title]')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveAttribute('data-slot', 'textarea');
});

test('task checkboxes use shadcn and preserve Markdown when toggled', async () => {
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('- [ ] Review model\n- [x] Run check\n');
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  const checkbox = page.getByRole('checkbox', { name: 'Complete task: Review model' });
  await expect(checkbox).toHaveAttribute('data-slot', 'checkbox');
  await checkbox.check();
  await expect(checkbox).toBeChecked();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue(/- \[x\] Review model/);
});

test('link and table action controls use the shared components', async () => {
  await page.locator('.document-editor > p').first().click({ clickCount: 3 });
  await page.getByRole('button', { name: 'Add link', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Link URL' });
  await expect(field).toHaveAttribute('data-slot', 'input');
  await field.fill('https://example.com');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('.document-editor a')).toHaveAttribute('href', 'https://example.com');
  await page.locator('.document-editor td').first().click();
  await expect(page.getByRole('button', { name: '+ Row', exact: true })).toHaveAttribute('data-slot', 'button');
  await page.getByRole('button', { name: '+ Row', exact: true }).click();
  await expect(page.locator('.document-editor table tr')).toHaveCount(3);
});

test('discard confirmation uses shadcn and closes only the requested tab', async () => {
  await writeFile(path.join(directory, 'next.md'), '# Next document\n');
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# Unsaved edits\n');
  await page.getByRole('button', { name: 'next.md', exact: true }).click();
  await page.getByRole('button', { name: 'Close sample.md', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save changes?' });
  await expect(dialog).toHaveAttribute('data-slot', 'dialog-content');
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Next document' })).toBeVisible();
  expect(await readFile(file, 'utf8')).toBe(original);
});

test('restart restores the last folder and nested file using its latest disk contents', async () => {
  const nested = path.join(directory, 'notes', 'resume.md');
  await mkdir(path.dirname(nested));
  await writeFile(nested, '# Resume this document\n');
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.getByRole('button', { name: 'notes', exact: true }).click();
  await page.getByRole('button', { name: 'resume.md', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Resume this document' })).toBeVisible();
  const userData = await application.evaluate(({ app }) => app.getPath('userData'));
  const canonicalFile = await realpath(nested);
  await expect.poll(async () => JSON.parse(await readFile(path.join(userData, 'workspace.json'), 'utf8')).file).toBe(canonicalFile);
  await writeFile(nested, '# Updated outside Slate\n');
  await restart();
  await expect(page.getByRole('heading', { name: 'Updated outside Slate' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'resume.md', exact: true })).toHaveAttribute('aria-current', 'page');
  expect((await page.evaluate(() => window.slate!.folderReady()))?.path).toBe(await realpath(directory));
});

test('launching with the same folder still restores its last file', async () => {
  await restart(directory);
  await expect(page.getByRole('heading', { name: 'A real document', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'sample.md', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('an explicit new file or different folder overrides the previous session', async () => {
  const other = path.join(directory, 'other');
  await mkdir(other);
  const chosen = path.join(other, 'chosen.md');
  await writeFile(chosen, '# Explicit file\n');
  await restart(chosen);
  await expect(page.getByRole('heading', { name: 'Explicit file' })).toBeVisible();
  const different = path.join(directory, 'different');
  await mkdir(different);
  await restart(different);
  await expect(page.getByRole('textbox', { name: 'Document editor' })).toBeVisible();
  await expect(page.getByRole('heading')).toHaveCount(0);
  expect((await page.evaluate(() => window.slate!.folderReady()))?.path).toBe(await realpath(different));
});

test('a deleted remembered file leaves the folder usable and shows a clear notice', async () => {
  await unlink(file);
  await restart();
  await expect(page.getByText('The last file is no longer available. Your folder is still open.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Document editor' })).toBeVisible();
  expect((await page.evaluate(() => window.slate!.folderReady()))?.path).toBe(await realpath(directory));
});

test('a deleted remembered folder does not prevent startup', async () => {
  const workspace = path.join(directory, 'removed-workspace');
  await mkdir(workspace);
  await application.evaluate(({ dialog }, folderPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folderPath] });
  }, workspace);
  await page.evaluate(() => window.slate!.openFolder());
  await page.getByRole('button', { name: 'Close sample.md', exact: true }).click();
  await expect(page.getByText('Not saved yet', { exact: true })).toBeVisible();
  await rm(workspace, { recursive: true });
  await restart();
  await expect(page.getByText('The last folder is no longer available. You can open another folder.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Document editor' })).toBeVisible();
  expect(await page.evaluate(() => window.slate!.folderReady())).toBeNull();
});

test('source files open from search, save exactly, and restore on restart', async () => {
  const target = path.join(directory, 'component.tsx');
  const code = 'export const View = () => <div>{`Hello`}</div>;\n';
  await writeFile(target, code);
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  const search = page.getByRole('textbox', { name: 'Find file by name' });
  await search.fill('component');
  await page.getByRole('button', { name: /component.tsx/ }).click();
  const source = page.getByRole('textbox', { name: 'Source editor', exact: true });
  await expect(source).toHaveValue(code);
  await expect(page.getByRole('tab', { name: 'Visual', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Source', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.keyboard.press('ControlOrMeta+Shift+m');
  await expect(source).toBeVisible();
  const updated = '// # Not a Markdown heading\n' + code + '\t// keep indentation  \n';
  await source.fill(updated);
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readFile(target, 'utf8')).toBe(updated);
  await expect(page.getByText('Saved to file', { exact: true })).toBeVisible();
  await restart();
  await expect(page.getByRole('textbox', { name: 'Source editor', exact: true })).toHaveValue(updated);
  await expect(page.getByRole('button', { name: 'component.tsx', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'sample.md', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A real document', exact: true })).toBeVisible();
});

test('native Open loads JSON, HTML, SVG, and extensionless files as source without executing them', async () => {
  const samples = [
    ['settings.json', '{  "enabled" : true, "paths" : ["a", "b"] }\n'],
    ['page.html', '<script>window.slateExecuted = true</script><h1>Untrusted HTML</h1>\n'],
    ['image.svg', '<svg xmlns="http://www.w3.org/2000/svg" onload="window.slateExecuted = true"></svg>\n'],
    ['Dockerfile', 'FROM node:24\nRUN echo "# literal text"\n'],
  ];
  for (const [name, content] of samples) {
    const target = path.join(directory, name);
    await writeFile(target, content);
    await application.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, target);
    await page.evaluate(() => window.slate!.open());
    await expect(page.getByRole('textbox', { name: 'Source editor', exact: true })).toHaveValue(content);
    await expect(page.getByRole('tab', { name: 'Visual', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(window, 'slateExecuted'))).toBeUndefined();
    expect(await readFile(target, 'utf8')).toBe(content);
  }
});

test('code files retain external-change protection and reject binary masquerading as text', async () => {
  const target = path.join(directory, 'script.py');
  await writeFile(target, 'print("hello")\n');
  await restart(target);
  const source = page.getByRole('textbox', { name: 'Source editor', exact: true });
  await source.fill('print("my edits")\n');
  await writeFile(target, 'print("external edit")\n');
  await expect(page.getByText('This file changed outside Slate. Your edits are still here.')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+s');
  expect(await readFile(target, 'utf8')).toBe('print("external edit")\n');
  await expect(source).toHaveValue('print("my edits")\n');
  await page.getByRole('button', { name: 'Reload file', exact: true }).click();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(source).toHaveValue('print("external edit")\n');
  const binary = path.join(directory, 'binary.txt');
  await writeFile(binary, 'text\0binary');
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.getByRole('button', { name: 'binary.txt', exact: true }).click();
  await expect(page.getByText('This file contains binary data and cannot be edited as text.')).toBeVisible();
  await expect(source).toHaveValue('print("external edit")\n');
});

test('Save in the unsaved-changes dialog writes the current file before closing its tab', async () => {
  await writeFile(path.join(directory, 'next.md'), '# Next document\n');
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# Saved before switching\n');
  await page.getByRole('button', { name: 'next.md', exact: true }).click();
  await page.getByRole('button', { name: 'Close sample.md', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save changes?' });
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByRole('heading', { name: 'Next document' })).toBeVisible();
  expect(await readFile(file, 'utf8')).toBe('# Saved before switching\n');
  expect(await page.evaluate(() => localStorage.getItem('slate-unsaved-drafts-v2'))).toBeNull();
});

test('canceled and failed Save As keep the pending switch and unsaved text intact', async () => {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# New draft to keep\n');
  await application.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined });
  });
  await page.getByRole('button', { name: 'Close Untitled.md', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save changes?' });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(page.locator('.source-editor textarea')).toHaveValue('# New draft to keep\n');
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, path.join(directory, 'missing-directory', 'new.md'));
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Your changes are still unsaved');
  await expect(dialog).toBeVisible();
  const target = path.join(directory, 'new.md');
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, target);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A real document', exact: true })).toBeVisible();
  expect(await readFile(target, 'utf8')).toBe('# New draft to keep\n');
  expect(await readFile(file, 'utf8')).toBe(original);
});

test('external changes block Save in the confirmation dialog without discarding the draft', async () => {
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown source' });
  await source.fill('# Keep my draft\n');
  await writeFile(file, '# External version\n');
  await page.getByRole('button', { name: 'Close sample.md', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save changes?' });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('This file changed outside Slate');
  expect(await readFile(file, 'utf8')).toBe('# External version\n');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(source).toHaveValue('# Keep my draft\n');
});

test('closing the window supports Cancel and Discard and clears discarded recovery', async () => {
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# Discard this\n');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('slate-unsaved-drafts-v2'))).not.toBeNull();
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  const dialog = page.getByRole('dialog', { name: 'Save changes?' });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# Discard this\n');
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  await Promise.all([page.waitForEvent('close'), dialog.getByRole('button', { name: 'Discard', exact: true }).click()]);
  expect(await readFile(file, 'utf8')).toBe(original);
  await restart();
  await expect(page.getByRole('heading', { name: 'A real document', exact: true })).toBeVisible();
  await expect(page.getByText('An unsaved draft is available:', { exact: false })).toHaveCount(0);
});

test('quitting supports Cancel then Save and actually exits after saving', async () => {
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# Saved before quitting\n');
  await application.evaluate(({ app }) => { app.quit(); });
  const dialog = page.getByRole('dialog', { name: 'Save changes?' });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await readFile(file, 'utf8')).toBe(original);
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# Saved before quitting\n');
  await application.evaluate(({ app }) => { app.quit(); });
  await Promise.all([application.waitForEvent('close'), dialog.getByRole('button', { name: 'Save', exact: true }).click()]);
  expect(await readFile(file, 'utf8')).toBe('# Saved before quitting\n');
});

test('quitting with Discard leaves the file unchanged and removes its recovery draft', async () => {
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# Not for disk\n');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('slate-unsaved-drafts-v2'))).not.toBeNull();
  await application.evaluate(({ app }) => { app.quit(); });
  const dialog = page.getByRole('dialog', { name: 'Save changes?' });
  await Promise.all([application.waitForEvent('close'), dialog.getByRole('button', { name: 'Discard', exact: true }).click()]);
  expect(await readFile(file, 'utf8')).toBe(original);
  await launch();
  await expect(page.getByRole('heading', { name: 'A real document', exact: true })).toBeVisible();
  await expect(page.getByText('An unsaved draft is available:', { exact: false })).toHaveCount(0);
});

test('draft recovery survives a forced exit without changing the original file', async () => {
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# Recovered draft\n');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('slate-unsaved-drafts-v2'))).not.toBeNull();
  await application.evaluate(({ session }) => { session.defaultSession.flushStorageData(); });
  const exited = application.waitForEvent('close');
  await application.evaluate(({ app }) => { setTimeout(() => app.exit(0), 50); });
  await exited;
  expect(await readFile(file, 'utf8')).toBe(original);
  await launch();
  await expect(page.getByText('An unsaved draft is available: sample.md', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Recover as new document', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recovered draft', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  expect(await readFile(file, 'utf8')).toBe(original);
});

test('closing an untitled document waits for Save As before closing the window', async () => {
  const target = path.join(directory, 'saved-on-close.md');
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, target);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# Saved on close\n');
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  const dialog = page.getByRole('dialog', { name: 'Save changes?' });
  await Promise.all([page.waitForEvent('close'), dialog.getByRole('button', { name: 'Save', exact: true }).click()]);
  expect(await readFile(target, 'utf8')).toBe('# Saved on close\n');
});

test('tabs preserve independent drafts, show blue dots, and save only the active file', async () => {
  const second = path.join(directory, 'second.ts');
  await writeFile(second, 'const original = 1;\n');
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# First draft\n');
  await page.getByRole('button', { name: 'second.ts', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Source editor', exact: true }).fill('const draft = 2;\n');
  const firstTab = page.getByRole('tab', { name: 'sample.md, unsaved changes', exact: true });
  const secondTab = page.getByRole('tab', { name: 'second.ts, unsaved changes', exact: true });
  await expect(firstTab.locator('.unsaved-dot')).toHaveCSS('background-color', 'rgb(37, 99, 235)');
  await expect(secondTab.locator('.unsaved-dot')).toBeVisible();
  await firstTab.click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# First draft\n');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readFile(file, 'utf8')).toBe('# First draft\n');
  expect(await readFile(second, 'utf8')).toBe('const original = 1;\n');
  await expect(page.getByRole('tab', { name: 'sample.md', exact: true })).toBeVisible();
  await expect(secondTab).toBeVisible();
  await secondTab.click();
  await expect(page.getByRole('textbox', { name: 'Source editor', exact: true })).toHaveValue('const draft = 2;\n');
  await page.getByRole('button', { name: 'sample.md', exact: true }).click();
  await expect(page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab')).toHaveCount(2);
  await page.screenshot({ path: 'tmp/slate-tabs.png' });
});

test('tab menu closes others, honors Cancel, and closes all with explicit discard', async () => {
  const second = path.join(directory, 'second.md');
  await writeFile(second, '# Second\n');
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# First dirty\n');
  await page.getByRole('button', { name: 'second.md', exact: true }).click();
  const tab = page.getByRole('tab', { name: 'second.md', exact: true });
  await tab.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close Others', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save changes?' });
  await expect(dialog).toContainText('sample.md');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab')).toHaveCount(2);
  await tab.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close Others', exact: true }).click();
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab')).toHaveCount(1);
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# Second dirty\n');
  await page.getByRole('tab', { name: 'second.md, unsaved changes', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close All', exact: true }).click();
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab')).toHaveCount(1);
  await expect(page.getByText('Not saved yet', { exact: true })).toBeVisible();
  expect(await readFile(file, 'utf8')).toBe(original);
  expect(await readFile(second, 'utf8')).toBe('# Second\n');
});

test('dragging tabs changes their order and restores that order on restart', async () => {
  for (const name of ['second.md', 'third.md']) await writeFile(path.join(directory, name), `# ${name}\n`);
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  for (const name of ['second.md', 'third.md']) await page.getByRole('button', { name, exact: true }).click();
  const tablist = page.getByRole('tablist', { name: 'Open documents' });
  await tablist.getByRole('tab', { name: 'third.md', exact: true }).dragTo(tablist.getByRole('tab', { name: 'sample.md', exact: true }), { targetPosition: { x: 3, y: 10 } });
  await expect(tablist.getByRole('tab')).toHaveText(['third.md', 'sample.md', 'second.md']);
  await expect(tablist.getByRole('tab', { name: 'third.md', exact: true })).toHaveAttribute('aria-selected', 'true');
  await restart();
  await expect(page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab')).toHaveText(['third.md', 'sample.md', 'second.md']);
  await expect(page.getByRole('tab', { name: 'third.md', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('quitting prompts for each dirty tab, saves one, and preserves another on Cancel', async () => {
  await writeFile(path.join(directory, 'second.md'), '# Second\n');
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# Save first\n');
  await page.getByRole('button', { name: 'second.md', exact: true }).click();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# Keep second\n');
  await application.evaluate(({ app }) => { app.quit(); });
  const dialog = page.getByRole('dialog', { name: 'Save changes?' });
  await expect(dialog).toContainText('sample.md');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toContainText('second.md');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await readFile(file, 'utf8')).toBe('# Save first\n');
  expect(await readFile(path.join(directory, 'second.md'), 'utf8')).toBe('# Second\n');
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# Keep second\n');
  await expect(page.getByRole('tab', { name: 'second.md, unsaved changes', exact: true })).toBeVisible();
});

test('visual undo history and raw cursor positions remain local to their tabs', async () => {
  await writeFile(path.join(directory, 'second.md'), '# Second\n');
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.locator('.document-editor p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('Unique edit');
  await expect(page.getByRole('textbox', { name: 'Document editor' })).toContainText('Unique edit');
  await expect(page.getByRole('tab', { name: 'sample.md, unsaved changes', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'second.md', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Second', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'sample.md, unsaved changes', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Document editor' })).toContainText('Unique edit');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Document editor' })).not.toContainText('Unique edit');
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown source' });
  await source.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(5, 9));
  await page.getByRole('tab', { name: 'second.md', exact: true }).click();
  await page.getByRole('tab', { name: /^sample.md/ }).click();
  await expect.poll(() => source.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([5, 9]);
});

test('inactive tabs retain external-change detection and prevent overwriting the external file', async () => {
  await writeFile(path.join(directory, 'second.md'), '# Second\n');
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# First draft\n');
  await page.getByRole('button', { name: 'second.md', exact: true }).click();
  await writeFile(file, '# External update\n');
  await page.getByRole('tab', { name: 'sample.md, unsaved changes', exact: true }).click();
  await expect(page.getByText('This file changed outside Slate. Your edits are still here.')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# First draft\n');
  expect(await readFile(file, 'utf8')).toBe('# External update\n');
});

test('recovery retains every dirty tab across a crash without writing either original', async () => {
  const second = path.join(directory, 'second.ts');
  await writeFile(second, 'const original = 1;\n');
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# First recovered\n');
  await page.getByRole('button', { name: 'second.ts', exact: true }).click();
  await page.getByRole('textbox', { name: 'Source editor', exact: true }).fill('const recovered = 2;\n');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('slate-unsaved-drafts-v2') || '[]').length)).toBe(2);
  await application.evaluate(({ session }) => { session.defaultSession.flushStorageData(); });
  const exited = application.waitForEvent('close');
  await application.evaluate(({ app }) => { setTimeout(() => app.exit(0), 50); });
  await exited;
  await launch();
  await expect(page.getByText(/An unsaved draft is available:.*2 drafts/)).toBeVisible();
  await page.getByRole('button', { name: 'Recover as new document', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'First recovered', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Recover as new document', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Source editor', exact: true })).toHaveValue('const recovered = 2;\n');
  await expect(page.getByRole('tablist', { name: 'Open documents' }).locator('.unsaved-dot')).toHaveCount(2);
  expect(await readFile(file, 'utf8')).toBe(original);
  expect(await readFile(second, 'utf8')).toBe('const original = 1;\n');
});

test('an existing single-document recovery draft still opens as an unsaved tab', async () => {
  await page.evaluate(() => {
    localStorage.removeItem('slate-unsaved-drafts-v2');
    localStorage.setItem('slate-unsaved-draft-v1', JSON.stringify({ name: 'old.md', path: null, content: '# Legacy draft\n' }));
  });
  await page.reload();
  await page.getByRole('button', { name: 'Recover as new document', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Legacy draft', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'old.md, unsaved changes', exact: true })).toBeVisible();
  expect(await readFile(file, 'utf8')).toBe(original);
});

test('code highlighting is readable, stays aligned while scrolling and zooming, and saves exact source', async () => {
  const target = path.join(directory, 'highlight.ts');
  const code = '// A readable comment\nexport function greet(name: string): string {\n\tconst message = "Hello, " + name;\n\treturn message;\n}\nconst longLine = "' + 'wide text '.repeat(60) + '";\n';
  await writeFile(target, code);
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.getByRole('button', { name: 'highlight.ts', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Source editor', exact: true });
  const preview = page.locator('.syntax-highlight');
  await expect(preview.locator('.hljs-keyword').first()).toBeVisible();
  await expect(preview.locator('.hljs-comment')).toHaveText('// A readable comment');
  expect(await preview.textContent()).toBe(code);
  await expect(input).toHaveCSS('caret-color', 'rgb(24, 24, 24)');
  await expect(input).toHaveAttribute('data-slot', 'textarea');
  const contrasts = await preview.locator('span').evaluateAll(elements => elements.map(element => {
    const rgb = getComputedStyle(element).color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 1.05 / (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] + 0.05);
  }));
  expect(Math.min(...contrasts)).toBeGreaterThanOrEqual(4.5);
  await input.evaluate((element: HTMLTextAreaElement) => { element.scrollLeft = 200; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
  await expect(preview).toHaveCSS('transform', 'matrix(1, 0, 0, 1, -200, 0)');
  await page.getByRole('button', { name: 'Document zoom', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '125%', exact: true }).click();
  const metrics = await page.locator('.source-input').evaluate(element => {
    const input = element.querySelector('textarea')!;
    const preview = element.querySelector('pre')!;
    return { inputFont: getComputedStyle(input).font, previewFont: getComputedStyle(preview).font,
      inputY: input.getBoundingClientRect().y, previewY: preview.getBoundingClientRect().y };
  });
  expect(metrics.inputFont).toBe(metrics.previewFont);
  expect(metrics.inputY).toBe(metrics.previewY);
  await input.fill(code + '// <script> stays literal & unchanged\n');
  await expect(preview.locator('.hljs-comment').last()).toHaveText('// <script> stays literal & unchanged');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readFile(target, 'utf8')).toBe(code + '// <script> stays literal & unchanged\n');
  await page.screenshot({ path: 'tmp/slate-syntax-highlighting.png' });
});

test('highlighting follows the file type and never executes markup', async () => {
  const samples = [
    ['data.json', '{ "enabled": true, "count": 42 }\n', '.hljs-attr'],
    ['settings.yaml', 'enabled: true\nname: "Slate"\n', '.hljs-attr'],
    ['query.sql', 'SELECT name FROM users WHERE active = 1;\n', '.hljs-keyword'],
    ['script.py', 'def greet(name):\n    return "hello " + name\n', '.hljs-keyword'],
    ['Dockerfile', 'FROM node:24\nRUN echo hello\n', '.hljs-keyword'],
    ['page.html', '<script>window.highlightExecuted = true</script>\n<img src=x onerror="window.highlightExecuted=true">\n', '.hljs-tag'],
  ];
  for (const [name, content] of samples) await writeFile(path.join(directory, name), content);
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  for (const [name, content, selector] of samples) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Source editor', exact: true })).toHaveValue(content);
    await expect(page.locator(`.syntax-highlight ${selector}`).first()).toBeVisible();
    await expect(page.locator('.syntax-highlight')).toHaveText(content);
    expect(await page.evaluate(() => Reflect.get(window, 'highlightExecuted'))).toBeUndefined();
    expect(await readFile(path.join(directory, name), 'utf8')).toBe(content);
  }
});

test('plain text and large code files remain readable without a highlighting overlay', async () => {
  for (const [name, content] of [['notes.txt', 'const plain = "still plain text";\n'], ['large.ts', '// ' + 'x'.repeat(200_001)]]) {
    await writeFile(path.join(directory, name), content);
    await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
    await page.getByRole('button', { name, exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Source editor', exact: true });
    await expect(input).toHaveValue(content);
    await expect(input).toHaveCSS('color', 'rgb(24, 24, 24)');
    await expect(page.locator('.syntax-highlight')).toHaveCount(0);
  }
});

test('sidebar rename keeps an open draft and updates its tab and filename search', async () => {
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown source' });
  await source.fill('# Draft after rename\n');
  await page.getByRole('button', { name: 'sample.md', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename', exact: true });
  await dialog.getByRole('textbox', { name: 'New name', exact: true }).fill('guide.md');
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'guide.md, unsaved changes', exact: true })).toBeVisible();
  await expect(source).toHaveValue('# Draft after rename\n');
  await expect.poll(() => readFile(path.join(directory, 'guide.md'), 'utf8')).toBe(original);
  await expect(readFile(file, 'utf8')).rejects.toThrow();
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readFile(path.join(directory, 'guide.md'), 'utf8')).toBe('# Draft after rename\n');
  await page.getByRole('textbox', { name: 'Find file by name', exact: true }).fill('guide');
  await expect(page.getByRole('button', { name: /guide.md/ })).toBeVisible();
});

test('sidebar move uses the folder picker and keeps edits associated with the moved file', async () => {
  const destination = path.join(directory, 'archive');
  await mkdir(destination);
  await application.evaluate(({ dialog }, folderPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folderPath] });
  }, destination);
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# Moved draft\n');
  await page.getByRole('button', { name: 'sample.md', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move…', exact: true }).click();
  const target = path.join(destination, 'sample.md');
  await expect.poll(() => readFile(target, 'utf8').catch(() => null)).toBe(original);
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# Moved draft\n');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readFile(target, 'utf8')).toBe('# Moved draft\n');
  await expect(readFile(file, 'utf8')).rejects.toThrow();
  await expect(page.getByRole('button', { name: 'sample.md', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('sidebar rename refuses to replace an existing file', async () => {
  await writeFile(path.join(directory, 'existing.md'), '# Keep this\n');
  await page.getByRole('button', { name: 'sample.md', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename', exact: true });
  await dialog.getByRole('textbox', { name: 'New name', exact: true }).fill('existing.md');
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('already exists');
  expect(await readFile(file, 'utf8')).toBe(original);
  expect(await readFile(path.join(directory, 'existing.md'), 'utf8')).toBe('# Keep this\n');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('renaming a folder updates both active and inactive open drafts', async () => {
  const notes = path.join(directory, 'notes');
  await mkdir(notes);
  await writeFile(path.join(notes, 'first.md'), '# First\n');
  await writeFile(path.join(notes, 'second.ts'), 'const second = 1;\n');
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.getByRole('button', { name: 'notes', exact: true }).click();
  await page.getByRole('button', { name: 'first.md', exact: true }).click();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# First draft\n');
  await page.getByRole('button', { name: 'second.ts', exact: true }).click();
  await page.getByRole('textbox', { name: 'Source editor', exact: true }).fill('const second = 2;\n');
  await page.getByRole('button', { name: 'notes', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename', exact: true });
  await dialog.getByRole('textbox', { name: 'New name', exact: true }).fill('renamed-notes');
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByRole('button', { name: 'renamed-notes', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Source editor', exact: true })).toHaveValue('const second = 2;\n');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readFile(path.join(directory, 'renamed-notes', 'second.ts'), 'utf8')).toBe('const second = 2;\n');
  await page.getByRole('tab', { name: 'first.md, unsaved changes', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# First draft\n');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readFile(path.join(directory, 'renamed-notes', 'first.md'), 'utf8')).toBe('# First draft\n');
});

test('sidebar Delete confirms Trash and preserves a dirty file when canceled', async () => {
  const trashed = path.join(directory, 'trashed-original.md');
  await application.evaluate(({ shell }, target) => {
    shell.trashItem = async source => { await process.getBuiltinModule('fs/promises').rename(source, target); };
  }, trashed);
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# Unsaved before delete\n');
  async function requestTrash() {
    await page.getByRole('button', { name: 'sample.md', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
    await page.getByRole('dialog', { name: 'Move to Trash?', exact: true }).getByRole('button', { name: 'Move to Trash', exact: true }).click();
  }
  await requestTrash();
  await page.getByRole('dialog', { name: 'Save changes?' }).getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await readFile(file, 'utf8')).toBe(original);
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# Unsaved before delete\n');
  await requestTrash();
  await page.getByRole('dialog', { name: 'Save changes?' }).getByRole('button', { name: 'Discard', exact: true }).click();
  await expect.poll(() => readFile(trashed, 'utf8').catch(() => null)).toBe(original);
  await expect(page.getByRole('tab', { name: /^sample.md/ })).toHaveCount(0);
  await expect(readFile(file, 'utf8')).rejects.toThrow();
});

test('deleting an original file keeps a copy saved during the unsaved-changes prompt open', async () => {
  const copy = path.join(directory, 'kept-copy.md');
  const trashed = path.join(directory, 'trashed-file.md');
  await application.evaluate(({ shell, dialog }, paths) => {
    shell.trashItem = async source => { await process.getBuiltinModule('fs/promises').rename(source, paths.trashed); };
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.copy });
  }, { copy, trashed });
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# Keep this copy\n');
  await page.getByRole('button', { name: 'sample.md', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Move to Trash?', exact: true });
  await expect(confirmation).toContainText('sample.md');
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await readFile(file, 'utf8')).toBe(original);
  await page.getByRole('button', { name: 'sample.md', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Move to Trash', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Save changes?' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+s');
  await expect(page.getByRole('tab', { name: 'kept-copy.md', exact: true })).toBeVisible();
  await expect.poll(() => readFile(copy, 'utf8')).toBe('# Keep this copy\n');
  await expect.poll(() => readFile(trashed, 'utf8').catch(() => null)).toBe(original);
  await expect(page.getByRole('tab', { name: 'kept-copy.md', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('renaming a Markdown file to a code extension keeps its unsaved source editable', async () => {
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('const value = "Keep this";\n');
  await page.getByRole('button', { name: 'sample.md', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename', exact: true });
  await dialog.getByRole('textbox', { name: 'New name', exact: true }).fill('sample.ts');
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Source editor', exact: true })).toHaveValue('const value = "Keep this";\n');
  await expect(page.locator('.syntax-highlight .hljs-keyword')).toHaveText('const');
  await expect(page.getByRole('tab', { name: 'sample.ts, unsaved changes', exact: true })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readFile(path.join(directory, 'sample.ts'), 'utf8')).toBe('const value = "Keep this";\n');
});

test('sidebar creates a file at the workspace root and opens it without disturbing another draft', async () => {
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# Keep my existing draft\n');
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New File', exact: true });
  await dialog.getByRole('textbox', { name: 'File name', exact: true }).fill('created.ts');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'created.ts', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('textbox', { name: 'Source editor', exact: true })).toHaveValue('');
  expect(await readFile(path.join(directory, 'created.ts'), 'utf8')).toBe('');
  await page.getByRole('textbox', { name: 'Source editor', exact: true }).fill('const created = true;\n');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readFile(path.join(directory, 'created.ts'), 'utf8')).toBe('const created = true;\n');
  await page.getByRole('tab', { name: 'sample.md, unsaved changes', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# Keep my existing draft\n');
  expect(await readFile(file, 'utf8')).toBe(original);
});

test('sidebar creates a folder then creates a file inside it through the context menu', async () => {
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  const folderDialog = page.getByRole('dialog', { name: 'New Folder', exact: true });
  await folderDialog.getByRole('textbox', { name: 'Folder name', exact: true }).fill('drafts');
  await folderDialog.getByRole('button', { name: 'Create', exact: true }).click();
  const folder = page.getByRole('button', { name: 'drafts', exact: true });
  await expect(folder).toBeVisible();
  await folder.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New Folder…', exact: true }).click();
  await folderDialog.getByRole('textbox', { name: 'Folder name', exact: true }).fill('nested');
  await folderDialog.getByRole('button', { name: 'Create', exact: true }).click();
  const nested = page.getByRole('button', { name: 'nested', exact: true });
  await expect(nested).toBeVisible();
  await nested.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New File…', exact: true }).click();
  const fileDialog = page.getByRole('dialog', { name: 'New File', exact: true });
  await fileDialog.getByRole('textbox', { name: 'File name', exact: true }).fill('notes.md');
  await fileDialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'notes.md', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'notes.md', exact: true })).toHaveAttribute('aria-current', 'page');
  expect(await readFile(path.join(directory, 'drafts', 'nested', 'notes.md'), 'utf8')).toBe('');
});

test('sidebar creation refuses an existing name and Cancel creates nothing', async () => {
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New File', exact: true });
  await dialog.getByRole('textbox', { name: 'File name', exact: true }).fill('sample.md');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('already exists');
  expect(await readFile(file, 'utf8')).toBe(original);
  await dialog.getByRole('textbox', { name: 'File name', exact: true }).fill('canceled.md');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(readFile(path.join(directory, 'canceled.md'), 'utf8')).rejects.toThrow();
  await expect(page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab')).toHaveCount(1);
});

test('dragging a file into a folder and back to the root preserves its open draft', async () => {
  const archive = path.join(directory, 'archive');
  await mkdir(archive);
  await application.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => { throw new Error('Drag moves must not open a picker'); }; });
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# Dragged draft\n');
  await page.getByRole('button', { name: 'sample.md', exact: true }).dragTo(page.getByRole('button', { name: 'archive', exact: true }));
  await expect.poll(() => readFile(path.join(archive, 'sample.md'), 'utf8').catch(() => null)).toBe(original);
  await expect(page.getByRole('tab', { name: 'sample.md, unsaved changes', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# Dragged draft\n');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readFile(path.join(archive, 'sample.md'), 'utf8')).toBe('# Dragged draft\n');
  await page.getByRole('button', { name: 'sample.md', exact: true }).dragTo(page.getByLabel('Workspace folder', { exact: true }));
  await expect.poll(() => readFile(file, 'utf8').catch(() => null)).toBe('# Dragged draft\n');
  await expect(readFile(path.join(archive, 'sample.md'), 'utf8')).rejects.toThrow();
  await expect(page.getByRole('button', { name: 'sample.md', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('dragging a folder moves all children and keeps both open tabs associated with their files', async () => {
  const notes = path.join(directory, 'notes');
  const archive = path.join(directory, 'archive');
  await mkdir(notes); await mkdir(archive);
  await writeFile(path.join(notes, 'one.md'), '# One\n');
  await writeFile(path.join(notes, 'two.ts'), 'const value = 1;\n');
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.getByRole('button', { name: 'notes', exact: true }).click();
  await page.getByRole('button', { name: 'one.md', exact: true }).click();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# One draft\n');
  await page.getByRole('button', { name: 'two.ts', exact: true }).click();
  await page.getByRole('textbox', { name: 'Source editor', exact: true }).fill('const value = 2;\n');
  await page.getByRole('button', { name: 'notes', exact: true }).dragTo(page.getByRole('button', { name: 'archive', exact: true }));
  await expect.poll(() => readFile(path.join(archive, 'notes', 'two.ts'), 'utf8').catch(() => null)).toBe('const value = 1;\n');
  await expect(page.getByRole('textbox', { name: 'Source editor', exact: true })).toHaveValue('const value = 2;\n');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readFile(path.join(archive, 'notes', 'two.ts'), 'utf8')).toBe('const value = 2;\n');
  await page.getByRole('tab', { name: 'one.md, unsaved changes', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# One draft\n');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readFile(path.join(archive, 'notes', 'one.md'), 'utf8')).toBe('# One draft\n');
  await expect(readFile(path.join(notes, 'one.md'), 'utf8')).rejects.toThrow();
});

test('drag moves refuse filename collisions and moving a folder into its own descendant', async () => {
  const notes = path.join(directory, 'notes');
  await mkdir(notes); await mkdir(path.join(notes, 'child'));
  await writeFile(path.join(notes, 'sample.md'), '# Keep destination\n');
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.getByRole('button', { name: 'sample.md', exact: true }).dragTo(page.getByRole('button', { name: 'notes', exact: true }));
  await expect(page.getByText('A file or folder with that name already exists. Nothing was replaced.', { exact: true })).toBeVisible();
  expect(await readFile(file, 'utf8')).toBe(original);
  expect(await readFile(path.join(notes, 'sample.md'), 'utf8')).toBe('# Keep destination\n');
  if (!(await page.getByRole('button', { name: 'child', exact: true }).isVisible())) await page.getByRole('button', { name: 'notes', exact: true }).click();
  await page.getByRole('button', { name: 'notes', exact: true }).dragTo(page.getByRole('button', { name: 'child', exact: true }));
  expect(await readFile(path.join(notes, 'sample.md'), 'utf8')).toBe('# Keep destination\n');
  await expect(readFile(path.join(notes, 'child', 'notes', 'sample.md'), 'utf8')).rejects.toThrow();
});

test('hovering a drop target expands it so a file can be dropped into a nested folder', async () => {
  await mkdir(path.join(directory, 'archive'));
  await mkdir(path.join(directory, 'archive', 'nested'));
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await expect(page.getByRole('button', { name: 'nested', exact: true })).toHaveCount(0);
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  const source = page.getByRole('button', { name: 'sample.md', exact: true });
  const archive = page.getByRole('button', { name: 'archive', exact: true });
  await source.dispatchEvent('dragstart', { dataTransfer: transfer });
  await archive.dispatchEvent('dragover', { dataTransfer: transfer });
  await expect(archive).toHaveAttribute('data-drop-target', 'true');
  const nested = page.getByRole('button', { name: 'nested', exact: true });
  await expect(nested).toBeVisible();
  await nested.dispatchEvent('dragover', { dataTransfer: transfer });
  await nested.dispatchEvent('drop', { dataTransfer: transfer });
  await expect.poll(() => readFile(path.join(directory, 'archive', 'nested', 'sample.md'), 'utf8').catch(() => null)).toBe(original);
  await expect(page.getByRole('button', { name: 'sample.md', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('desktop branding uses Slate in the app name and macOS menu', async () => {
  const branding = await application.evaluate(({ app, Menu }) => ({
    name: app.getName(),
    menu: Menu.getApplicationMenu()?.items[0].label,
    labels: Menu.getApplicationMenu()?.items[0].submenu?.items.map(item => item.label),
  }));
  expect(branding.name).toBe('Slate');
  if (process.platform === 'darwin') {
    expect(branding.menu).toBe('Slate');
    expect(branding.labels).toContain('About Slate');
    expect(branding.labels).toContain('Quit Slate');
    expect(branding.labels?.some(label => label.includes('Electron'))).toBe(false);
  }
});

test('startup shows a brief Slate screen and then reopens the workspace', async () => {
  const workspace = await page.evaluate(() => window.slate!.ready());
  await application.evaluate(({ ipcMain }, restored) => {
    ipcMain.removeHandler('document:ready');
    ipcMain.handle('document:ready', async () => {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return restored;
    });
  }, workspace);
  await page.reload();
  const startup = page.getByRole('status', { name: 'Starting Slate', exact: true });
  await expect(startup).toBeVisible();
  await expect(startup).toContainText('Slate');
  await expect(startup).toContainText('Opening your workspace');
  await page.screenshot({ path: 'tmp/slate-startup.png' });
  await expect(page.getByRole('heading', { name: 'A real document', exact: true })).toBeVisible();
  await expect(startup).toHaveCount(0);
  expect(await readFile(file, 'utf8')).toBe(original);
});
