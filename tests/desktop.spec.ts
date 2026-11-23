import { test, expect, _electron as electron, type ElectronApplication, type Page, type Locator } from '@playwright/test';
import { mkdir, mkdtemp, realpath, writeFile, readFile, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createControlFile, readControlFile, writeControlFile } from '../src/lib/control-structure/file';

function controlDocument(source: string, format: 'yaml' | 'json' = 'yaml') {
  const file = readControlFile(`test.${format}`, createControlFile('Test control structure', format));
  return writeControlFile(file, source);
}

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
  await application.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
  page = await application.firstWindow();
  page.on('pageerror', error => rendererErrors.push(error.message));
  await application.evaluate(({ BrowserWindow }, ci) => {
    for (const window of BrowserWindow.getAllWindows()) {
      // Set a starting window size; layout tests also set the browser viewport explicitly.
      window.setContentSize(1120, 800);
      window.webContents.setBackgroundThrottling(false);
      // CI exercises a normal foreground window, including native input and focus.
      // Only local runs suppress focus to avoid taking the user's keyboard input.
      if (ci) {
        window.show();
        window.focus();
      } else {
        window.hide();
        window.show = () => {};
        window.focus = () => {};
      }
    }
  }, Boolean(process.env.CI));
  // Every desktop test exercises the async workspace boundary, including after restarts.
  await delayWorkspaceWrites();
}

async function restart(target?: string) {
  if (!applicationClosed) await application.close();
  await launch(target);
}

async function delayWorkspaceWrites() {
  await application.evaluate(() => {
    const fs = process.getBuiltinModule('fs/promises');
    const rename = fs.rename;
    fs.rename = async (...args) => {
      if (String(args[1]).endsWith('workspace.json')) await new Promise(resolve => setTimeout(resolve, 400));
      return rename(...args);
    };
  });
}

async function delayDocumentWrite(filePath: string) {
  // Exercise the gap between disabling Save and replacing the file on disk.
  await application.evaluate((_, target) => {
    const fs = process.getBuiltinModule('fs/promises');
    const rename = fs.rename;
    fs.rename = async (...args) => {
      if (args[1] === target) await new Promise(resolve => setTimeout(resolve, 400));
      return rename(...args);
    };
  }, await realpath(filePath));
}

async function openSidebarFile(name: string) {
  await page.getByRole('button', { name, exact: true }).click();
  const tab = page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab')
    .filter({ has: page.getByText(name, { exact: true }) });
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

async function openNewWindow() {
  const opened = application.waitForEvent('window');
  await application.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('new-window')!.click());
  const next = await opened;
  next.on('pageerror', error => rendererErrors.push(error.message));
  const native = await application.browserWindow(next);
  await native.evaluate(window => {
    window.setContentSize(1120, 800);
    window.webContents.setBackgroundThrottling(false);
    window.hide(); window.show = () => {}; window.focus = () => {};
  });
  await expect(next.getByRole('textbox', { name: 'Document editor', exact: true })).toBeVisible();
  return next;
}

async function openFolderIn(window: Page, folder: string) {
  await application.evaluate(({ dialog }, folderPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folderPath] });
  }, folder);
  await window.evaluate(() => window.slate!.openFolder());
}

async function dropNativeFiles(target: Locator, files: string[]) {
  const bounds = (await target.boundingBox())!;
  const session = await page.context().newCDPSession(page);
  const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const data = { items: [], files, dragOperationsMask: 1 };
  try {
    await session.send('Input.dispatchDragEvent', { type: 'dragEnter', ...point, data });
    await session.send('Input.dispatchDragEvent', { type: 'dragOver', ...point, data });
    await expect(target).toHaveAttribute('data-drop-target', 'true');
    await session.send('Input.dispatchDragEvent', { type: 'drop', ...point, data });
  } finally { await session.detach(); }
}

async function expectActiveFileInFolder(name: string, folder: string) {
  const tree = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: folder, exact: true }) });
  await expect(tree.getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'page');
}

async function saveWithShortcut(filePath: string, content: string) {
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readFile(filePath, 'utf8')).toBe(content);
  // The file can be written before the save reply and workspace write have finished.
  await expect(page.getByRole('tablist', { name: 'Open documents' })
    .getByRole('tab', { selected: true }).locator('.unsaved-dot')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
}

test.beforeEach(async () => {
  rendererErrors = [];
  directory = await mkdtemp(path.join(os.tmpdir(), 'slate-desktop-'));
  file = path.join(directory, 'sample.md');
  await writeFile(file, original);
  await launch(file);
  await expect(page.getByRole('heading', { name: 'A real document', exact: true })).toBeVisible();
});

test.afterEach(async ({}, testInfo) => {
  if (application && !applicationClosed) {
    const failed = testInfo.status !== testInfo.expectedStatus;
    try {
      if (failed && !page.isClosed()) {
        await testInfo.attach('electron-page-state', {
          body: await page.locator('body').ariaSnapshot({ timeout: 3000 }), contentType: 'text/plain',
        });
      }
      const trace = failed ? testInfo.outputPath('electron-trace.zip') : undefined;
      await application.context().tracing.stop(trace ? { path: trace } : undefined);
      if (trace) await testInfo.attach('electron-trace', { path: trace, contentType: 'application/zip' });
    } catch (error) {
      // A crashed app may be unable to provide diagnostics; preserve the original failure.
      await testInfo.attach('electron-diagnostics-error', { body: String(error), contentType: 'text/plain' });
    }
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

test('Visual code blocks highlight fence languages and keep edits and undo as plain code', async () => {
  const block = page.locator('.code-block').last();
  const code = block.locator('pre code').first();
  await expect(code.locator('.hljs-keyword')).toHaveText('const');
  await expect(code.locator('.hljs-keyword')).toHaveCSS('color', 'rgb(0, 72, 200)');
  await expect(code.locator('.hljs-number')).toHaveText('42');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await code.click();
  await code.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  });
  await page.keyboard.type(' // edited');
  await expect(code.locator('.hljs-comment')).toHaveText('// edited');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(code).toHaveText('const value = 42;');
  await expect(code.locator('.hljs-comment')).toHaveCount(0);
  await page.keyboard.type(' // kept');
  await expect(code.locator('.hljs-comment')).toHaveText('// kept');
  const language = block.getByRole('textbox', { name: 'Code language' });
  await language.fill('unknown-language');
  await expect(code.locator('[class*="hljs-"]')).toHaveCount(0);
  await expect(code).toHaveText('const value = 42; // kept');
  await language.fill('ts');
  await expect(code.locator('.hljs-keyword')).toHaveText('const');
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown source' });
  const saved = await source.inputValue();
  expect(saved).toContain('```ts\nconst value = 42; // kept\n```');
  expect(saved).not.toContain('hljs-');
  await saveWithShortcut(file, saved);
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  await page.reload();
  await expect(code.locator('.hljs-comment')).toHaveText('// kept');
  await expect(page.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible();
  await page.screenshot({ path: 'tmp/slate-visual-code-highlighting.png' });
});

test('Visual code highlighting preserves Unicode, literal markup, and plain or unsupported fences', async () => {
  const sample = '// 😀 Pseudocode\nconst message = "<script>window.highlightExecuted = true</script> & café";\nawait Nimble.choose({ choices: ["FINISH"] });';
  const markdown = `# Code samples\n\n\`\`\`typescript\n${sample}\n\`\`\`\n\n\`\`\`text\nconst plain = true;\n\`\`\`\n\n\`\`\`unknown-language\nconst unknown = true;\n\`\`\`\n\n\`\`\`\nconst unlabeled = true;\n\`\`\`\n`;
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill(markdown);
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  const blocks = page.locator('.code-block');
  const code = blocks.first().locator('pre code').first();
  expect(await code.textContent()).toBe(sample);
  await expect(code.locator('.hljs-comment')).toHaveText('// 😀 Pseudocode');
  await expect(code.locator('.hljs-keyword').first()).toHaveText('const');
  await expect(code.locator('.hljs-string').first()).toHaveText('"<script>window.highlightExecuted = true</script> & café"');
  await expect(code.locator('script')).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, 'highlightExecuted'))).toBeUndefined();
  for (const index of [1, 2, 3]) await expect(blocks.nth(index).locator('[class*="hljs-"]')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue(markdown);
});

test('new windows keep folders, drafts, saves, and menu commands independent', async () => {
  const otherFolder = path.join(directory, 'other-repo');
  await mkdir(otherFolder);
  const otherFile = path.join(otherFolder, 'sample.md');
  await writeFile(otherFile, '# Other repository\n');
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# First window draft\n');
  const firstId = (await page.evaluate(() => window.slate!.ready())).activeId;
  const second = await openNewWindow();
  await expect(second.getByText(/An unsaved draft is available/)).toHaveCount(0);
  await openFolderIn(second, otherFolder);
  await second.evaluate(() => window.slate!.openFile('sample.md'));
  await expect(second.getByRole('heading', { name: 'Other repository' })).toBeVisible();
  expect((await page.evaluate(() => window.slate!.folderReady()))?.path).toBe(await realpath(directory));
  expect((await second.evaluate(() => window.slate!.folderReady()))?.path).toBe(await realpath(otherFolder));
  expect(await second.evaluate(id => window.slate!.save('wrong window', false, { id, path: null }), firstId)).toEqual({ canceled: true });
  await second.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await second.getByRole('textbox', { name: 'Markdown source' }).fill('# Second window saved\n');
  await expect(second.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  const secondNative = await application.browserWindow(second);
  await secondNative.evaluate(window => { window.emit('focus'); });
  await application.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('save-document')!.click());
  await expect.poll(() => readFile(otherFile, 'utf8')).toBe('# Second window saved\n');
  expect(await readFile(file, 'utf8')).toBe(original);
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# First window draft\n');
  const firstNative = await application.browserWindow(page);
  await firstNative.evaluate(window => { window.emit('focus'); });
  await application.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('save-document')!.click());
  await expect.poll(() => readFile(file, 'utf8')).toBe('# First window draft\n');
  await expect(second.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# Second window saved\n');
});

test('closing a window confirms only its own drafts and leaves the other window usable', async () => {
  const second = await openNewWindow();
  await second.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await second.getByRole('textbox', { name: 'Markdown source' }).fill('# Keep this second-window draft\n');
  const native = await application.browserWindow(second);
  await native.evaluate(window => window.close());
  const confirmation = second.getByRole('dialog', { name: 'Save changes?' });
  await expect(confirmation).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(second.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# Keep this second-window draft\n');
  await native.evaluate(window => window.close());
  const closed = second.waitForEvent('close');
  await confirmation.getByRole('button', { name: 'Discard', exact: true }).click();
  await closed;
  expect(application.windows()).toHaveLength(1);
  await expect(page.getByRole('heading', { name: 'A real document', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# Still usable\n');
  await saveWithShortcut(file, '# Still usable\n');
});

test('quitting multiple windows saves each only after its own confirmation', async () => {
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# First saved on quit\n');
  const second = await openNewWindow();
  await second.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await second.getByRole('textbox', { name: 'Markdown source' }).fill('# Second saved on quit\n');
  await application.evaluate(({ app }) => app.quit());
  await page.getByRole('dialog', { name: 'Save changes?' }).getByRole('button', { name: 'Save', exact: true }).click();
  const prompt = second.getByRole('dialog', { name: 'Save changes?' });
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await readFile(file, 'utf8')).toBe('# First saved on quit\n');
  await expect(second.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# Second saved on quit\n');
  expect(application.windows()).toHaveLength(2);
  const secondPath = path.join(directory, 'second-on-quit.md');
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, secondPath);
  await application.evaluate(({ app }) => app.quit());
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const closed = application.waitForEvent('close');
  await prompt.getByRole('button', { name: 'Save', exact: true }).click();
  await closed;
  expect(await readFile(secondPath, 'utf8')).toBe('# Second saved on quit\n');
});

test('two windows can export PDFs concurrently without exchanging their contents', async () => {
  const second = await openNewWindow();
  const firstNative = await application.browserWindow(page);
  const firstId = await firstNative.evaluate(window => window.id);
  const outputs = { firstId, first: path.join(directory, 'first.pdf'), second: path.join(directory, 'second.pdf') };
  await application.evaluate(({ dialog }, paths) => {
    dialog.showSaveDialog = async parent => ({ canceled: false, filePath: parent.id === paths.firstId ? paths.first : paths.second });
  }, outputs);
  const results = await Promise.all([
    page.evaluate(async () => window.slate!.exportPdf('# First\n\n[First](https://first.example/)\n', (await window.slate!.ready()).activeId)),
    second.evaluate(async () => window.slate!.exportPdf('# Second\n\n[Second](https://second.example/)\n', (await window.slate!.ready()).activeId)),
  ]);
  expect(results).toEqual([{ path: outputs.first }, { path: outputs.second }]);
  const firstPdf = (await readFile(outputs.first)).toString('latin1');
  const secondPdf = (await readFile(outputs.second)).toString('latin1');
  expect(firstPdf).toContain('https://first.example/');
  expect(firstPdf).not.toContain('https://second.example/');
  expect(secondPdf).toContain('https://second.example/');
  expect(secondPdf).not.toContain('https://first.example/');
});

test('quit checks again if an already-confirmed window is edited while another prompt is open', async () => {
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown source' });
  await source.fill('# First saved version\n');
  const second = await openNewWindow();
  await second.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await second.getByRole('textbox', { name: 'Markdown source' }).fill('# Second draft\n');
  await application.evaluate(({ app }) => app.quit());
  const firstPrompt = page.getByRole('dialog', { name: 'Save changes?' });
  await firstPrompt.getByRole('button', { name: 'Save', exact: true }).click();
  const secondPrompt = second.getByRole('dialog', { name: 'Save changes?' });
  await expect(secondPrompt).toBeVisible();
  await source.fill('# New edit during quit\n');
  await secondPrompt.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(firstPrompt).toBeVisible();
  await firstPrompt.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(source).toHaveValue('# New edit during quit\n');
  expect(await readFile(file, 'utf8')).toBe('# First saved version\n');
  expect(application.windows()).toHaveLength(2);
});

test('restart restores both window workspaces and keeps crash-recovery drafts separate', async () => {
  const second = await openNewWindow();
  const otherFolder = path.join(directory, 'other-repo');
  await mkdir(otherFolder);
  await writeFile(path.join(otherFolder, 'other.md'), '# Other repository\n');
  await openFolderIn(second, otherFolder);
  await second.evaluate(() => window.slate!.openFile('other.md'));
  const firstWindowId = await page.evaluate(() => window.slate!.workspaceId);
  const secondWindowId = await second.evaluate(() => window.slate!.workspaceId);
  expect(firstWindowId).not.toBe(secondWindowId);
  for (const [window, text] of [[page, '# First recovery\n'], [second, '# Second recovery\n']] as const) {
    await window.getByRole('tab', { name: 'Markdown', exact: true }).click();
    await window.getByRole('textbox', { name: 'Markdown source' }).fill(text);
    await expect.poll(() => window.evaluate(() => {
      const id = window.slate!.workspaceId;
      return JSON.parse(localStorage.getItem(`slate-unsaved-drafts-v2${id === 'main' ? '' : '-' + id}`) || '[]').map((draft: { content: string }) => draft.content);
    })).toEqual([text]);
  }
  await application.evaluate(({ session }) => { session.defaultSession.flushStorageData(); });
  const exited = application.waitForEvent('close');
  await application.evaluate(({ app }) => { setTimeout(() => app.exit(0), 50); });
  await exited;
  await launch();
  await expect.poll(() => application.windows().length).toBe(2);
  const restored = application.windows();
  for (const window of restored) {
    await window.evaluate(() => window.slate!.ready());
    const id = await window.evaluate(() => window.slate!.workspaceId);
    expect([firstWindowId, secondWindowId]).toContain(id);
    await expect(window.getByText(/An unsaved draft is available/)).toBeVisible();
    await window.getByRole('button', { name: 'Recover as new document', exact: true }).click();
    await expect(window.getByRole('heading', { name: id === firstWindowId ? 'First recovery' : 'Second recovery', exact: true })).toBeVisible();
    expect((await window.evaluate(() => window.slate!.folderReady()))?.path).toBe(await realpath(id === firstWindowId ? directory : otherFolder));
  }
});

test('Mermaid supports pointer-centered zoom, dragging, and fit without editing the document', async () => {
  const viewport = page.getByRole('group', { name: 'Diagram canvas', exact: true });
  const canvas = viewport.locator('.diagram-canvas');
  const zoom = page.getByLabel('Diagram zoom', { exact: true });
  await expect(zoom).toHaveText('100%');
  await viewport.scrollIntoViewIfNeeded();
  const initial = await canvas.evaluate(element => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { scale: matrix.a, x: matrix.e, y: matrix.f };
  });
  const scrollTop = () => page.locator('.document-scroll').evaluate(element => element.scrollTop);
  const scrollBefore = await scrollTop();
  const bounds = (await viewport.boundingBox())!;
  const pointer = { x: bounds.x + bounds.width * 0.6, y: bounds.y + bounds.height * 0.5 };
  await page.mouse.move(pointer.x, pointer.y);
  await page.mouse.wheel(0, -300);
  await expect(zoom).not.toHaveText('100%');
  const enlarged = await canvas.evaluate(element => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { scale: matrix.a, x: matrix.e, y: matrix.f };
  });
  expect(enlarged.scale).toBeGreaterThan(initial.scale);
  expect(await scrollTop()).toBe(scrollBefore);
  // The same diagram point stays under the mouse as its scale changes.
  const localX = pointer.x - bounds.x;
  expect((localX - enlarged.x) / enlarged.scale).toBeCloseTo((localX - initial.x) / initial.scale, 0);
  await page.mouse.down();
  await page.mouse.move(pointer.x + 90, pointer.y + 40, { steps: 5 });
  await page.mouse.up();
  const moved = await canvas.evaluate(element => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f };
  });
  expect(moved.x - enlarged.x).toBeCloseTo(90, 1);
  expect(moved.y - enlarged.y).toBeCloseTo(40, 1);
  await expect(viewport).not.toHaveClass(/is-panning/);
  await page.getByRole('button', { name: 'Fit diagram', exact: true }).click();
  await expect(zoom).toHaveText('100%');
  await viewport.focus();
  await page.keyboard.press('+');
  await expect(zoom).toHaveText('125%');
  await page.keyboard.press('0');
  await expect(zoom).toHaveText('100%');
  await expect(viewport).toHaveCSS('outline-style', 'none');
  await expect(viewport).toHaveCSS('border-top-width', '1px');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue(original);
  expect(await readFile(file, 'utf8')).toBe(original);
});

test('Mermaid expands into a resizable dialog and restores the inline view without editing', async () => {
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  const diagram = 'flowchart LR\n' + Array.from({ length: 12 }, (_, i) => `N${i}[Stage ${i + 1}] --> N${i + 1}[Stage ${i + 2}]`).join('\n');
  const markdown = `# Large diagram\n\n\`\`\`mermaid\n${diagram}\n\`\`\`\n`;
  await page.getByRole('textbox', { name: 'Markdown source' }).fill(markdown);
  await saveWithShortcut(file, markdown);
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  const inline = page.locator('.diagram-preview');
  const viewport = inline.getByRole('group', { name: 'Diagram canvas', exact: true });
  const expand = inline.getByRole('button', { name: 'Expand diagram', exact: true });
  await expect(inline.getByLabel('Diagram zoom', { exact: true })).toHaveText('100%');
  await inline.getByRole('button', { name: 'Zoom in diagram', exact: true }).click();
  await viewport.focus();
  await page.keyboard.press('ArrowLeft');
  const transform = await inline.locator('.diagram-canvas').evaluate(element => element.style.transform);
  const bounds = (await viewport.boundingBox())!;
  const scrollBefore = await page.locator('.document-scroll').evaluate(element => element.scrollTop);
  await expand.click();
  const dialog = page.getByRole('dialog', { name: 'Mermaid diagram', exact: true });
  const expandedViewport = dialog.getByRole('group', { name: 'Diagram canvas', exact: true });
  const expectCompactHeader = async () => {
    const title = (await dialog.getByRole('heading', { name: 'Mermaid diagram' }).boundingBox())!;
    for (const name of ['Zoom out diagram', 'Zoom in diagram', 'Fit diagram', 'Close expanded diagram']) {
      const button = (await dialog.getByRole('button', { name, exact: true }).boundingBox())!;
      expect(Math.abs(button.y + button.height / 2 - title.y - title.height / 2)).toBeLessThan(1);
    }
    expect((await dialog.locator('.diagram-controls').boundingBox())!.height).toBeLessThanOrEqual(32);
  };
  await expect(dialog).toBeVisible();
  await expectCompactHeader();
  await expect(expandedViewport).toBeFocused();
  await expect(expandedViewport).toHaveCSS('outline-style', 'none');
  await expect(expandedViewport).toHaveCSS('border-top-width', '1px');
  if (process.platform === 'darwin') {
    const titlebar = (await page.locator('.titlebar').boundingBox())!;
    expect((await dialog.boundingBox())!.y).toBeGreaterThanOrEqual(titlebar.y + titlebar.height);
  }
  await expect(dialog.getByLabel('Diagram zoom', { exact: true })).toHaveText('100%');
  const expandedBounds = (await expandedViewport.boundingBox())!;
  expect(expandedBounds.width).toBeGreaterThan(bounds.width);
  expect(expandedBounds.height).toBeGreaterThan(bounds.height);
  await expect(dialog.locator('.diagram-canvas > svg')).toContainText('Stage 13');
  expect(await page.locator('svg[id]').evaluateAll(elements => {
    const ids = elements.flatMap(svg => [svg.id, ...Array.from(svg.querySelectorAll('[id]'), element => element.id)]);
    return new Set(ids).size === ids.length;
  })).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(expand).toBeFocused();
  expect(await inline.locator('.diagram-canvas').evaluate(element => element.style.transform)).toBe(transform);
  expect(await page.locator('.document-scroll').evaluate(element => element.scrollTop)).toBe(scrollBefore);
  await expand.click();
  await page.keyboard.press('+');
  await expect(dialog.getByLabel('Diagram zoom', { exact: true })).toHaveText('125%');
  await dialog.getByRole('button', { name: 'Fit diagram', exact: true }).click();
  await expect(dialog.getByLabel('Diagram zoom', { exact: true })).toHaveText('100%');
  await page.setViewportSize({ width: 820, height: 620 });
  await expect.poll(async () => (await expandedViewport.boundingBox())!.width).toBeLessThan(expandedBounds.width);
  const resizedBounds = (await expandedViewport.boundingBox())!;
  expect(resizedBounds.height).toBeLessThan(expandedBounds.height);
  expect(resizedBounds.x + resizedBounds.width).toBeLessThanOrEqual(820);
  expect(resizedBounds.y + resizedBounds.height).toBeLessThanOrEqual(620);
  if (process.platform === 'darwin') expect((await dialog.boundingBox())!.y).toBeGreaterThanOrEqual(62);
  await expectCompactHeader();
  await page.screenshot({ path: 'tmp/slate-expanded-titlebar.png' });
  const fitted = await dialog.locator('.diagram-canvas').boundingBox();
  expect(fitted!.width).toBeLessThanOrEqual(resizedBounds.width + 1);
  expect(fitted!.height).toBeLessThanOrEqual(resizedBounds.height + 1);
  await page.setViewportSize({ width: 1120, height: 800 });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(expand).toBeFocused();
  await expect(inline.locator('.diagram-canvas > svg')).toContainText('Stage 13');
  // The resize refits both canvases, so capture the new inline position before reopening.
  await inline.getByRole('button', { name: 'Zoom in diagram', exact: true }).click();
  const restoredTransform = await inline.locator('.diagram-canvas').evaluate(element => element.style.transform);
  await expand.click();
  await dialog.getByRole('button', { name: 'Close expanded diagram', exact: true }).click();
  expect(await inline.locator('.diagram-canvas').evaluate(element => element.style.transform)).toBe(restoredTransform);
  expect(await page.locator('.document-scroll').evaluate(element => element.scrollTop)).toBe(scrollBefore);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue(markdown);
  expect(await readFile(file, 'utf8')).toBe(markdown);
});

test('footer contains company and repository links without document statistics', async () => {
  const footer = page.locator('footer');
  await expect(footer).toContainText('© 2026 by M45 Engineering Inc.');
  await expect(footer).not.toContainText('sample.md');
  await expect(footer).not.toContainText(/Saved to file|Unsaved changes|Not saved yet|\bwords\b|\bmin read\b|\bcharacters\b/);
  await expect(footer.getByRole('button', { name: 'Document zoom' })).toHaveText('100%');
  const website = footer.getByRole('link', { name: '© 2026 by M45 Engineering Inc.', exact: true });
  const github = footer.getByRole('link', { name: 'Slate on GitHub' });
  await expect(footer).not.toContainText('www.m45.engineering');
  const footerBounds = (await footer.boundingBox())!;
  const linksBounds = (await footer.locator('.footer-links').boundingBox())!;
  const zoomBounds = (await footer.getByRole('button', { name: 'Document zoom' }).boundingBox())!;
  expect(linksBounds.x - footerBounds.x).toBeLessThan(40);
  expect(footerBounds.x + footerBounds.width - zoomBounds.x - zoomBounds.width).toBeLessThan(40);
  await expect(website).toHaveAttribute('href', 'https://www.m45.engineering/');
  await expect(github).toHaveAttribute('href', 'https://github.com/m45-engineering/slate');
  await expect(github.locator('img')).toHaveJSProperty('naturalWidth', 16);
  await application.evaluate(({ shell, dialog }) => {
    Reflect.set(globalThis, 'footerLinksOpened', []);
    shell.openExternal = async url => { Reflect.get(globalThis, 'footerLinksOpened').push(url); };
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  const editorUrl = page.url();
  await website.click();
  await github.click();
  await expect.poll(() => application.evaluate(() => Reflect.get(globalThis, 'footerLinksOpened'))).toEqual([
    'https://www.m45.engineering/', 'https://github.com/m45-engineering/slate',
  ]);
  expect(page.url()).toBe(editorUrl);
  expect(await readFile(file, 'utf8')).toBe(original);
  await footer.screenshot({ path: 'tmp/slate-footer.png' });
});

test('Save stays disabled and view changes leave an unchanged file untouched', async () => {
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue(original);
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(await readFile(file, 'utf8')).toBe(original);
});

test('web links preview their URL and require confirmation before opening the default browser', async () => {
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  const markdown = '# Links\n\n[Secure site](https://example.com/docs) and [HTTP site](http://example.com/help).\n';
  await page.getByRole('textbox', { name: 'Markdown source' }).fill(markdown);
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  await application.evaluate(({ shell, dialog }) => {
    Reflect.set(globalThis, 'documentLinksOpened', []);
    Reflect.set(globalThis, 'linkPrompts', []);
    Reflect.set(globalThis, 'linkResponse', 0);
    shell.openExternal = async url => { Reflect.get(globalThis, 'documentLinksOpened').push(url); };
    dialog.showMessageBox = async (_window, options) => {
      Reflect.get(globalThis, 'linkPrompts').push(options);
      return { response: Reflect.get(globalThis, 'linkResponse'), checkboxChecked: false };
    };
  });
  const editorUrl = page.url();
  const secure = page.getByRole('link', { name: 'Secure site', exact: true });
  await secure.hover();
  await expect(page.getByLabel('Link destination')).toHaveText('https://example.com/docs');
  await secure.click();
  await expect.poll(() => application.evaluate(() => Reflect.get(globalThis, 'linkPrompts').length)).toBe(1);
  expect(await application.evaluate(() => Reflect.get(globalThis, 'documentLinksOpened'))).toEqual([]);
  expect(await application.evaluate(() => Reflect.get(globalThis, 'linkPrompts')[0])).toMatchObject({
    detail: 'https://example.com/docs\n\nOnly open links you trust.', defaultId: 0, cancelId: 0,
  });
  await application.evaluate(() => Reflect.set(globalThis, 'linkResponse', 1));
  for (const name of ['Secure site', 'HTTP site']) {
    const link = page.getByRole('link', { name, exact: true });
    await expect(link).toHaveCSS('color', 'rgb(29, 78, 216)');
    await link.click();
  }
  await expect.poll(() => application.evaluate(() => Reflect.get(globalThis, 'documentLinksOpened'))).toEqual(['https://example.com/docs', 'http://example.com/help']);
  await page.getByRole('tab', { name: 'Markdown', exact: true }).hover();
  await expect(page.getByLabel('Link destination')).toHaveCount(0);
  expect(page.url()).toBe(editorUrl);
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue(markdown);
  expect(await readFile(file, 'utf8')).toBe(original);
});

test('document links resolve from the current document and preserve open drafts', async () => {
  await mkdir(path.join(directory, 'docs'));
  const target = path.join(directory, 'docs', 'linked note.md');
  await writeFile(target, '# Linked note\n\n[Back](../sample.md)\n');
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  const markdown = '# Unsaved links\n\n[Local note](docs/linked%20note.md)\n\n[Missing](missing.md)\n';
  await page.getByRole('textbox', { name: 'Markdown source' }).fill(markdown);
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  const local = page.getByRole('link', { name: 'Local note', exact: true });
  await local.hover();
  await expect(page.getByLabel('Link destination')).toHaveText('docs/linked%20note.md');
  await local.click();
  await expect(page.getByRole('heading', { name: 'Linked note', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('link', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Unsaved links', exact: true })).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab')).toHaveCount(2);
  await page.getByRole('link', { name: 'Missing', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('ENOENT');
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue(markdown);
  expect(await readFile(file, 'utf8')).toBe(original);
});

test('heading links scroll within an unsaved document, including duplicate and Unicode headings', async () => {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New Markdown document', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Untitled.md', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  const filler = Array.from({ length: 24 }, (_, i) => `Paragraph ${i}.\n\n`).join('');
  const markdown = `[Duplicate](#repeat-1) [Unicode](#caf%C3%A9) [Missing](#absent)\n\n## Repeat\n\n${filler}## Repeat\n\n${filler}## Café\n\n${filler}`;
  await page.getByRole('textbox', { name: 'Markdown source' }).fill(markdown);
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  const editorUrl = page.url();
  const expectAtHeading = async (heading: Locator) => {
    await expect.poll(async () => {
      const target = (await heading.boundingBox())!;
      const viewport = (await page.locator('.document-scroll').boundingBox())!;
      return Math.abs(target.y - viewport.y - 35);
    }).toBeLessThan(3);
  };
  await page.getByRole('link', { name: 'Duplicate', exact: true }).click();
  await expectAtHeading(page.getByRole('heading', { name: 'Repeat', exact: true }).nth(1));
  await page.getByRole('link', { name: 'Unicode', exact: true }).click();
  await expectAtHeading(page.getByRole('heading', { name: 'Café', exact: true }));
  await page.getByRole('link', { name: 'Missing', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Heading not found: #absent');
  expect(page.url()).toBe(editorUrl);
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue(markdown);
});

test('heading links open another document and scroll after its content is rendered', async () => {
  const filler = Array.from({ length: 24 }, (_, i) => `Paragraph ${i}.\n\n`).join('');
  const target = `# Other document\n\n${filler}## Install **here**!\n\n${filler}`;
  await writeFile(path.join(directory, 'target.md'), target);
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  const markdown = '# Original draft\n\n[Install](target.md#install-here)\n';
  await page.getByRole('textbox', { name: 'Markdown source' }).fill(markdown);
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  await page.getByRole('link', { name: 'Install', exact: true }).click();
  const heading = page.getByRole('heading', { name: 'Install here!', exact: true });
  await expect.poll(async () => {
    const target = await heading.boundingBox();
    const viewport = (await page.locator('.document-scroll').boundingBox())!;
    return target ? Math.abs(target.y - viewport.y - 35) : Infinity;
  }).toBeLessThan(3);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.evaluate(() => window.slate!.openFile('sample.md'));
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue(markdown);
  expect(await readFile(path.join(directory, 'target.md'), 'utf8')).toBe(target);
});

test('heading links retain the target tab draft and Markdown view, recognizing setext headings outside code', async () => {
  const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}.\n\n`).join('');
  const target = `# Other document\n\n\`\`\`md\n## Install here\n\`\`\`\n\n${filler}Install *here*\n-------------\n\n${filler}`;
  await writeFile(path.join(directory, 'target.md'), target);
  await page.evaluate(() => window.slate!.openFile('target.md'));
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  const draft = target + '\nUnsaved target draft.\n';
  await page.getByRole('textbox', { name: 'Markdown source' }).fill(draft);
  await page.evaluate(() => window.slate!.openFile('sample.md'));
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('[Install](target.md#install-here)\n');
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  await page.getByRole('link', { name: 'Install', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown source' });
  await expect(source).toHaveValue(draft);
  await expect(source).toBeFocused();
  await expect.poll(() => source.evaluate((input: HTMLTextAreaElement) => input.selectionStart)).toBe(draft.indexOf('Install *here*'));
  await expect.poll(() => page.locator('.document-scroll').evaluate(element => element.scrollTop)).toBeGreaterThan(1000);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  expect(await readFile(path.join(directory, 'target.md'), 'utf8')).toBe(target);
});

test('shell variables inside inline code remain available in Visual view', async () => {
  const guide = '# Installation guide\n\n`$HOME` is your home folder. Use `$HOME/app` and `$PATH` as written.\n\nExample markup: `<div>` and `![image](file.png)`.\n\n```sh\ncd "$HOME/app"\nexport PATH="$HOME/bin:$PATH"\n```\n';
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown source' });
  await source.fill(guide);
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Installation guide' })).toBeVisible();
  await expect(page.locator('.document-editor > p code').first()).toHaveText('$HOME');
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await expect(source).toHaveValue(guide);
  expect(await readFile(file, 'utf8')).toBe(original);
});

test('formulas render, edit, export, and preserve Markdown without treating prices as math', async () => {
  const target = path.join(directory, 'formulas.pdf');
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, target);
  const markdown = '# Formulas\n\nEinstein: $E=mc^2$. Fraction: $\\frac{a}{b}$.\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\nThe price is $5 or $10. Shell code: `$HOME $PATH`.\n';
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown source' });
  await source.fill(markdown);
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  await expect(page.locator('.document-editor .tiptap-mathematics-render')).toHaveCount(3);
  await expect(page.locator('.document-editor .katex')).toHaveCount(3);
  await expect(page.locator('.document-editor')).toContainText('The price is $5 or $10.');
  await expect(page.locator('.document-editor > p code')).toHaveText('$HOME $PATH');
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await expect(source).toHaveValue(markdown);
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  await page.locator('[data-type="inline-math"]').first().click();
  const dialog = page.getByRole('dialog', { name: 'Edit formula', exact: true });
  await dialog.getByRole('textbox', { name: 'Formula source' }).fill('E=mc^3');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('[data-type="inline-math"]').first()).toHaveAttribute('data-latex', 'E=mc^3');
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: `PDF saved to ${target}` })).toBeVisible({ timeout: 30_000 });
  await writeFile('tmp/slate-formulas.pdf', await readFile(target));
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await expect(source).toHaveValue(/\$E=mc\^3\$/);
  await expect(source).toHaveValue(/\\frac\{a\}\{b\}/);
  await expect(source).toHaveValue(/\$\$\n\\int_0\^1/);
  expect(await readFile(file, 'utf8')).toBe(original);
});

test('formulas can be inserted and invalid LaTeX stops PDF export', async () => {
  const target = path.join(directory, 'invalid-formula.pdf');
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, target);
  await page.getByRole('textbox', { name: 'Document editor' }).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.getByRole('button', { name: 'Insert formula', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Insert formula', exact: true });
  await dialog.getByRole('tab', { name: 'Separate line', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Formula source' }).fill('a^2+b^2=c^2');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  const formula = page.locator('[data-type="block-math"]');
  await expect(formula).toHaveAttribute('data-latex', 'a^2+b^2=c^2');
  await formula.click();
  dialog = page.getByRole('dialog', { name: 'Edit formula', exact: true });
  await dialog.getByRole('textbox', { name: 'Formula source' }).fill('\\frac{');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(formula).toHaveClass(/block-math-error/);
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'A formula is invalid' })).toBeVisible({ timeout: 30_000 });
  await expect(readFile(target)).rejects.toThrow();
  expect(await readFile(file, 'utf8')).toBe(original);
});

test('PDF export includes unsaved Markdown and Mermaid without changing the document or view', async () => {
  const target = path.join(directory, 'export.pdf');
  await application.evaluate(({ app, dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    app.once('web-contents-created', (_, contents) => {
      const print = contents.printToPDF.bind(contents);
      contents.printToPDF = async options => {
        Reflect.set(globalThis, 'printedMarkerTargets', await contents.executeJavaScript(`
          [...document.querySelectorAll('.pdf-output [marker-end]')].map(edge => {
            const id = edge.getAttribute('marker-end').slice(5, -1);
            const targets = [...document.querySelectorAll('[id]')].filter(element => element.id === id);
            return targets.length === 1 && Boolean(targets[0].closest('.pdf-output'));
          })
        `));
        return print(options);
      };
    });
  }, target);
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown source' });
  const markdown = '# Exported draft\n\n[Reference](https://example.com/pdf-reference)\n\n| Item | Status |\n| --- | --- |\n| PDF | Ready |\n\n- [x] Included task\n\n```mermaid\nflowchart LR\n  A[Write] --> B[Share PDF]\n```\n\n## Code\n\n```typescript\nconst message = "' + 'A long line '.repeat(30) + '";\n```\n\n' + Array.from({ length: 35 }, (_, i) => `Paragraph ${i + 1}: This content must remain readable across page breaks.`).join('\n\n') + '\n';
  await source.fill(markdown);
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: `PDF saved to ${target}` })).toBeVisible({ timeout: 30_000 });
  const pdf = await readFile(target);
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdf.toString('latin1')).toContain('https://example.com/pdf-reference');
  expect([...pdf.toString('latin1').matchAll(/\/Type \/Page\b/g)].length).toBeGreaterThan(1);
  expect(await application.evaluate(() => Reflect.get(globalThis, 'printedMarkerTargets'))).toEqual([true]);
  await writeFile('tmp/slate-pdf-export.pdf', pdf);
  await expect(source).toHaveValue(markdown);
  await expect(page.getByRole('tab', { name: 'Markdown', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  expect(await readFile(file, 'utf8')).toBe(original);
  expect(application.windows()).toHaveLength(1);
});

test('PDF export cancels cleanly and refuses an invalid diagram without replacing a PDF', async () => {
  await page.setViewportSize({ width: 800, height: 800 });
  const modeBounds = (await page.getByRole('tablist', { name: 'Editor view' }).boundingBox())!;
  const actionBounds = (await page.locator('.file-actions').boundingBox())!;
  expect(modeBounds.x + modeBounds.width).toBeLessThanOrEqual(actionBounds.x);
  const target = path.join(directory, 'existing.pdf');
  await writeFile(target, 'Existing PDF must survive');
  await application.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' }); });
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export PDF', exact: true })).toBeEnabled();
  expect(await readFile(target, 'utf8')).toBe('Existing PDF must survive');
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, target);
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown source' });
  await source.fill('# Invalid diagram\n\n```mermaid\nnot a valid diagram\n```\n');
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'A Mermaid diagram is invalid' })).toBeVisible({ timeout: 30_000 });
  expect(await readFile(target, 'utf8')).toBe('Existing PDF must survive');
  expect(application.windows()).toHaveLength(1);
  await source.fill('# Retry succeeds\n');
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: `PDF saved to ${target}` })).toBeVisible({ timeout: 30_000 });
  expect((await readFile(target)).subarray(0, 5).toString()).toBe('%PDF-');
  expect(await readFile(file, 'utf8')).toBe(original);
});

test('PDF export fits wide and tall diagrams and paginates long tables', async () => {
  const target = path.join(directory, 'diagrams.pdf');
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, target);
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  const wide = 'flowchart LR\n' + Array.from({ length: 8 }, (_, i) => `N${i}[Wide step ${i + 1}] --> N${i + 1}[Wide step ${i + 2}]`).join('\n');
  const tall = 'flowchart TD\n' + Array.from({ length: 18 }, (_, i) => `T${i}[Tall step ${i + 1}] --> T${i + 1}[Tall step ${i + 2}]`).join('\n');
  const table = '| Record | Description |\n| --- | --- |\n' + Array.from({ length: 65 }, (_, i) => `| ${i + 1} | Row ${i + 1} must be included |`).join('\n');
  await page.getByRole('textbox', { name: 'Markdown source' }).fill(`# Wide diagram\n\n\`\`\`mermaid\n${wide}\n\`\`\`\n\n## Tall diagram\n\n\`\`\`mermaid\n${tall}\n\`\`\`\n\n## Table\n\n${table}\n`);
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: `PDF saved to ${target}` })).toBeVisible({ timeout: 30_000 });
  const pdf = await readFile(target);
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  await writeFile('tmp/slate-pdf-diagrams.pdf', pdf);
  expect(await readFile(file, 'utf8')).toBe(original);
});

test('PDF preserves Mermaid labels and layout on a larger page regardless of canvas zoom', async () => {
  const target = path.join(directory, 'large-diagram.pdf');
  const diagram = 'flowchart TD\n  TITLE[ASSURANCE SPACE]:::title --> N0[Initial evidence]\n'
    + Array.from({ length: 18 }, (_, i) => `  N${i} --> N${i + 1}[Evidence step ${i + 1}]`).join('\n')
    + '\n  classDef title font-size:24px,font-weight:700,white-space:nowrap';
  const markdown = `# Report\n\n## Large diagram\n\n\`\`\`mermaid\n${diagram}\n\`\`\`\n\n## Discussion\n\nOrdinary prose stays on A4.\n`;
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill(markdown);
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  await expect(page.locator('.mermaid-block')).toHaveAttribute('data-mermaid-status', 'ready');
  const layout = await page.locator('.diagram-canvas svg').evaluate(svg => ({
    viewBox: svg.getAttribute('viewBox'),
    nodes: [...svg.querySelectorAll('g.node')].map(node => ({ text: node.textContent, transform: node.getAttribute('transform') })),
  }));
  await page.getByRole('button', { name: 'Zoom in diagram', exact: true }).click();
  await application.evaluate(({ app, dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    app.once('web-contents-created', (_, contents) => {
      const print = contents.printToPDF.bind(contents);
      contents.printToPDF = async options => {
        Reflect.set(globalThis, 'printedDiagram', await contents.executeJavaScript(`(() => {
          const svg = document.querySelector('.pdf-output .diagram-preview svg');
          const figure = svg.closest('.pdf-figure');
          return {
            viewBox: svg.getAttribute('viewBox'),
            nodes: [...svg.querySelectorAll('g.node')].map(node => ({ text: node.textContent, transform: node.getAttribute('transform') })),
            page: figure.style.page,
            headings: [...figure.querySelectorAll('h1, h2')].map(heading => heading.textContent),
            controls: document.querySelectorAll('.pdf-output .diagram-viewer').length
          };
        })()`));
        return print(options);
      };
    });
  }, target);
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: `PDF saved to ${target}` })).toBeVisible({ timeout: 30_000 });
  const printed = await application.evaluate(() => Reflect.get(globalThis, 'printedDiagram'));
  expect(printed).toEqual({ ...layout, page: 'diagram-large-0', headings: ['Report', 'Large diagram'], controls: 0 });
  // The actual PDF has one tall diagram page followed by ordinary A4 prose.
  const pdf = (await readFile(target)).toString('latin1');
  const sizes = [...pdf.matchAll(/\/MediaBox\s*\[0 0 ([\d.]+) ([\d.]+)\]/g)].map(match => [Number(match[1]), Number(match[2])]);
  expect(sizes).toHaveLength(2);
  expect(sizes[0][1]).toBeGreaterThan(842);
  expect(sizes[1][0]).toBeCloseTo(595, 0);
  expect(sizes[1][1]).toBeCloseTo(842, 0);
  await expect(page.getByLabel('Diagram zoom', { exact: true })).toHaveText('125%');
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue(markdown);
  expect(await readFile(file, 'utf8')).toBe(original);
});

test('PDF export reports unsupported Markdown and file write failures without losing edits', async () => {
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown source' });
  const unsupported = '---\ntitle: Metadata\n---\n\n# Preserve me\n';
  await source.fill(unsupported);
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'PDF export cannot yet render YAML front matter' })).toBeVisible();
  await expect(source).toHaveValue(unsupported);
  await source.fill('# Preserve these unsaved edits\n');
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, path.join(directory, 'missing-folder', 'export.pdf'));
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'PDF export failed' })).toBeVisible({ timeout: 30_000 });
  await expect(source).toHaveValue('# Preserve these unsaved edits\n');
  expect(application.windows()).toHaveLength(1);
  expect(await readFile(file, 'utf8')).toBe(original);
});

test('View menu switches modes without a custom shortcut and preserves source-only content', async () => {
  const accelerator = await application.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('toggle-editor-view')?.accelerator);
  expect(accelerator).toBeNull();
  const toggleView = () => application.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('toggle-editor-view')!.click());
  await toggleView();
  const source = page.getByRole('textbox', { name: 'Markdown source' });
  await expect(source).toHaveValue(original);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await source.fill('# Edited through the menu\n');
  await toggleView();
  await expect(page.getByRole('heading', { name: 'Edited through the menu' })).toBeVisible();
  await toggleView();
  await expect(source).toHaveValue('# Edited through the menu\n');
  await source.fill('---\ntitle: Keep this front matter\n---\n\n# Heading\n');
  await toggleView();
  await expect(source).toBeVisible();
  await expect(source).toHaveValue('---\ntitle: Keep this front matter\n---\n\n# Heading\n');
  await expect(page.getByRole('status').filter({ hasText: 'Keep this document in Markdown' })).toBeVisible();
  expect(await readFile(file, 'utf8')).toBe(original);
});

test('visual headings have distinct sizes and spacing with matching menu previews', async () => {
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill(Array.from({ length: 6 }, (_, i) => `${'#'.repeat(i + 1)} Heading ${i + 1}\n\nBody text.`).join('\n\n') + '\n');
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  const headings = page.locator('.document-editor :is(h1, h2, h3, h4, h5, h6)');
  const styles = await headings.evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    return { size: parseFloat(style.fontSize), weight: style.fontWeight, spacing: style.letterSpacing, italic: style.fontStyle, top: parseFloat(style.marginTop), bottom: parseFloat(style.marginBottom) };
  }));
  expect(styles).toHaveLength(6);
  expect(styles[0].top).toBe(0);
  for (let i = 1; i < styles.length; i++) {
    expect(styles[i - 1].size).toBeGreaterThan(styles[i].size);
    expect(styles[i - 1].bottom).toBeGreaterThan(styles[i].bottom);
    expect(styles[i].top).toBeGreaterThan(styles[i].bottom);
    if (i > 1) expect(styles[i - 1].top).toBeGreaterThan(styles[i].top);
  }
  expect(styles[5].italic).toBe('italic');
  const gaps = await headings.evaluateAll(elements => elements.map(element => element.nextElementSibling!.getBoundingClientRect().top - element.getBoundingClientRect().bottom));
  for (let i = 0; i < styles.length; i++) expect(gaps[i]).toBeCloseTo(styles[i].bottom, 0);
  await expect(page.locator('.document-editor > p').first()).toHaveCSS('font-size', '15px');
  await page.screenshot({ path: 'tmp/slate-heading-hierarchy.png', fullPage: true });
  await page.getByRole('button', { name: 'Text style' }).click();
  for (let i = 0; i < styles.length; i++) {
    const preview = page.getByRole('menu').getByText(`Heading ${i + 1}`, { exact: true });
    await expect(preview).toHaveCSS('font-size', `${styles[i].size}px`);
    await expect(preview).toHaveCSS('font-weight', styles[i].weight);
    await expect(preview).toHaveCSS('font-style', styles[i].italic);
    await expect(preview).toHaveCSS('letter-spacing', styles[i].spacing);
  }
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
  expect(await application.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('save-document')?.enabled)).toBe(false);
});

test('new documents and later edits both require explicit Save', async () => {
  const target = path.join(directory, 'new-document.md');
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, target);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New Markdown document', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Untitled.md', exact: true })).toHaveAttribute('aria-selected', 'true');
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
  await saveWithShortcut(target, '# Saved explicitly\n');
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
  await delayDocumentWrite(file);
  const cell = page.locator('.document-editor td').filter({ hasText: 'Ready' });
  await cell.click();
  await page.keyboard.press('Home');
  await page.keyboard.type('Almost ');
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  const diagramSource = page.getByRole('textbox', { name: 'Markdown source' });
  const markdown = await diagramSource.inputValue();
  await diagramSource.fill(markdown.replace('A[Write] --> B[Review]', 'A[Write] --> B[Review]\n  B --> C[Ship]'));
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readFile(file, 'utf8')).toContain('Almost Ready');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  const saved = await readFile(file, 'utf8');
  expect(saved).toContain('Almost Ready');
  expect(saved).toContain('C[Ship]');
  expect(saved).toContain('```mermaid');
  expect(saved).toContain('const value = 42;');
  await page.reload();
  await expect(page.locator('.document-editor table')).toContainText('Almost Ready');
  await expect(page.getByRole('img', { name: 'Mermaid diagram' })).toContainText('Ship');
});

test('Mermaid is preview-only in Visual and can be edited in Markdown', async () => {
  const preview = page.getByRole('img', { name: 'Mermaid diagram' });
  await expect(preview).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit diagram', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Insert Mermaid diagram', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Mermaid source', exact: true })).toHaveCount(0);
  await expect(page.locator('.mermaid-block')).toContainText('Edit in Markdown view');
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown source', exact: true });
  await source.fill(original.replace('A[Write] --> B[Review]', 'A[Write] --> B[Review]\n  B --> C[Ship]'));
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  await expect(preview).toContainText('Ship');
  expect(await readFile(file, 'utf8')).toBe(original);
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readFile(file, 'utf8')).toContain('C[Ship]');
  await page.reload();
  await expect(preview).toContainText('Ship');
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
  await delayDocumentWrite(file);
  const markdown = '---\ntitle: Metadata\n---\n\n# Text\n\n<!-- keep this -->\n';
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill(markdown);
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toBeVisible();
  await saveWithShortcut(file, markdown);
});

test('inserting and editing a table writes Markdown, not HTML', async () => {
  await delayDocumentWrite(file);
  const prose = page.getByRole('textbox', { name: 'Document editor' });
  await prose.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.keyboard.type('Column A');
  const table = page.locator('.document-editor table').filter({ hasText: 'Column A' });
  await expect(table.locator('tr')).toHaveCount(3);
  await expect(table.locator('th, td')).toHaveCount(9);
  await expect(table.locator('td').last()).toHaveCSS('border', '1px solid rgb(212, 212, 212)');
  await table.screenshot({ path: 'tmp/slate-table-grid.png' });
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readFile(file, 'utf8')).toContain('Column A');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
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
  await openSidebarFile('design.md');
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
  await expect(page.getByRole('tab', { name: 'sample.md, unsaved changes', exact: true })).toBeVisible();
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

test('sidebar keeps project controls and file search visible while browsing long lists', async () => {
  await Promise.all(Array.from({ length: 60 }, (_, i) => writeFile(path.join(directory, `note-${String(i).padStart(2, '0')}.md`), `# Note ${i}\n`)));
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  const sidebar = page.getByLabel('Workspace sidebar', { exact: true });
  const scroller = sidebar.locator('.folder-sidebar-content');
  const search = sidebar.getByRole('textbox', { name: 'Find file by name' });
  const controls = [sidebar.getByRole('tab', { name: 'Files', exact: true }), sidebar.getByLabel('Workspace folder', { exact: true }), search];
  const positions = await Promise.all(controls.map(async control => (await control.boundingBox())!.y));
  await expect(sidebar.getByRole('button', { name: 'note-59.md', exact: true })).toBeAttached();
  for (const filtered of [false, true]) {
    if (filtered) {
      await search.fill('note-');
      await expect(sidebar.getByText('60 files', { exact: true })).toBeVisible();
    }
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(300);
    for (const [i, control] of controls.entries()) {
      expect(Math.abs((await control.boundingBox())!.y - positions[i])).toBeLessThan(1);
    }
    await expect(sidebar.getByRole('button', { name: 'New file', exact: true })).toBeInViewport();
    await expect(sidebar.getByRole('button', { name: 'New folder', exact: true })).toBeInViewport();
    await expect(sidebar.getByRole('button', { name: 'Refresh folder', exact: true })).toBeInViewport();
    await search.click();
    await expect(search).toBeFocused();
  }
  await sidebar.screenshot({ path: 'tmp/slate-sticky-file-search.png' });
  await sidebar.getByRole('button', { name: 'Clear file search' }).click();
  await expect(search).toHaveValue('');
  await sidebar.getByRole('tab', { name: 'Outline', exact: true }).click();
  await expect(sidebar.getByRole('navigation', { name: 'Document outline' })).toContainText('A real document');
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

for (const width of [1120, 980]) {
  test(`document zoom uses percentages without enlarging the controls or changing the file (${width}px viewport)`, async () => {
    // Native window sizes can be constrained by the CI desktop's display or scaling.
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
    const toolbar = page.locator('.titlebar');
    const before = await toolbar.boundingBox();
    const available = (await page.locator('.document-scroll').boundingBox())!.width;
    const editor = (await page.locator('.document-editor').boundingBox())!.width;
    // Keep a wide reading column at both sizes, allowing space for its side padding.
    expect(editor / available).toBeGreaterThan(0.8);
    await page.getByRole('button', { name: 'Document zoom' }).click();
    await page.getByRole('menuitemradio', { name: '125%', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Document zoom' })).toHaveText('125%');
    expect(await page.locator('.paper').evaluate(el => getComputedStyle(el).zoom)).toBe('1.25');
    expect((await toolbar.boundingBox())!.height).toBe(before!.height);
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    expect(await readFile(file, 'utf8')).toBe(original);
  });
}

test('filename search finds and opens files after more than 50,000 directory entries', async () => {
  await mkdir(path.join(directory, 'notes'));
  await writeFile(path.join(directory, 'notes', 'needle.md'), '# Found in a large folder\n');
  const root = await realpath(directory);
  await application.evaluate((_, root) => {
    const fs = process.getBuiltinModule('fs/promises');
    const opendir = fs.opendir;
    fs.opendir = async (directory, options) => {
      if (String(directory) !== root) return opendir(directory, options);
      const children = await fs.readdir(directory, { withFileTypes: true });
      return {
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < 50_010; i++) {
            yield { name: `asset-${i}.bin`, isDirectory: () => false, isFile: () => true };
          }
          yield* children;
        },
      };
    };
  }, root);
  await page.getByRole('textbox', { name: 'Find file by name' }).fill('needle');
  await expect(page.getByText('1 file', { exact: true })).toBeVisible();
  await expect(page.getByText('Open a smaller folder', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'needle.md notes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Found in a large folder' })).toBeVisible();
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
  // A slow settings write must not leave a newly displayed tab unable to accept Close.
  await openSidebarFile('next.md');
  await expect(page.getByRole('heading', { name: 'Next document' })).toBeVisible();
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
  await openSidebarFile('resume.md');
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
  await expect(page.getByRole('tab', { name: 'Untitled.md', exact: true })).toBeVisible();
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
  await expect(page.getByRole('button', { name: 'Export PDF', exact: true })).toHaveCount(0);
  expect(await application.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('export-pdf')?.enabled)).toBe(false);
  await expect(page.getByRole('tab', { name: 'Source', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await application.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('toggle-editor-view')!.click());
  await expect(source).toBeVisible();
  const updated = '// # Not a Markdown heading\n' + code + '\t// keep indentation  \n';
  await source.fill(updated);
  await saveWithShortcut(target, updated);
  await restart();
  await expect(page.getByRole('textbox', { name: 'Source editor', exact: true })).toHaveValue(updated);
  await expect(page.getByRole('button', { name: 'component.tsx', exact: true })).toHaveAttribute('aria-current', 'page');
  await openSidebarFile('sample.md');
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
  await openSidebarFile('next.md');
  await expect(page.getByRole('tab', { name: 'next.md', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Close sample.md', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save changes?' });
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Next document' })).toBeVisible();
  expect(await readFile(file, 'utf8')).toBe('# Saved before switching\n');
  expect(await page.evaluate(() => localStorage.getItem('slate-unsaved-drafts-v2'))).toBeNull();
});

test('canceled and failed Save As keep the pending switch and unsaved text intact', async () => {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New Markdown document', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Untitled.md', exact: true })).toHaveAttribute('aria-selected', 'true');
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
  const closed = process.platform === 'darwin' ? page.waitForEvent('close') : application.waitForEvent('close');
  await Promise.all([closed, dialog.getByRole('button', { name: 'Discard', exact: true }).click()]);
  expect(await readFile(file, 'utf8')).toBe(original);
  // macOS keeps the app running after its last window closes. Quit explicitly:
  // Playwright's context close can wait indefinitely when no window remains.
  if (process.platform === 'darwin') {
    await Promise.all([application.waitForEvent('close'), application.evaluate(({ app }) => app.quit())]);
  }
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
  await page.getByRole('menuitem', { name: 'New Markdown document', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Untitled.md', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# Saved on close\n');
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  const dialog = page.getByRole('dialog', { name: 'Save changes?' });
  const closed = process.platform === 'darwin' ? page.waitForEvent('close') : application.waitForEvent('close');
  await Promise.all([closed, dialog.getByRole('button', { name: 'Save', exact: true }).click()]);
  expect(await readFile(target, 'utf8')).toBe('# Saved on close\n');
});

test('tabs preserve independent drafts, show blue dots, and save only the active file', async () => {
  const second = path.join(directory, 'second.ts');
  await writeFile(second, 'const original = 1;\n');
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# First draft\n');
  await openSidebarFile('second.ts');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Source editor', exact: true }).fill('const draft = 2;\n');
  const firstTab = page.getByRole('tab', { name: 'sample.md, unsaved changes', exact: true });
  const secondTab = page.getByRole('tab', { name: 'second.ts, unsaved changes', exact: true });
  await expect(firstTab.locator('.unsaved-dot')).toHaveCSS('background-color', 'rgb(37, 99, 235)');
  await expect(secondTab.locator('.unsaved-dot')).toBeVisible();
  await firstTab.click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# First draft\n');
  await saveWithShortcut(file, '# First draft\n');
  expect(await readFile(second, 'utf8')).toBe('const original = 1;\n');
  await expect(page.getByRole('tab', { name: 'sample.md', exact: true })).toBeVisible();
  await expect(secondTab).toBeVisible();
  await secondTab.click();
  await expect(page.getByRole('textbox', { name: 'Source editor', exact: true })).toHaveValue('const draft = 2;\n');
  await openSidebarFile('sample.md');
  await expect(page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab')).toHaveCount(2);
  await page.screenshot({ path: 'tmp/slate-tabs.png' });
});

test('tab menu closes others, honors Cancel, and closes all with explicit discard', async () => {
  const second = path.join(directory, 'second.md');
  await writeFile(second, '# Second\n');
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# First dirty\n');
  await openSidebarFile('second.md');
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
  await expect(page.getByRole('tab', { name: 'Untitled.md', exact: true })).toBeVisible();
  expect(await readFile(file, 'utf8')).toBe(original);
  expect(await readFile(second, 'utf8')).toBe('# Second\n');
});

test('dragging tabs changes their order and restores that order on restart', async () => {
  for (const name of ['second.md', 'third.md']) await writeFile(path.join(directory, name), `# ${name}\n`);
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  for (const name of ['second.md', 'third.md']) await openSidebarFile(name);
  const tablist = page.getByRole('tablist', { name: 'Open documents' });
  await expect(tablist.getByRole('tab')).toHaveText(['sample.md', 'second.md', 'third.md']);
  // Restart immediately after the displayed reorder, even when saving the order is slow.
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
  await openSidebarFile('second.md');
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
  await openSidebarFile('second.md');
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
  await expect(page.getByRole('tab', { name: 'second.md', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: /^sample.md/ }).click();
  await expect(page.getByRole('tab', { name: /^sample.md/ })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => source.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([5, 9]);
});

test('inactive tabs retain external-change detection and prevent overwriting the external file', async () => {
  await writeFile(path.join(directory, 'second.md'), '# Second\n');
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# First draft\n');
  await openSidebarFile('second.md');
  await expect(page.getByRole('tab', { name: 'second.md', exact: true })).toHaveAttribute('aria-selected', 'true');
  await writeFile(file, '# External update\n');
  await page.getByRole('tab', { name: 'sample.md, unsaved changes', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'sample.md, unsaved changes', exact: true })).toHaveAttribute('aria-selected', 'true');
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
  await openSidebarFile('second.ts');
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
  await openSidebarFile('highlight.ts');
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
  await saveWithShortcut(target, code + '// <script> stays literal & unchanged\n');
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
    await openSidebarFile(name);
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
    await openSidebarFile(name);
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
  await saveWithShortcut(path.join(directory, 'guide.md'), '# Draft after rename\n');
  await page.getByRole('textbox', { name: 'Find file by name', exact: true }).fill('guide');
  await expect(page.getByRole('button', { name: /guide.md/ })).toBeVisible();
});

test('a moved file accepts Save immediately when its new path is announced', async () => {
  await mkdir(path.join(directory, 'archive'));
  const content = '# Saved immediately after move\n';
  const result = await page.evaluate(async draft => {
    const bridge = window.slate!;
    const saved = new Promise<Awaited<ReturnType<typeof bridge.save>>>(resolve => {
      const unsubscribe = bridge.onDocument(workspace => {
        unsubscribe();
        const active = workspace.documents.find(item => item.id === workspace.activeId)!;
        void bridge.save(draft, false, { id: active.id, path: active.path }).then(resolve);
      });
    });
    const moved = await bridge.moveEntry('sample.md', 'archive');
    return { moved, saved: await saved };
  }, content);
  expect(result.moved.changed).toBe(true);
  expect(result.saved.canceled).not.toBe(true);
  expect(result.saved.document?.content).toBe(content);
  expect(await readFile(path.join(directory, 'archive', 'sample.md'), 'utf8')).toBe(content);
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
  await expectActiveFileInFolder('sample.md', 'archive');
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# Moved draft\n');
  await saveWithShortcut(target, '# Moved draft\n');
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
  await openSidebarFile('first.md');
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# First draft\n');
  await openSidebarFile('second.ts');
  await page.getByRole('textbox', { name: 'Source editor', exact: true }).fill('const second = 2;\n');
  await page.getByRole('button', { name: 'notes', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename', exact: true });
  await dialog.getByRole('textbox', { name: 'New name', exact: true }).fill('renamed-notes');
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByRole('button', { name: 'renamed-notes', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Source editor', exact: true })).toHaveValue('const second = 2;\n');
  await saveWithShortcut(path.join(directory, 'renamed-notes', 'second.ts'), 'const second = 2;\n');
  await page.getByRole('tab', { name: 'first.md, unsaved changes', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# First draft\n');
  await saveWithShortcut(path.join(directory, 'renamed-notes', 'first.md'), '# First draft\n');
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
  await application.evaluate((_, target) => {
    if (process.platform !== 'win32') return;
    const fs = process.getBuiltinModule('fs/promises');
    const rename = fs.rename;
    let locked = true;
    fs.rename = async (...args) => {
      if (locked && args[1] === target) {
        locked = false;
        throw Object.assign(new Error('Temporary Windows file lock'), { code: 'EPERM' });
      }
      return rename(...args);
    };
  }, path.join(directory, 'sample.ts'));
  await saveWithShortcut(path.join(directory, 'sample.ts'), 'const value = "Keep this";\n');
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
  await saveWithShortcut(path.join(directory, 'created.ts'), 'const created = true;\n');
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
  await expectActiveFileInFolder('sample.md', 'archive');
  await expect(page.getByRole('tab', { name: 'sample.md, unsaved changes', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# Dragged draft\n');
  await saveWithShortcut(path.join(archive, 'sample.md'), '# Dragged draft\n');
  await page.getByRole('button', { name: 'sample.md', exact: true }).dragTo(page.getByLabel('Workspace folder', { exact: true }));
  await expect.poll(() => readFile(file, 'utf8').catch(() => null)).toBe('# Dragged draft\n');
  await expect(readFile(path.join(archive, 'sample.md'), 'utf8')).rejects.toThrow();
  await expect(page.getByRole('button', { name: 'sample.md', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('selected files drag together and keep their open drafts associated with the new paths', async () => {
  const archive = path.join(directory, 'archive');
  await mkdir(archive);
  await writeFile(path.join(directory, 'second.md'), '# Second\n');
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# Unsaved group move\n');
  await page.getByRole('button', { name: 'sample.md', exact: true }).click();
  await page.getByRole('button', { name: 'second.md', exact: true }).click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await expect(page.getByText('2 files selected', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'second.md', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# Unsaved group move\n');
  await page.getByRole('button', { name: 'sample.md', exact: true }).dragTo(page.getByRole('button', { name: 'archive', exact: true }));
  await expect.poll(() => readFile(path.join(archive, 'second.md'), 'utf8').catch(() => null)).toBe('# Second\n');
  await expectActiveFileInFolder('sample.md', 'archive');
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# Unsaved group move\n');
  await saveWithShortcut(path.join(archive, 'sample.md'), '# Unsaved group move\n');
  await expect(readFile(file, 'utf8')).rejects.toThrow();
  await expect(readFile(path.join(directory, 'second.md'), 'utf8')).rejects.toThrow();
});

test('Shift selects a visible range and the context menu moves the selected files', async () => {
  const archive = path.join(directory, 'archive');
  await mkdir(archive);
  for (const name of ['a.md', 'b.md', 'c.md']) await writeFile(path.join(directory, name), `# ${name}\n`);
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await openSidebarFile('a.md');
  await page.getByRole('button', { name: 'c.md', exact: true }).click({ modifiers: ['Shift'] });
  await expect(page.getByText('3 files selected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'b.md', exact: true }).click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await expect(page.getByText('2 files selected', { exact: true })).toBeVisible();
  await application.evaluate(({ dialog }, destination) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] }); }, archive);
  await page.getByRole('button', { name: 'c.md', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move 2 files…', exact: true }).click();
  await expect.poll(() => readFile(path.join(archive, 'c.md'), 'utf8').catch(() => null)).toBe('# c.md\n');
  expect(await readFile(path.join(archive, 'a.md'), 'utf8')).toBe('# a.md\n');
  expect(await readFile(path.join(directory, 'b.md'), 'utf8')).toBe('# b.md\n');
  await expect(page.getByRole('button', { name: 'a.md', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('search-result selection refuses duplicate destination names without moving either file', async () => {
  const archive = path.join(directory, 'archive');
  await mkdir(archive);
  for (const folder of ['one', 'two']) {
    await mkdir(path.join(directory, folder));
    await writeFile(path.join(directory, folder, 'match.md'), `# ${folder}\n`);
  }
  await page.getByRole('textbox', { name: 'Find file by name' }).fill('match.md');
  const matches = page.locator('.file-search-result');
  await expect(matches).toHaveCount(2);
  await matches.nth(0).click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await matches.nth(1).click({ modifiers: ['Shift'] });
  await expect(page.getByText('2 files selected', { exact: true })).toBeVisible();
  await application.evaluate(({ dialog }, destination) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] }); }, archive);
  await page.getByRole('button', { name: 'Move selected files', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'same destination name' })).toBeVisible();
  expect(await readFile(path.join(directory, 'one/match.md'), 'utf8')).toBe('# one\n');
  expect(await readFile(path.join(directory, 'two/match.md'), 'utf8')).toBe('# two\n');
  await expect(readFile(path.join(archive, 'match.md'), 'utf8')).rejects.toThrow();
});

test('a later batch-move failure reports partial progress and preserves the moved tab draft', async () => {
  await mkdir(path.join(directory, 'archive'));
  await writeFile(path.join(directory, 'later.md'), '# Later\n');
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# Preserve my moved draft\n');
  await application.evaluate(() => {
    const fs = process.getBuiltinModule('fs/promises');
    const rename = fs.rename;
    fs.rename = async (...args) => {
      if (process.getBuiltinModule('path').basename(String(args[0])) === 'later.md') throw new Error('Simulated move failure');
      return rename(...args);
    };
  });
  const result = await page.evaluate(() => window.slate!.moveFiles(['sample.md', 'later.md'], 'archive'));
  expect(result).toMatchObject({ changed: true, paths: ['archive/sample.md'], error: 'Moved 1 of 2 files. Simulated move failure' });
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# Preserve my moved draft\n');
  await saveWithShortcut(path.join(directory, 'archive/sample.md'), '# Preserve my moved draft\n');
  expect(await readFile(path.join(directory, 'later.md'), 'utf8')).toBe('# Later\n');
});

test('native file drops copy multiple files into a folder and root without changing open drafts', async () => {
  const incoming = path.join(directory, 'incoming');
  const archive = path.join(directory, 'archive');
  await mkdir(incoming); await mkdir(archive);
  const text = path.join(incoming, 'imported.md');
  const binary = path.join(incoming, 'attachment.pdf');
  const rootFile = path.join(incoming, 'root-copy.txt');
  await writeFile(text, '# Imported\r\n');
  await writeFile(binary, Buffer.from([0, 1, 255, 42]));
  await writeFile(rootFile, 'Copy to root');
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# Keep my draft\n');
  await dropNativeFiles(page.getByRole('button', { name: 'archive', exact: true }), [text, binary]);
  await expect.poll(() => readFile(path.join(archive, 'imported.md'), 'utf8').catch(() => null)).toBe('# Imported\r\n');
  expect(await readFile(path.join(archive, 'attachment.pdf'))).toEqual(await readFile(binary));
  expect(await readFile(text, 'utf8')).toBe('# Imported\r\n');
  await expect(page.getByRole('button', { name: 'imported.md', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'attachment.pdf', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# Keep my draft\n');
  await dropNativeFiles(page.getByLabel('Workspace folder', { exact: true }), [rootFile]);
  await expect.poll(() => readFile(path.join(directory, 'root-copy.txt'), 'utf8').catch(() => null)).toBe('Copy to root');
  expect(await readFile(rootFile, 'utf8')).toBe('Copy to root');
  await expect(page.getByRole('button', { name: 'root-copy.txt', exact: true })).toBeVisible();
  expect(await readFile(file, 'utf8')).toBe(original);
});

test('native file drops refuse existing destination names without replacing either file', async () => {
  const incoming = path.join(directory, 'incoming');
  await mkdir(incoming);
  const source = path.join(incoming, 'sample.md');
  await writeFile(source, '# Incoming copy\n');
  await dropNativeFiles(page.getByLabel('Workspace folder', { exact: true }), [source]);
  await expect(page.getByRole('status').filter({ hasText: 'sample.md already exists' })).toBeVisible();
  expect(await readFile(source, 'utf8')).toBe('# Incoming copy\n');
  expect(await readFile(file, 'utf8')).toBe(original);
});

test('native file drops preserve the scrolled destination and other expanded folders', async () => {
  const incoming = path.join(directory, 'incoming.md');
  await writeFile(incoming, '# Incoming\n');
  await Promise.all(Array.from({ length: 60 }, (_, index) => mkdir(path.join(directory, `folder-${String(index).padStart(2, '0')}`))));
  await mkdir(path.join(directory, 'a-expanded'));
  await writeFile(path.join(directory, 'a-expanded', 'keep-expanded.md'), '# Keep expanded\n');
  await mkdir(path.join(directory, 'z-destination', 'nested'), { recursive: true });
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.getByRole('button', { name: 'a-expanded', exact: true }).click();
  await expect(page.getByRole('button', { name: 'keep-expanded.md', exact: true })).toBeVisible();
  const destination = page.getByRole('button', { name: 'z-destination', exact: true });
  await destination.scrollIntoViewIfNeeded();
  await destination.click();
  const nested = page.getByRole('button', { name: 'nested', exact: true });
  await nested.click();
  await nested.scrollIntoViewIfNeeded();
  const sidebar = page.locator('.folder-sidebar-content');
  const previousScroll = await sidebar.evaluate(element => element.scrollTop);
  expect(previousScroll).toBeGreaterThan(500);
  await dropNativeFiles(nested, [incoming]);
  await expect(page.getByRole('button', { name: 'incoming.md', exact: true })).toHaveCount(2);
  await expect(nested).toBeInViewport();
  expect(await sidebar.evaluate(element => element.scrollTop)).toBeGreaterThan(previousScroll - 40);
  await expect(page.getByRole('button', { name: 'keep-expanded.md', exact: true })).toHaveCount(1);
});

test('dragging a folder moves all children and keeps both open tabs associated with their files', async () => {
  const notes = path.join(directory, 'notes');
  const archive = path.join(directory, 'archive');
  await mkdir(notes); await mkdir(archive);
  await writeFile(path.join(notes, 'one.md'), '# One\n');
  await writeFile(path.join(notes, 'two.ts'), 'const value = 1;\n');
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.getByRole('button', { name: 'notes', exact: true }).click();
  await openSidebarFile('one.md');
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown source' }).fill('# One draft\n');
  await openSidebarFile('two.ts');
  await page.getByRole('textbox', { name: 'Source editor', exact: true }).fill('const value = 2;\n');
  await page.getByRole('button', { name: 'notes', exact: true }).dragTo(page.getByRole('button', { name: 'archive', exact: true }));
  await expect.poll(() => readFile(path.join(archive, 'notes', 'two.ts'), 'utf8').catch(() => null)).toBe('const value = 1;\n');
  await expectActiveFileInFolder('two.ts', 'archive');
  await expect(page.getByRole('textbox', { name: 'Source editor', exact: true })).toHaveValue('const value = 2;\n');
  await saveWithShortcut(path.join(archive, 'notes', 'two.ts'), 'const value = 2;\n');
  await page.getByRole('tab', { name: 'one.md, unsaved changes', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# One draft\n');
  await saveWithShortcut(path.join(archive, 'notes', 'one.md'), '# One draft\n');
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

test('find navigates visual matches, preserves formatting on replace, and undoes Replace All together', async () => {
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown source', exact: true });
  await source.fill('# Search\n\nHello **world** and hello world.\n\n`hello world`\n\n```mermaid\nflowchart LR\n  A[hello world] --> B[End]\n```\n');
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  await application.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('replace')?.click());
  const search = page.getByRole('search', { name: 'Find in document' });
  const query = search.getByRole('textbox', { name: 'Find text', exact: true });
  await expect(query).toBeFocused();
  await search.getByRole('textbox', { name: 'Replace with', exact: true }).focus();
  await application.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('replace')?.click());
  await expect(query).toBeFocused();
  await query.fill('hello world');
  await page.screenshot({ path: 'tmp/slate-find-visual.png' });
  await expect(search.getByRole('status')).toHaveText('1 of 3');
  await expect(page.locator('.document-editor .find-match')).toHaveCount(4); // First match crosses a bold boundary.
  await query.press('Shift+Enter');
  await expect(search.getByRole('status')).toHaveText('3 of 3');
  await query.press('Enter');
  await expect(search.getByRole('status')).toHaveText('1 of 3');
  await search.getByRole('button', { name: 'Match case', exact: true }).click();
  await expect(search.getByRole('status')).toHaveText('1 of 2');
  await search.getByRole('button', { name: 'Match case', exact: true }).click();
  await query.fill('world');
  await search.getByRole('textbox', { name: 'Replace with', exact: true }).fill('earth');
  await search.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(page.locator('.document-editor strong')).toHaveText('earth');
  await expect(search.getByRole('status')).toHaveText('1 of 2');
  await search.getByRole('button', { name: 'Replace all', exact: true }).click();
  await expect(search.getByRole('status')).toHaveText('No matches');
  await expect(search.getByRole('button', { name: 'Replace all', exact: true })).toBeDisabled();
  await query.press('Escape');
  await expect(search).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.document-editor strong')).toHaveText('earth');
  await expect(page.locator('.document-editor p').first()).toHaveText('Hello earth and hello world.');
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await expect(source).toHaveValue(/Hello \*\*earth\*\* and hello world/);
  await expect(source).toHaveValue(/A\[hello world\]/);
  expect(await readFile(file, 'utf8')).toBe(original);
});

test('source find uses literal text, supports deletion and native undo, and clears highlights on close', async () => {
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown source', exact: true });
  const text = '# Source\n\na.b A.B aXb\n\n```mermaid\nflowchart LR\n  A[a.b] --> B[End]\n```\n';
  await source.fill(text);
  await application.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('replace')?.click());
  const search = page.getByRole('search', { name: 'Find in document' });
  const query = search.getByRole('textbox', { name: 'Find text', exact: true });
  await query.fill('a.b');
  await expect(search.getByRole('status')).toHaveText('1 of 3');
  await expect(page.locator('.search-highlights .find-match')).toHaveCount(3);
  await page.screenshot({ path: 'tmp/slate-find-source.png' });
  await search.getByRole('textbox', { name: 'Replace with', exact: true }).fill('$&');
  await search.getByRole('button', { name: 'Replace all', exact: true }).click();
  await expect(source).toHaveValue(text.replace(/a\.b/gi, () => '$&'));
  await query.press('Escape');
  await expect(page.locator('.search-highlights')).toHaveCount(0);
  await source.press('ControlOrMeta+z');
  await expect(source).toHaveValue(text);
  await application.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('replace')?.click());
  await query.fill('a.b');
  await search.getByRole('button', { name: 'Match case', exact: true }).click();
  await expect(search.getByRole('status')).toHaveText('1 of 2');
  await search.getByRole('textbox', { name: 'Replace with', exact: true }).fill('');
  await search.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(source).toHaveValue(text.replace('a.b', ''));
  await expect(search.getByRole('status')).toHaveText('1 of 1');
  await query.fill('not in document');
  await expect(search.getByRole('status')).toHaveText('No matches');
  await expect(search.getByRole('button', { name: 'Replace', exact: true })).toBeDisabled();
});

test('find seeds selected text and updates across tabs and editor views', async () => {
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown source', exact: true });
  await source.fill('# Needle\n\nneedle\n');
  await source.evaluate((element: HTMLTextAreaElement) => { element.focus(); element.setSelectionRange(2, 8); });
  await page.keyboard.press('ControlOrMeta+f');
  const search = page.getByRole('search', { name: 'Find in document' });
  const query = search.getByRole('textbox', { name: 'Find text', exact: true });
  await expect(query).toHaveValue('Needle');
  await expect(search.getByRole('status')).toHaveText('1 of 2');
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  await expect(page.locator('.document-editor .find-match')).toHaveCount(2);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New Markdown document', exact: true }).click();
  await expect(search.getByRole('status')).toHaveText('No matches');
  await expect(page.locator('.document-editor .find-match')).toHaveCount(0);
  await page.getByRole('tab', { name: 'sample.md, unsaved changes', exact: true }).click();
  await expect(search.getByRole('status')).toHaveText('1 of 2');
  await query.press('Escape');
  await expect(page.locator('.document-editor .find-match')).toHaveCount(0);
});

test('find reveals distant matches in source files and keeps replacement local to the active file', async () => {
  const text = 'first needle\n' + 'line\n'.repeat(100) + 'x'.repeat(400) + 'needle';
  await page.evaluate(async text => { await window.slate!.newDocument({ name: 'notes.txt', content: text }); }, text);
  const source = page.getByRole('textbox', { name: 'Source editor', exact: true });
  await expect(source).toHaveValue(text);
  await page.keyboard.press('ControlOrMeta+f');
  const search = page.getByRole('search', { name: 'Find in document' });
  const query = search.getByRole('textbox', { name: 'Find text', exact: true });
  await query.fill('needle');
  await expect(search.getByRole('status')).toHaveText('1 of 2');
  await page.keyboard.press('ControlOrMeta+g');
  await expect(search.getByRole('status')).toHaveText('2 of 2');
  await expect.poll(() => source.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  const mark = page.locator('.search-highlights .find-match-active');
  const bounds = await mark.boundingBox();
  const viewport = await page.locator('.document-scroll').boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(viewport!.y);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport!.y + viewport!.height + 1);
  await query.press('Shift+Enter');
  await expect(search.getByRole('status')).toHaveText('1 of 2');
  await expect.poll(() => source.evaluate(element => element.scrollLeft)).toBeLessThan(100);
  await query.press('Escape');
  expect(await readFile(file, 'utf8')).toBe(original);
});

test('M45 control structures edit simple source, preserve YAML, and restore after restart', async () => {
  const content = await readFile(path.join(process.cwd(), 'tests/fixtures/vigil-1-control-structure.yaml'), 'utf8');
  const target = path.join(directory, 'vigil.yaml');
  await writeFile(target, content);
  await page.evaluate(() => window.slate!.openFile('vigil.yaml'));
  await expect(page.getByRole('tab', { name: 'Visual', exact: true })).toHaveAttribute('data-state', 'active');
  let input = page.getByRole('textbox', { name: 'Control structure source', exact: true, includeHidden: true });
  await expect(input).toHaveValue(/Imagery user \(controller\) -> Mission operations/);
  await expect(input).not.toBeVisible();
  await expect(page.getByRole('group', { name: 'Control structure diagram', exact: true })).toBeVisible();
  await expect(page.locator('.control-preview')).toHaveAttribute('data-diagram-status', 'ready');
  await writeFile('tmp/control-preview.svg', await page.locator('.control-preview .diagram-canvas > svg').evaluate(element => element.outerHTML));
  await page.screenshot({ path: 'tmp/control-structure-editor.png' });
  await expect(page.locator('.control-preview svg .node')).toHaveCount(9);
  await page.keyboard.press('ControlOrMeta+f');
  await expect(page.getByRole('tab', { name: 'Source', exact: true })).toHaveAttribute('data-state', 'active');
  await expect(input).toBeVisible();
  await page.getByRole('textbox', { name: 'Find text', exact: true }).fill('Permission decision');
  await expect(page.getByRole('search', { name: 'Find in document' }).getByRole('status')).toHaveText('1 of 1');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  await expect(input).not.toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Inspect component or connection' })).toHaveCount(0);
  await expect(page.locator('.control-details')).toHaveCount(0);
  await page.getByRole('button', { name: 'Select component Onboard activity control', exact: true }).click();
  await expect(page.locator('.control-details')).toContainText('Health measurement time and validity');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByRole('textbox', { name: 'Component name' }).fill('Onboard controller');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(input).toHaveValue(/Onboard controller process model:/);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(input).toHaveValue(/Onboard activity control process model:/);
  const source = await input.inputValue();
  await page.getByRole('tab', { name: 'Source', exact: true }).click();
  await expect(input).toBeVisible();
  await expect(page.getByRole('group', { name: 'Control structure diagram', exact: true })).not.toBeVisible();
  await input.fill(source.replace('Target, deadline, and image acceptance criteria', 'Revised acquisition request'));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => readFile(target, 'utf8')).toContain('Revised acquisition request');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  const saved = await readFile(target, 'utf8');
  expect(saved).toContain('id: cs-vigil1-10');
  expect(saved).toContain('description:');
  await input.fill(source + '\nBroken ->');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(page.locator('.control-diagnostics')).toContainText('Add a colon');
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  await expect(input).not.toBeVisible();
  await expect(page.getByText('Correct the highlighted source to update the diagram.', { exact: false })).toBeVisible();
  await page.getByRole('tab', { name: 'Source', exact: true }).click();
  expect(await readFile(target, 'utf8')).toBe(saved);
  await input.fill(source.replace('Target, deadline, and image acceptance criteria', 'Revised acquisition request'));
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await restart();
  input = page.getByRole('textbox', { name: 'Control structure source', exact: true, includeHidden: true });
  await expect(input).toHaveValue(/Revised acquisition request/);
  await expect(page.getByRole('group', { name: 'Control structure diagram', exact: true })).toBeVisible();
  await page.screenshot({ path: 'tmp/control-structure-editor.png' });
});

test('control structure Markdown fences render safely and retain their simple source', async () => {
  const source = '# Control loop\n\n```control-structure\nPilot (controller) -> Hoist (actuator): Raise\nHoist -> Pilot: State [feedback]\n```\n';
  await page.evaluate(text => window.slate!.newDocument({ name: 'loop.md', content: text }), source);
  await expect(page.getByRole('img', { name: 'Control structure diagram' })).toBeVisible();
  await expect(page.locator('.control-block .control-preview')).toHaveAttribute('data-diagram-status', 'ready');
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source', exact: true })).toHaveValue(source);
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Control structure diagram' })).toBeVisible();
  const pdf = path.join(directory, 'control-loop.pdf');
  await application.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, pdf);
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: `PDF saved to ${pdf}` })).toBeVisible({ timeout: 30_000 });
  expect((await readFile(pdf)).subarray(0, 5).toString()).toBe('%PDF-');
});

test('new M45 YAML structures support adding and deleting through the diagram toolbar', async () => {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New control structure', exact: true }).click();
  await expect(page.getByRole('tab', { name: /^Untitled\.yaml(?:, unsaved changes)?$/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Source', exact: true })).toHaveAttribute('data-state', 'active');
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Control structure source', exact: true, includeHidden: true });
  await expect(source).toHaveValue(/Pilot \(controller\)/);
  await page.getByRole('button', { name: 'Add component', exact: true }).click();
  await page.getByRole('textbox', { name: 'Component name' }).fill('Monitor');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(source).toHaveValue(/Monitor \(controller\)/);
  await page.getByRole('button', { name: 'Add connection', exact: true }).click();
  const from = page.getByRole('combobox', { name: 'From component', exact: true });
  await from.focus();
  await expect(from).toHaveCSS('border-top-width', '0px');
  await expect(from).toHaveCSS('outline-style', 'none');
  await expect(from.locator('..').locator('svg')).toBeVisible();
  await page.screenshot({ path: 'tmp/control-borderless-select.png' });
  await page.getByRole('combobox', { name: 'From component', exact: true }).selectOption({ label: 'Monitor' });
  await page.getByRole('combobox', { name: 'To component', exact: true }).selectOption({ label: 'Pilot' });
  await page.getByRole('textbox', { name: 'Connection label' }).fill('Restriction');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(source).toHaveValue(/Monitor -> Pilot: Restriction/);
  await page.getByRole('button', { name: 'Select connection Monitor → Pilot: Restriction', exact: true }).click();
  await expect(page.locator('.control-details')).toContainText('Monitor → Pilot');
  await page.getByRole('button', { name: 'Delete connection', exact: true }).click();
  await expect(source).not.toHaveValue(/Monitor -> Pilot/);
  await expect(source).toHaveValue(/Monitor \(controller\)/);
  const target = path.join(directory, 'new.yaml');
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, target);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => readFile(target, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).toContain('Monitor (controller)');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(page.getByRole('tab', { name: 'new.yaml', exact: true })).toBeVisible();
  const { parse } = await import('yaml');
  const saved = parse(await readFile(target, 'utf8'));
  expect(saved.schemaVersion).toBe('m45-control-structure/v1');
  expect(saved.metadata.authoring.source).toContain('Monitor (controller)');
  expect(saved.elements.some((element: { label: string }) => element.label === 'Monitor')).toBe(true);
  await expect(page.getByRole('tab', { name: 'new.yaml', exact: true }).locator('.unsaved-dot')).toHaveCount(0);
  await restart();
  await expect(page.getByRole('button', { name: 'Select component Monitor', exact: true })).toBeVisible();
});


test('control diagram selects parallel arrows by click or keyboard without retaining the Inspect row', async () => {
  const content = 'Pilot (controller) -> Hoist (actuator): Raise\nPilot -> Hoist: Stop\nHoist -> Pilot: State [feedback]\n';
  await page.evaluate(text => window.slate!.newDocument({ name: 'arrows.yaml', content: text }), controlDocument(content));
  const source = page.getByRole('textbox', { name: 'Control structure source', includeHidden: true });
  await expect(page.locator('.control-preview')).toHaveAttribute('data-diagram-status', 'ready');
  await expect(page.getByRole('combobox', { name: 'Inspect component or connection' })).toHaveCount(0);
  await expect(page.locator('.control-details')).toHaveCount(0);
  const raise = page.getByRole('button', { name: 'Select connection Pilot → Hoist: Raise', exact: true });
  const stop = page.getByRole('button', { name: 'Select connection Pilot → Hoist: Stop', exact: true });
  await raise.focus();
  await raise.press('Enter');
  await expect(raise).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.control-details')).toContainText('Raise');
  await expect(source).toHaveValue(content);
  const stopId = await stop.getAttribute('data-diagram-id');
  const hit = page.locator(`.control-connection-hit[data-diagram-id="${stopId}"]`);
  const point = await hit.evaluate((element: SVGPathElement) => {
    const point = element.getPointAtLength(element.getTotalLength() * 0.2);
    const screen = new DOMPoint(point.x, point.y).matrixTransform(element.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(point.x, point.y);
  await expect(stop).toHaveAttribute('aria-pressed', 'true');
  await expect(raise).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.control-details')).toContainText('Stop');
  await page.getByRole('button', { name: 'Delete connection', exact: true }).click();
  await expect(source).toHaveValue(content.replace('Pilot -> Hoist: Stop\n', ''));
  await expect(page.locator('.control-preview')).toHaveAttribute('data-diagram-status', 'ready');
  await expect(page.locator('.control-details')).toHaveCount(0);
  await page.getByRole('button', { name: 'Select component Pilot', exact: true }).click();
  await expect(page.locator('.control-details')).toContainText('Pilot');
  await page.getByRole('button', { name: 'Clear diagram selection', exact: true }).click();
  await expect(page.locator('.control-details')).toHaveCount(0);
  await page.getByRole('button', { name: 'Select component Pilot', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.control-details')).toContainText('Pilot');
  await page.keyboard.press('Escape');
  await expect(page.locator('.control-details')).toHaveCount(0);
  const pilot = page.getByRole('button', { name: 'Select component Pilot', exact: true });
  await expect(pilot).toBeVisible();
  const bounds = (await pilot.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 30, bounds.y + bounds.height / 2 + 30, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('.control-details')).toHaveCount(0);
  await pilot.click();
  await page.getByRole('group', { name: 'Diagram canvas', exact: true }).click({ position: { x: 6, y: 6 } });
  await expect(page.locator('.control-details')).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand control structure', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Select component Pilot', exact: true }).click();
  await page.getByRole('button', { name: 'Collapse control structure', exact: true }).click();
  await expect(page.locator('.control-details')).toContainText('Pilot');
  await page.getByRole('button', { name: 'Clear diagram selection', exact: true }).click();
  await page.screenshot({ path: 'tmp/control-without-inspect.png' });
});

test('control structure canvas fills the available height and responds to window and detail changes', async () => {
  await page.setViewportSize({ width: 1120, height: 1100 });
  const content = await readFile(path.join(process.cwd(), 'tests/fixtures/vigil-1-control-structure.yaml'), 'utf8');
  await page.evaluate(text => window.slate!.newDocument({ name: 'height.yaml', content: text }), content);
  const viewport = page.locator('.control-diagram .diagram-viewport');
  const legend = page.locator('.control-legend');
  const editorArea = page.locator('.document-scroll');
  await expect(page.locator('.control-preview')).toHaveAttribute('data-diagram-status', 'ready');
  await expect.poll(async () => (await viewport.boundingBox())!.height).toBeGreaterThan(650);
  await expect(page.locator('.control-diagram > .control-pane-heading')).toHaveCount(0);
  const initial = (await viewport.boundingBox())!.height;
  async function expectFilled() {
    await expect.poll(async () => {
      const canvas = (await viewport.boundingBox())!;
      const key = (await legend.boundingBox())!;
      return Math.abs(canvas.y + canvas.height - key.y);
    }).toBeLessThan(3);
    await expect.poll(() => editorArea.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThan(3);
  }
  await expectFilled();
  await page.setViewportSize({ width: 1120, height: 1320 });
  await expect.poll(async () => (await viewport.boundingBox())!.height - initial).toBeGreaterThan(210);
  await expectFilled();
  await page.getByRole('button', { name: 'Select component Onboard activity control', exact: true }).click();
  await expect(page.locator('.control-details')).toBeVisible();
  await expect.poll(() => editorArea.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThan(3);
  await expect.poll(async () => (await page.locator('.control-details').boundingBox())!.height).toBeLessThanOrEqual(240);
  await page.getByRole('button', { name: 'Clear diagram selection', exact: true }).click();
  await expectFilled();
  await page.getByRole('tab', { name: 'Source', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Control structure source', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  await expectFilled();
  await page.setViewportSize({ width: 1120, height: 760 });
  await expectFilled();
  await page.screenshot({ path: 'tmp/control-full-height.png' });
});

test('control nodes separate role badges from names and emphasize their own rounded borders', async () => {
  const content = 'Mission operations (controller) -> Payload (process): Acquire\n';
  await page.evaluate(text => window.slate!.newDocument({ name: 'roles.yaml', content: text }), controlDocument(content));
  const controller = page.getByRole('button', { name: 'Select component Mission operations', exact: true });
  const process = page.getByRole('button', { name: 'Select component Payload', exact: true });
  await expect(controller.locator('.control-node-role')).toHaveText('CONTROLLER');
  await expect(controller.locator('.control-node-name')).toHaveText('Mission operations');
  await expect(process.locator('.control-node-role')).toHaveText('PROCESS');
  const role = controller.locator('.control-node-role');
  const name = controller.locator('.control-node-name');
  expect(await role.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeLessThan(await name.evaluate(el => parseFloat(getComputedStyle(el).fontSize)));
  const roleBox = (await role.boundingBox())!;
  const nameBox = (await name.boundingBox())!;
  expect(roleBox.y + roleBox.height).toBeLessThan(nameBox.y);
  const controllerBorder = controller.locator(':scope > rect');
  const color = await controllerBorder.evaluate(el => getComputedStyle(el).stroke);
  await controller.click();
  await expect(controllerBorder).toHaveCSS('stroke', color);
  await expect(controllerBorder).toHaveCSS('stroke-width', '4px');
  await expect(controller).toHaveCSS('outline-style', 'none');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Component name', exact: true })).toHaveValue('Mission operations');
  await page.screenshot({ path: 'tmp/control-role-and-rename.png' });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const processBorder = process.locator(':scope > rect');
  const processColor = await processBorder.evaluate(el => getComputedStyle(el).stroke);
  await process.click();
  await expect(controllerBorder).toHaveCSS('stroke-width', '2px');
  await expect(processBorder).toHaveCSS('stroke', processColor);
  await expect(processBorder).toHaveCSS('stroke-width', '4px');
  expect(processColor).not.toBe(color);
  await page.getByRole('button', { name: 'Clear diagram selection', exact: true }).click();
  await expect(processBorder).toHaveCSS('stroke-width', '2px');
  expect(await sourceText()).toBe(content);
  async function sourceText() { return page.getByRole('textbox', { name: 'Control structure source', includeHidden: true }).inputValue(); }
});

test('control components delete with confirmation and undo restores connections and controller details', async () => {
  const content = 'Pilot (controller) -> Hoist (actuator): Raise\nHoist -> Pilot: State [feedback]\nPilot process model:\n  Load position\n';
  await page.evaluate(text => window.slate!.newDocument({ name: 'delete.yaml', content: text }), controlDocument(content));
  const source = page.getByRole('textbox', { name: 'Control structure source', includeHidden: true });
  const pilot = page.getByRole('button', { name: 'Select component Pilot', exact: true });
  await pilot.click();
  await page.getByRole('button', { name: 'Delete component', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('2 connections');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(source).toHaveValue(content);
  await page.getByRole('button', { name: 'Delete component', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(source).toHaveValue('Hoist (actuator)\n');
  await expect(pilot).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(source).toHaveValue(content);
  await expect(pilot).toBeVisible();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(pilot).toHaveCount(0);
});

for (const format of ['json', 'yaml']) test(`control layout drags, saves, restarts and auto-arranges ${format} files`, async () => {
  const content = format === 'yaml' ? await readFile(path.join(process.cwd(), 'tests/fixtures/vigil-1-control-structure.yaml'), 'utf8') : controlDocument('Pilot (controller) -> Hoist (actuator): Raise\nHoist -> Pilot: State [feedback]\n', 'json');
  const target = path.join(directory, `layout.${format}`);
  await writeFile(target, content);
  await page.evaluate(name => window.slate!.openFile(name), `layout.${format}`);
  let source = page.getByRole('textbox', { name: 'Control structure source', includeHidden: true });
  const name = format === 'yaml' ? 'Imagery user' : 'Pilot';
  let node = page.getByRole('button', { name: `Select component ${name}`, exact: true });
  await expect(node).toBeVisible();
  const original = await source.inputValue();
  const initial = await node.getAttribute('transform');
  const id = await node.getAttribute('data-diagram-id');
  const untouched = page.locator(`.control-connection:not([data-source-id="${id}"]):not([data-target-id="${id}"])`);
  const unchangedPaths = await untouched.evaluateAll(paths => paths.map(p => p.getAttribute('d')));
  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 100, box.y + box.height / 2 + 35, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Auto-arrange', exact: true })).toBeEnabled();
  await expect(node).not.toHaveAttribute('transform', initial!);
  await expect(source).toHaveValue(original);
  const moved = await node.getAttribute('transform');
  // Every incident arrow endpoint must remain on its component's outline.
  const errors = await page.locator('.control-preview .diagram-canvas > svg').evaluate((svg: SVGSVGElement, id) => {
    const node = svg.querySelector<SVGGElement>(`.control-component[data-diagram-id="${id}"]`)!;
    const bounds = node.getBoundingClientRect();
    return [...svg.querySelectorAll<SVGPathElement>('.control-connection')].filter(p => p.dataset.sourceId === id || p.dataset.targetId === id).map(p => {
      const point = p.getPointAtLength(p.dataset.sourceId === id ? 0 : p.getTotalLength());
      const screen = new DOMPoint(point.x, point.y).matrixTransform(p.getScreenCTM()!);
      return Math.min(Math.abs(screen.x - bounds.x), Math.abs(screen.x - bounds.right), Math.abs(screen.y - bounds.y), Math.abs(screen.y - bounds.bottom));
    });
  }, id);
  expect(Math.max(...errors)).toBeLessThan(12);
  expect(await untouched.evaluateAll(paths => paths.map(p => p.getAttribute('d')))).toEqual(unchangedPaths);
  const routes = await page.locator(`.control-connection[data-source-id="${id}"], .control-connection[data-target-id="${id}"]`).evaluateAll(paths => paths.map(path => path.getAttribute('d')!));
  for (const route of routes) {
    expect(route).not.toMatch(/[CQSA]/i);
    const values = route.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    for (let i = 2; i < values.length; i += 2) {
      expect(Math.min(Math.abs(values[i] - values[i - 2]), Math.abs(values[i + 1] - values[i - 1]))).toBeLessThan(0.001);
    }
  }

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Auto-arrange', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(node).toHaveAttribute('transform', moved!);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab', { selected: true }).locator('.unsaved-dot')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await restart();
  node = page.getByRole('button', { name: `Select component ${name}`, exact: true });
  source = page.getByRole('textbox', { name: 'Control structure source', includeHidden: true });
  await expect(node).toHaveAttribute('transform', moved!);
  await expect(source).toHaveValue(original);
  await page.getByRole('button', { name: 'Expand control structure', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: `Select component ${name}`, exact: true })).toHaveAttribute('transform', moved!);
  await page.getByRole('button', { name: 'Collapse control structure', exact: true }).click();
  await page.getByRole('tab', { name: 'Source', exact: true }).click();
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  await expect(node).toHaveAttribute('transform', moved!);
  await page.getByRole('button', { name: 'Auto-arrange', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Auto-arrange', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(node).toHaveAttribute('transform', moved!);
  await page.screenshot({ path: `tmp/control-layout-${format}.png` });
});

test('control toolbar uses compact Lucide icons with accessible names and shadcn tooltips', async () => {
  await page.evaluate(content => window.slate!.newDocument({ name: 'icons.yaml', content }), controlDocument('Pilot (controller) -> Hoist (actuator): Raise\n'));
  const toolbar = page.locator('.control-toolbar');
  for (const name of ['Add component', 'Add connection', 'Rename', 'Delete selection', 'Auto-arrange', 'Undo', 'Redo', 'Syntax help']) {
    const button = toolbar.getByRole('button', { name, exact: true });
    await expect(button.locator('svg.lucide')).toHaveCount(1);
    await expect(button).toHaveText('');
    const box = (await button.boundingBox())!;
    expect(box.width).toBe(32);
  }
  await toolbar.getByRole('button', { name: 'Add component', exact: true }).hover();
  await expect(page.getByRole('tooltip')).toHaveText('Add component');
  await toolbar.getByRole('button', { name: 'Undo', exact: true }).locator('..').hover();
  await expect(page.getByRole('tooltip')).toHaveText('Undo · ⌘ / Ctrl Z');
  await toolbar.getByRole('button', { name: 'Delete selection', exact: true }).locator('..').hover();
  await expect(page.getByRole('tooltip')).toHaveText('Select a component or connection to delete');
  await page.getByRole('button', { name: 'Zoom in diagram', exact: true }).hover();
  await expect(page.getByRole('tooltip')).toHaveText('Zoom in diagram');
  await page.mouse.move(5, 5);
  await page.screenshot({ path: 'tmp/control-icon-toolbar.png' });
});

test('expanded control structures retain editing, source switching, save, and undo', async () => {
  const content = 'Pilot (controller) -> Hoist (actuator): Raise\nHoist -> Pilot: State [feedback]\n';
  const target = path.join(directory, 'expanded.yaml');
  await writeFile(target, controlDocument(content));
  await page.evaluate(() => window.slate!.openFile('expanded.yaml'));
  await page.getByRole('button', { name: 'Expand control structure', exact: true }).click();
  const expanded = page.getByRole('dialog', { name: 'Control structure editor', exact: true });
  await expect(expanded).toBeVisible();
  await expect(expanded.getByText('Live preview', { exact: true })).toHaveCount(0);
  for (const name of ['Add component', 'Add connection', 'Rename', 'Delete selection', 'Auto-arrange', 'Undo', 'Redo', 'Save', 'Syntax help']) {
    await expect(expanded.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expanded.getByRole('button', { name: 'Add component', exact: true }).click();
  const add = page.getByRole('dialog', { name: 'Add component', exact: true });
  await add.getByRole('textbox', { name: 'Component name' }).fill('Observer');
  await add.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(expanded.getByRole('button', { name: 'Select component Observer', exact: true })).toBeVisible();
  await expanded.getByRole('button', { name: 'Select component Observer', exact: true }).click();
  await expanded.getByRole('button', { name: 'Rename', exact: true }).click();
  const rename = page.getByRole('dialog', { name: 'Rename component', exact: true });
  await rename.getByRole('textbox', { name: 'Component name' }).fill('Monitor');
  await rename.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(expanded.getByRole('button', { name: 'Select component Monitor', exact: true })).toBeVisible();
  await expanded.getByRole('button', { name: 'Select component Monitor', exact: true }).click();
  await expanded.getByRole('button', { name: 'Delete component', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete component', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(expanded.getByRole('button', { name: 'Select component Monitor', exact: true })).toHaveCount(0);
  await expanded.getByRole('group', { name: 'Diagram canvas', exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(expanded.getByRole('button', { name: 'Select component Monitor', exact: true })).toBeVisible();
  await expanded.getByRole('tab', { name: 'Source', exact: true }).click();
  const source = expanded.getByRole('textbox', { name: 'Control structure source' });
  await expect(source).toHaveValue(/Monitor \(controller\)/);
  await source.fill((await source.inputValue()) + '# Edited while expanded\n');
  await expanded.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => readFile(target, 'utf8')).toContain('# Edited while expanded');
  await expect(page.getByRole('tablist', { name: 'Open documents', includeHidden: true }).getByRole('tab', { selected: true, includeHidden: true }).locator('.unsaved-dot')).toHaveCount(0);
  await expanded.getByRole('tab', { name: 'Visual', exact: true }).click();
  await expanded.getByRole('button', { name: 'Syntax help', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'M45 control structure syntax', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(expanded).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'M45 control structure syntax', exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'tmp/control-expanded-editor.png' });
  await expanded.getByRole('button', { name: 'Collapse control structure', exact: true }).click();
  await expect(expanded).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Select component Monitor', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Expand control structure', exact: true }).click();
  await expanded.getByRole('group', { name: 'Diagram canvas', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(expanded).toHaveCount(0);
});

test('txt files containing control syntax remain ordinary text', async () => {
  const content = 'Pilot (controller) -> Hoist (actuator): Raise\nHoist -> Pilot: State [feedback]\n';
  const target = path.join(directory, 'notes.txt');
  await writeFile(target, content);
  await page.evaluate(() => window.slate!.openFile('notes.txt'));
  const source = page.getByRole('textbox', { name: 'Source editor', exact: true });
  await expect(source).toHaveValue(content);
  await expect(page.getByRole('tab', { name: 'Visual', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Control structure source', exact: true })).toHaveCount(0);
  await source.fill(content + 'Pilot (');
  await expect(source).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => readFile(target, 'utf8')).toBe(content + 'Pilot (');
  await expect(page.getByRole('tab', { name: 'notes.txt', exact: true }).locator('.unsaved-dot')).toHaveCount(0);
  await restart();
  await expect(page.getByRole('textbox', { name: 'Source editor', exact: true })).toHaveValue(content + 'Pilot (');
  await expect(page.getByRole('tab', { name: 'Visual', exact: true })).toHaveCount(0);
});

test('folder New File creates an M45 YAML structure in the selected folder', async () => {
  await mkdir(path.join(directory, 'structures'));
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.getByRole('button', { name: 'structures', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New File…', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'New File', exact: true });
  await dialog.getByRole('combobox', { name: 'File template' }).selectOption('control');
  await expect(dialog.getByRole('textbox', { name: 'File name', exact: true })).toHaveValue('Untitled.yaml');
  await dialog.getByRole('textbox', { name: 'File name', exact: true }).fill('hoist.yaml');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Control structure source', exact: true })).toHaveValue(/Pilot \(controller\)/);
  await expect(page.getByRole('tab', { name: 'Source', exact: true })).toHaveAttribute('data-state', 'active');
  expect(await readFile(path.join(directory, 'structures/hoist.yaml'), 'utf8')).toContain('Pilot (controller)');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'structures', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New control structure…', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'New File', exact: true });
  await expect(dialog.getByRole('combobox', { name: 'File template' })).toHaveValue('control');
  await dialog.getByRole('textbox', { name: 'File name', exact: true }).fill('hoist.yaml');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('already exists');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'New File', exact: true });
  await dialog.getByRole('combobox', { name: 'File template' }).selectOption('control');
  await dialog.getByRole('textbox', { name: 'File name', exact: true }).fill('root.json');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Control structure source', exact: true })).toBeVisible();
  const saved = JSON.parse(await readFile(path.join(directory, 'root.json'), 'utf8'));
  expect(saved.schemaVersion).toBe('m45-control-structure/v1');
  expect(saved.metadata.authoring.source).toContain('Pilot (controller)');
  expect(saved.title).toBe('root');
});

test('native New Control Structure creates an unsaved YAML source tab', async () => {
  await application.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('new-control-structure')!.click());
  await expect(page.getByRole('tab', { name: /^Untitled\.yaml(?:, unsaved changes)?$/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Source', exact: true })).toHaveAttribute('data-state', 'active');
  await expect(page.getByRole('textbox', { name: 'Control structure source', exact: true })).toHaveValue(/Pilot \(controller\)/);
});
