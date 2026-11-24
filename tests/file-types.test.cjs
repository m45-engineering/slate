const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isMarkdown, isTextFile, fileLabel } = require('../electron/file-types.cjs');

test('classifies Markdown separately from source and extensionless text on both platforms', () => {
  for (const name of ['README.MD', '/docs/design.markdown', 'C:\\work\\notes.mdown']) {
    assert.equal(isMarkdown(name), true, name);
    assert.equal(isTextFile(name), true, name);
  }
  for (const name of ['component.tsx', 'test.mts', 'page.mdx', 'schema.xmi', 'requirements.reqif', '.env.production', '.gitignore', 'Makefile', 'LICENSE', 'C:\\work\\Dockerfile']) {
    assert.equal(isMarkdown(name), false, name);
    assert.equal(isTextFile(name), true, name);
  }
  for (const name of ['image.png', 'paper.pdf', 'sheet.xlsx', '.DS_Store', 'app.exe']) assert.equal(isTextFile(name), false, name);
  assert.equal(fileLabel('app.ts'), 'TypeScript');
  assert.equal(fileLabel('package.json'), 'JSON');
  assert.equal(fileLabel('README.md'), 'Markdown');
});

test('previews and native documents are openable without being treated as editable text', () => {
  const { isOpenableFile, isReadOnlyFile, isExternalFile, imageMimeType } = require('../electron/file-types.cjs');
  for (const name of ['PLAN.PDF', 'plot.png', 'photo.JPG', 'scan.jpeg', 'picture.webp', 'animation.gif', 'drawing.svg']) {
    assert.equal(isOpenableFile(name), true, name);
    assert.equal(isReadOnlyFile(name), true, name);
    assert.equal(isExternalFile(name), false, name);
  }
  for (const name of ['report.doc', 'report.DOCX', 'macro.docm', 'template.dotx', 'table.xls', 'table.xlsx', 'table.xlsm', 'table.xlsb', 'template.xltx']) {
    assert.equal(isOpenableFile(name), true, name);
    assert.equal(isExternalFile(name), true, name);
    assert.equal(isTextFile(name), false, name);
  }
  assert.equal(imageMimeType('C:\\work\\drawing.SVG'), 'image/svg+xml');
  assert.equal(isOpenableFile('app.exe'), false);
});
