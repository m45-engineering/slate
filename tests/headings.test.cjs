const { test } = require('node:test');
const assert = require('node:assert/strict');

test('heading anchors support punctuation, Unicode, and duplicate names without collisions', async () => {
  const { headingAnchors, headingIndex } = await import('../src/lib/headings.ts');
  const titles = ['Getting Started!', 'Café & 日本語', 'API_v2', 'Repeat', 'Repeat', 'Repeat-1', 'Repeat'];
  assert.deepEqual(headingAnchors(titles), ['getting-started', 'café--日本語', 'api_v2', 'repeat', 'repeat-1', 'repeat-1-1', 'repeat-2']);
  assert.equal(headingIndex(titles, '#caf%C3%A9--%E6%97%A5%E6%9C%AC%E8%AA%9E'), 1);
  assert.equal(headingIndex(titles, '#repeat-1'), 4);
  assert.equal(headingIndex(titles, '#GETTING-STARTED'), 0);
  assert.equal(headingIndex(titles, '#missing'), -1);
  assert.throws(() => headingIndex(titles, '#%zz'), URIError);
});
