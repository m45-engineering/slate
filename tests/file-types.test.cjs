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
