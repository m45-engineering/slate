const { test } = require('node:test');
const assert = require('node:assert/strict');
const { syntaxLanguage } = require('../electron/file-types.cjs');

const plainText = html => html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

test('syntax mapping covers code, structured data, and extensionless build files', async () => {
  const { highlightSource } = await import('../src/lib/syntax-highlight.ts');
  for (const [filename, language] of [
    ['APP.TSX', 'typescript'], ['app.mjs', 'javascript'], ['settings.json', 'json'],
    ['schema.reqif', 'xml'], ['model.xmi', 'xml'], ['icon.svg', 'xml'],
    ['config.yaml', 'yaml'], ['query.sql', 'sql'], ['main.h', 'c'], ['main.hpp', 'cpp'],
    ['tool.py', 'python'], ['build.sh', 'bash'], ['run.ps1', 'powershell'],
    ['Dockerfile', 'dockerfile'], ['Makefile', 'makefile'], ['.env.local', 'ini'],
    ['Cargo.toml', 'ini'], ['change.patch', 'diff'], ['api.proto', 'protobuf'],
  ]) {
    assert.equal(syntaxLanguage(filename), language, filename);
    assert.notEqual(highlightSource('example\n', filename), null, filename);
  }
  assert.equal(syntaxLanguage('notes.txt'), null);
  assert.equal(syntaxLanguage('data.csv'), null);
});

test('highlighting preserves exact text and escapes markup in incomplete code', async () => {
  const { highlightSource } = await import('../src/lib/syntax-highlight.ts');
  const sources = [
    ['app.tsx', '// Comment\nexport const View = () => <div title="hello">{`a & b`}</div>;\n\t  '],
    ['page.html', '<script>window.test = true</script><img src="x" onerror="alert(1)">\n'],
    ['script.py', 'def greet(name):\n\treturn "hello" + name\n'],
    ['settings.json', '{ "unfinished": [1, true,'],
  ];
  for (const [filename, source] of sources) {
    const html = highlightSource(source, filename);
    assert.notEqual(html, null, filename);
    assert.equal(plainText(html), source, filename);
    assert.doesNotMatch(html, /<(?:script|img|div)\b/i, filename);
  }
  assert.match(highlightSource('const value = "hello"; // comment\n', 'app.ts'), /hljs-keyword/);
  assert.match(highlightSource('const value = "hello"; // comment\n', 'app.ts'), /hljs-string/);
  assert.match(highlightSource('const value = "hello"; // comment\n', 'app.ts'), /hljs-comment/);
});

test('plain text and very large files retain the ordinary readable editor', async () => {
  const { highlightSource, MAX_HIGHLIGHT_CHARACTERS } = await import('../src/lib/syntax-highlight.ts');
  assert.equal(highlightSource('const value = 1;', 'notes.txt'), null);
  assert.equal(highlightSource('x'.repeat(MAX_HIGHLIGHT_CHARACTERS + 1), 'app.ts'), null);
});
