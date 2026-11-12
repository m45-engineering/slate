const { test } = require('node:test');
const assert = require('node:assert/strict');

test('find treats punctuation literally, wraps no matches into an empty list, and preserves Unicode offsets', async () => {
  const { findText } = await import('../src/lib/find.ts');
  assert.deepEqual(findText('a.b aXb a.b', 'a.b'), [{ from: 0, to: 3 }, { from: 8, to: 11 }]);
  assert.deepEqual(findText('aaa', 'aa'), [{ from: 0, to: 2 }]);
  assert.deepEqual(findText('anything', ''), []);
  assert.deepEqual(findText('anything', 'absent'), []);
  assert.deepEqual(findText('İ hello HELLO 😀hello', 'hello'), [{ from: 2, to: 7 }, { from: 8, to: 13 }, { from: 16, to: 21 }]);
  assert.deepEqual(findText('hello HELLO', 'hello', true), [{ from: 0, to: 5 }]);
  assert.deepEqual(findText('$& [x] \\', '$&'), [{ from: 0, to: 2 }]);
});

test('visual find spans formatting but never consumes atoms, blocks, or Mermaid source', async () => {
  const { Schema } = await import('@tiptap/pm/model');
  const { findInDocument } = await import('../src/lib/find.ts');
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' }, paragraph: { content: 'inline*', group: 'block' },
      codeBlock: { content: 'text*', group: 'block', attrs: { language: { default: null } } },
      text: { group: 'inline' }, atom: { group: 'inline', inline: true, atom: true },
    },
    marks: { strong: {} },
  });
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('hel'), schema.text('lo', [schema.mark('strong')])]),
    schema.node('paragraph', null, [schema.text('hel'), schema.node('atom'), schema.text('lo')]),
    schema.node('codeBlock', { language: 'mermaid' }, schema.text('hello')),
    schema.node('codeBlock', { language: 'js' }, schema.text('hello')),
    schema.node('paragraph', null, schema.text('hel')),
    schema.node('paragraph', null, schema.text('lo')),
  ]);
  const matches = findInDocument(doc, 'hello');
  assert.equal(matches.length, 2);
  for (const match of matches) assert.equal(doc.textBetween(match.from, match.to), 'hello');
  assert.equal(matches[0].from, 1);
});
