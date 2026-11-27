const { test } = require('node:test');
const assert = require('node:assert/strict');

test('diff reconstructs both sources, including Unicode, whitespace, empty and unrelated documents', async () => {
  const { diffText } = await import('../src/lib/text-diff.ts');
  let seed = 123;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const inputs = [['', ''], ['', 'new'], ['old', ''], ['What protects us against this?', 'What protects us against the following failure?'], ['a\n\nb', 'a\n\nb\n'], ['a '.repeat(2000), 'b '.repeat(2000)], ['😀 héllo', '😀 world']];
  for (let index = 0; index < 100; index++) {
    const build = () => Array.from({ length: 40 }, () => ['word', ' ', '\n', '😀', '?', 'changed'][Math.floor(random() * 6)]).join('');
    inputs.push([build(), build()]);
  }
  for (const [before, after] of inputs) {
    const diff = diffText(before, after);
    assert.equal(diff.filter(item => item.kind !== 'added').map(item => item.text).join(''), before);
    assert.equal(diff.filter(item => item.kind !== 'removed').map(item => item.text).join(''), after);
  }
});

test('inline additions map to formatted text without changing the document', async () => {
  const { Schema } = await import('@tiptap/pm/model');
  const { gitDecorations } = await import('../src/lib/git-highlights.ts');
  const schema = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*' }, text: {} }, marks: { strong: {} } });
  const before = schema.node('doc', null, [schema.node('paragraph', null, schema.text('Old question?'))]);
  const after = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('New', [schema.mark('strong')]), schema.text(' question?')])]);
  const json = after.toJSON();
  const decorations = gitDecorations(before, after).find();
  assert.ok(decorations.some(item => item.from === 1 && item.to === 4));
  assert.deepEqual(after.toJSON(), json);
  assert.doesNotThrow(() => gitDecorations(before, schema.node('doc', null, schema.node('paragraph'))));
});
