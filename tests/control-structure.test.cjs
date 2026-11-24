const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fixture = fs.readFileSync(require('node:path').join(__dirname, 'fixtures/vigil-1-control-structure.yaml'), 'utf8');
const loop = 'Pilot (controller) -> Hoist (actuator): Raise\nHoist -> Pilot: State [feedback]\n';

test('new M45 documents keep source, graph, identity, and layout in one YAML or JSON file', async () => {
  const { createControlFile, readControlFile, writeControlFile } = await import('../src/lib/control-structure/file.ts');
  const { CONTROL_EXAMPLE } = await import('../src/lib/control-structure/example.ts');
  const ids = new Set();
  for (const format of ['yaml', 'json']) {
    const file = readControlFile(`hoist.${format}`, createControlFile('Hoist', format));
    assert.equal(file.format, format);
    assert.equal(file.source, CONTROL_EXAMPLE);
    assert.equal(file.result.valid, true);
    assert.equal(file.document.schemaVersion, 'm45-control-structure/v1');
    assert.equal(file.document.title, 'Hoist');
    assert.equal(file.document.elements.length, 2);
    assert.equal(file.document.relationships.length, 2);
    assert.equal(file.result.graph.details.length, 2);
    assert.equal(file.document.metadata.lifecycle, 'authored');
    ids.add(file.document.id);
    const pilot = file.result.graph.components.find(component => component.name === 'Pilot');
    const layout = { [pilot.id]: { x: 125, y: 240, width: 180, height: 90 } };
    const editedSource = file.source.replace('Raise / lower / stop', 'Raise / stop');
    const reopened = readControlFile(`hoist.${format}`, writeControlFile(file, editedSource, file.result.identity, layout));
    assert.equal(reopened.source, editedSource);
    assert.deepEqual(reopened.layout, layout);
    assert.equal(reopened.document.id, file.document.id);
    assert.deepEqual(reopened.result.graph.components.map(component => component.id), file.result.graph.components.map(component => component.id));
    assert.equal(reopened.document.relationships[0].label, 'Raise / stop');
  }
  assert.equal(ids.size, 2);
});

test('Vigil-1 YAML opens using its exact M45 source and survives editing with identities and metadata intact', async () => {
  const { readControlFile, writeControlFile } = await import('../src/lib/control-structure/file.ts');
  const original = readControlFile('vigil.yaml', fixture);
  assert.equal(original.result.valid, true);
  assert.equal(original.result.graph.components.length, 9);
  assert.equal(original.result.graph.connections.length, 21);
  assert.equal(original.result.graph.details.length, 2);
  const updated = writeControlFile(original, original.source.replace('Target, deadline, and image acceptance criteria', 'Target, deadline, and acceptance criteria'));
  const after = readControlFile('vigil.yaml', updated);
  assert.deepEqual(after.result.graph.components.map(c => c.id), original.result.graph.components.map(c => c.id));
  assert.deepEqual(after.result.graph.connections.map(c => c.id), original.result.graph.connections.map(c => c.id));
  assert.equal(after.document.description, original.document.description);
  assert.equal(after.document.id, original.document.id);
  assert.equal(after.document.metadata.authoring.authoredTextHash, undefined);
  assert.deepEqual(after.document.elements[2].annotations.authoringDetails.processModel, original.document.elements[2].annotations.authoringDetails.processModel);
  assert.equal(after.document.elements[2].annotations.authoringDetails.controlAlgorithm.text, original.document.elements[2].annotations.authoringDetails.controlAlgorithm.text);
});

test('M45 grammar handles quoted Unicode names, literal blocks, observations, and rejects invalid structures', async () => {
  const { compileAuthoringSource } = await import('../src/lib/control-structure/resolve.ts');
  const source = '"👩‍🚀 Pilot: A" (controller) → Room (process): "hold [control]"\r\n"👩‍🚀 Pilot: A" control algorithm:\r\n  Text -> is literal [feedback].\r\nThermometer measures Room';
  const result = compileAuthoringSource(source);
  assert.equal(result.valid, true);
  assert.equal(result.graph.connections.length, 2);
  assert.equal(result.graph.details[0].body, 'Text -> is literal [feedback].');
  assert.equal(result.graph.connections[1].relationship, 'observation');
  for (const text of [loop + loop, loop + 'Pilot (process)', loop + 'Pilot process model:\n  One\n    Two', 'A -> B -> C: go', 'A (other)']) assert.equal(compileAuthoringSource(text).valid, false, text);
});

test('visual edits preserve unrelated text and controller prose', async () => {
  const { compileAuthoringSource } = await import('../src/lib/control-structure/resolve.ts');
  const { renameComponent } = await import('../src/lib/control-structure/identity.ts');
  const { addVisualComponent, addVisualConnection, deleteVisualConnection } = await import('../src/lib/control-structure/visual-edits.ts');
  const original = compileAuthoringSource('# A heading\n' + loop + 'Pilot control algorithm:\n  Pilot chooses.\n');
  const renamed = renameComponent(original.source, original.identity, 'Pilot', 'Crew');
  assert.ok(renamed.source.includes('  Pilot chooses.'));
  const extra = addVisualComponent(original, 'Observer', 'controller').result;
  const connected = addVisualConnection(extra, { sourceId: extra.graph.components[2].id, targetId: extra.graph.components[0].id, label: 'Review', relationship: 'information' }).result;
  const deleted = deleteVisualConnection(connected, connected.graph.connections[0].id).result;
  assert.equal(deleted.valid, true);
  assert.equal(deleted.graph.components.length, 3);
  assert.ok(deleted.source.startsWith('# A heading'));
});

test('invalid drafts preserve typed text without changing the last valid graph; corrections compile again', async () => {
  const { readControlFile, writeControlFile } = await import('../src/lib/control-structure/file.ts');
  const original = readControlFile('vigil.yaml', fixture);
  const draftText = original.source + '\nBroken ->';
  const draft = readControlFile('vigil.yaml', writeControlFile(original, draftText));
  assert.equal(draft.source, draftText);
  assert.equal(draft.result.valid, false);
  assert.deepEqual(draft.document.elements, original.document.elements);
  const restored = readControlFile('vigil.yaml', writeControlFile(draft, original.source));
  assert.equal(restored.result.valid, true);
  assert.equal(restored.document.metadata.slateDraft, undefined);
});

test('structured files with mismatched text or duplicate records do not silently redraw different semantics', async () => {
  const { readControlFile } = await import('../src/lib/control-structure/file.ts');
  const original = readControlFile('vigil.yaml', fixture);
  const doc = structuredClone(original.document);
  doc.elements[0].label = 'Different';
  assert.throws(() => readControlFile('bad.json', JSON.stringify(doc)), /differs/);
  doc.elements.push(doc.elements[0]);
  assert.throws(() => readControlFile('bad.json', JSON.stringify(doc)), /duplicate/);
});

test('renderer labels and source highlighting escape markup without changing text', async () => {
  const { compileAuthoringSource } = await import('../src/lib/control-structure/resolve.ts');
  const { controlStructureDiagram } = await import('../src/lib/control-structure/diagram.ts');
  const { highlightSource } = await import('../src/lib/syntax-highlight.ts');
  const source = '"<img src=x>" (controller) -> Plant (process): "<script>bad</script>"';
  const graph = controlStructureDiagram(compileAuthoringSource(source));
  assert.ok(!graph.includes('<script>'));
  assert.ok(!graph.includes('<img'));
  const html = highlightSource(source, 'M45 source');
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<script>'));
});

test('YAML rename keeps IDs and moves changed evidence into historical support', async () => {
  const { readControlFile, writeControlFile } = await import('../src/lib/control-structure/file.ts');
  const { renameComponent } = await import('../src/lib/control-structure/identity.ts');
  const original = readControlFile('vigil.yaml', fixture);
  original.document.elements[0].annotations.sources = [{ path: 'evidence.md' }];
  const renamed = renameComponent(original.source, original.result.identity, 'Imagery user', 'Image customer');
  const after = readControlFile('vigil.yaml', writeControlFile(original, renamed.source, renamed.identity));
  assert.deepEqual(after.result.graph.components.map(c => c.id), original.result.graph.components.map(c => c.id));
  assert.deepEqual(after.result.graph.connections.map(c => c.id), original.result.graph.connections.map(c => c.id));
  assert.equal(after.document.elements[0].annotations.sources, undefined);
  assert.equal(after.document.elements[0].annotations.historicalSupport.length, 1);
});

test('structured files without authored text stay in Source rather than inventing identity mappings', async () => {
  const { readControlFile } = await import('../src/lib/control-structure/file.ts');
  assert.throws(() => readControlFile('old.json', JSON.stringify({ schemaVersion: 'm45-control-structure/v1', id: 'old', title: 'Old', elements: [{ id: 'legacy-id', label: 'Pilot', kind: 'controller' }], relationships: [] })), /no M45 authored text/);
});

test('deleting a component removes all its connections and details while preserving other roles, IDs, and prose', async () => {
  const { compileAuthoringSource } = await import('../src/lib/control-structure/resolve.ts');
  const { deleteVisualComponent } = await import('../src/lib/control-structure/visual-edits.ts');
  for (const newline of ['\n', '\r\n']) {
    const source = ['# Keep heading', 'Pilot (controller) -> Hoist (actuator): Raise', 'Hoist -> Pilot: State [feedback]', 'Pilot process model:', '  Load position', 'Pilot control algorithm:', '  Stop on release.', '# Keep comment', 'Observer (sensor)'].join(newline);
    const original = compileAuthoringSource(source);
    const pilot = original.graph.components.find(c => c.name === 'Pilot');
    const removed = deleteVisualComponent(original, pilot.id).result;
    assert.equal(removed.valid, true);
    assert.equal(removed.graph.connections.length, 0);
    assert.equal(removed.graph.details.length, 0);
    assert.ok(!removed.source.includes('Pilot'));
    assert.ok(removed.source.includes('# Keep heading'));
    assert.ok(removed.source.includes('# Keep comment'));
    assert.deepEqual(removed.graph.components.map(c => [c.name, c.type, c.id]).sort(), original.graph.components.filter(c => c.id !== pilot.id).map(c => [c.name, c.type, c.id]).sort());
  }
});

test('layout saves separately from authored text in M45 document views', async () => {
  const { readControlFile, writeControlFile } = await import('../src/lib/control-structure/file.ts');
  for (const [name, content] of [['vigil.yaml', fixture], ['vigil.json', JSON.stringify(readControlFile('vigil.yaml', fixture).document)]]) {
    const file = readControlFile(name, content);
    const first = file.result.graph.components[0];
    const point = { x: -37, y: 214, width: 250, height: 90 };
    const saved = writeControlFile(file, file.source, file.result.identity, { [first.id]: point });
    const restored = readControlFile(name, saved);
    assert.equal(restored.source, file.source);
    assert.deepEqual(restored.layout[restored.result.graph.components[0].id], point);
    assert.deepEqual(restored.result.graph.components.map(c => c.name), file.result.graph.components.map(c => c.name));
    if (restored.document) {
      assert.equal(restored.document.views[0].layoutKind, 'manual');
      assert.deepEqual(restored.document.views[0].nodes[0].position, { x: -37, y: 214 });
    }
    const reset = readControlFile(name, writeControlFile(restored, restored.source, restored.result.identity, {}));
    assert.deepEqual(reset.layout, {});
  }
});

test('M45 routing keeps moved-box connections orthogonal and outside their endpoint boxes', async () => {
  const { getOrthogonalRoute, Position } = await import('../src/lib/control-structure/orthogonal-route.ts');
  const sourceBounds = { x: 150, y: 70, width: 210, height: 100 };
  for (const targetBounds of [
    { x: 700, y: 400, width: 210, height: 100 },
    { x: -400, y: -250, width: 210, height: 100 },
    { x: 170, y: 550, width: 210, height: 100 },
  ]) {
    for (const sourcePosition of Object.values(Position)) for (const targetPosition of Object.values(Position)) {
      const route = getOrthogonalRoute({ sourceX: 0, sourceY: 0, targetX: 0, targetY: 0,
        sourceBounds, targetBounds, sourcePosition, targetPosition,
        sourceAnchorOffset: 24, targetAnchorOffset: -24, routeOffset: 12, labelOffset: 0 });
      assert.ok(route.points.length >= 2);
      assert.ok(Number.isFinite(route.labelX) && Number.isFinite(route.labelY));
      for (let i = 1; i < route.points.length; i++) {
        const a = route.points[i - 1], b = route.points[i];
        assert.ok(a.x === b.x || a.y === b.y, `Diagonal segment: ${JSON.stringify([a, b])}`);
        for (const box of [sourceBounds, targetBounds]) {
          const crosses = a.x === b.x
            ? a.x > box.x && a.x < box.x + box.width && Math.max(a.y, b.y) > box.y && Math.min(a.y, b.y) < box.y + box.height
            : a.y > box.y && a.y < box.y + box.height && Math.max(a.x, b.x) > box.x && Math.min(a.x, b.x) < box.x + box.width;
          assert.ok(!crosses, `Route crosses an endpoint box: ${JSON.stringify(route.points)}`);
        }
      }
    }
  }
});

test('only structured YAML and JSON documents are recognized as control structures', async () => {
  const { isControlFile, createControlFile } = await import('../src/lib/control-structure/file.ts');
  for (const name of ['notes.txt', 'notes.TXT', 'loop.control', 'loop.control.txt', 'loop.md']) {
    assert.equal(isControlFile(name, loop), false);
    assert.equal(isControlFile(name, fixture), false);
  }
  for (const name of ['loop.yaml', 'loop.yml', 'loop.YAML', 'loop.json']) {
    assert.equal(isControlFile(name, loop), false);
    assert.equal(isControlFile(name, fixture), true);
  }
  assert.equal(isControlFile('loop.json', createControlFile('Loop', 'json')), true);
});


test('identified M45 algorithm rules open, retain references through edits, and reject duplicates', async () => {
  const { readControlFile, writeControlFile } = await import('../src/lib/control-structure/file.ts');
  const rulesFixture = fs.readFileSync(require('node:path').join(__dirname, 'fixtures/vigil-1-rule-identities.yaml'), 'utf8');
  const original = readControlFile('vigil.yaml', rulesFixture);
  const rules = original.result.graph.details.find(d => d.kind === 'control_algorithm').rules;
  assert.equal(rules.length, 9);
  assert.deepEqual(rules.map(r => r.id), Array.from({ length: 9 }, (_, i) => `cs-vigil1-${87 + i}`));
  const nextSource = original.source.replace('Preserve source measurement times.', 'Preserve original source measurement times.');
  const after = readControlFile('vigil.yaml', writeControlFile(original, nextSource));
  assert.deepEqual(after.result.graph.details.find(d => d.kind === 'control_algorithm').rules.map(r => r.id), rules.map(r => r.id));
  const document = structuredClone(original.document);
  document.metadata.authoring.identity.entries.push(document.metadata.authoring.identity.entries.find(e => e.kind === 'rule'));
  assert.throws(() => readControlFile('bad.json', JSON.stringify(document)), /duplicate M45 identity/);
});

test('controller item IDs survive reordering, insertion, wording edits, and YAML/JSON reopen', async () => {
  const { readControlFile, writeControlFile } = await import('../src/lib/control-structure/file.ts');
  const content = fs.readFileSync(require('node:path').join(__dirname, 'fixtures/vigil-1-rule-identities.yaml'), 'utf8');
  for (const format of ['yaml', 'json']) {
    const initial = readControlFile('vigil.yaml', content);
    if (format === 'json') initial.format = 'json';
    const algorithm = initial.result.graph.details.find(d => d.kind === 'control_algorithm');
    const model = initial.result.graph.details.find(d => d.kind === 'process_model');
    assert.equal(model.id, 'cs-vigil1-76');
    assert.equal(algorithm.id, 'cs-vigil1-86');
    assert.deepEqual(model.variables.map(v => v.id), Array.from({ length: 9 }, (_, i) => `cs-vigil1-${77 + i}`));
    const edited = initial.source.replace(model.variables[0].text, 'Requested activity and its parameters')
      .replace(algorithm.rules[1].text, 'Preserve original measurement times.');
    // Apply separate wording edits as the editor does, keeping each identity mapping precise.
    const modelEdit = readControlFile(`vigil.${format}`, writeControlFile(initial, initial.source.replace(model.variables[0].text, 'Requested activity and its parameters')));
    const changed = readControlFile(`vigil.${format}`, writeControlFile(modelEdit, edited));
    const changedAlgorithm = changed.result.graph.details.find(d => d.kind === 'control_algorithm');
    assert.deepEqual(changedAlgorithm.rules.map(r => r.id), algorithm.rules.map(r => r.id));
    assert.equal(changed.result.graph.details.find(d => d.kind === 'process_model').variables[0].id, model.variables[0].id);
    const reordered = [...changedAlgorithm.rules].reverse();
    const nextSource = changed.source.slice(0, changedAlgorithm.rules[0].from)
      + reordered.map(r => r.text).join('\n  ') + '\n  Report assessment status.\n';
    const saved = readControlFile(`vigil.${format}`, writeControlFile(changed, nextSource));
    const finalAlgorithm = saved.result.graph.details.find(d => d.kind === 'control_algorithm');
    assert.deepEqual(finalAlgorithm.rules.slice(0, 9).map(r => r.id), reordered.map(r => r.id));
    assert.ok(!algorithm.rules.some(r => r.id === finalAlgorithm.rules[9].id));
    const stored = saved.document.elements.find(e => e.id === 'cs-vigil1-3').annotations.authoringDetails.controlAlgorithm;
    assert.equal(stored.id, algorithm.id);
    assert.equal(stored.text, finalAlgorithm.body);
    assert.deepEqual(stored.rules, finalAlgorithm.rules.map(({ id, text }) => ({ id, text })));
    assert.deepEqual(readControlFile(`vigil.${format}`, writeControlFile(saved, saved.source)).result.identity, saved.result.identity);
  }
});

test('legacy documents gain rule IDs on save without losing the algorithm text or weakening consistency checks', async () => {
  const { readControlFile, writeControlFile } = await import('../src/lib/control-structure/file.ts');
  const legacy = readControlFile('legacy.yaml', fixture);
  const before = legacy.document.elements[2].annotations.authoringDetails.controlAlgorithm;
  assert.equal(before.rules, undefined);
  const saved = readControlFile('legacy.yaml', writeControlFile(legacy, legacy.source));
  const after = saved.document.elements[2].annotations.authoringDetails.controlAlgorithm;
  assert.equal(after.id, before.id);
  assert.equal(after.text, before.text);
  assert.ok(after.rules.length > 0);
  assert.ok(saved.document.metadata.authoring.identity.entries.some(e => e.kind === 'rule'));
  const badLegacy = structuredClone(legacy.document);
  badLegacy.elements[2].annotations.authoringDetails.controlAlgorithm.text = 'Unrelated algorithm.';
  assert.throws(() => readControlFile('bad.json', JSON.stringify(badLegacy)), /differs/);
  for (const field of ['id', 'text']) {
    const bad = structuredClone(saved.document);
    bad.elements[2].annotations.authoringDetails.controlAlgorithm.rules[0][field] = 'forged';
    assert.throws(() => readControlFile('bad.json', JSON.stringify(bad)), /differs/);
  }
});

test('rule identity validation retains duplicate-key, namespace, counter, and kind checks', async () => {
  const { readControlFile } = await import('../src/lib/control-structure/file.ts');
  const content = fs.readFileSync(require('node:path').join(__dirname, 'fixtures/vigil-1-rule-identities.yaml'), 'utf8');
  const initial = readControlFile('vigil.yaml', content).document;
  const mutations = [
    identity => { identity.entries.filter(e => e.kind === 'rule')[1].key = identity.entries.find(e => e.kind === 'rule').key; },
    identity => { identity.entries.find(e => e.kind === 'rule').id = 'cs-other-87'; },
    identity => { identity.nextId = 95; },
    identity => { identity.nextId = 1.5; },
    identity => { identity.namespace = 'invalid namespace'; },
    identity => { identity.entries.find(e => e.kind === 'rule').kind = 'unknown'; },
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(initial);
    mutate(bad.metadata.authoring.identity);
    assert.throws(() => readControlFile('bad.json', JSON.stringify(bad)), /Invalid/);
  }
});

test('saving controller rules preserves unknown metadata at every retained level', async () => {
  const { readControlFile, writeControlFile } = await import('../src/lib/control-structure/file.ts');
  const content = fs.readFileSync(require('node:path').join(__dirname, 'fixtures/vigil-1-rule-identities.yaml'), 'utf8');
  const document = readControlFile('vigil.yaml', content).document;
  const controller = document.elements[2];
  const details = controller.annotations.authoringDetails;
  for (const target of [document, document.metadata, document.metadata.authoring, document.metadata.authoring.identity,
    document.metadata.authoring.identity.entries.find(e => e.kind === 'rule'), controller, controller.annotations,
    details, details.processModel, details.processModel.variables[0], details.controlAlgorithm, details.controlAlgorithm.rules[0]]) {
    target.extension = { note: 'Keep this data', values: [1, 2, 3] };
  }
  const original = readControlFile('vigil.json', JSON.stringify(document));
  const saved = readControlFile('vigil.json', writeControlFile(original, original.source.replace('Preserve source measurement times.', 'Preserve original measurement times.')));
  const expected = structuredClone(document);
  expected.metadata.authoring.source = saved.source;
  expected.metadata.authoring.identity = saved.document.metadata.authoring.identity;
  delete expected.metadata.authoring.authoredTextHash;
  expected.metadata.lifecycle = saved.document.metadata.lifecycle;
  expected.elements[2].annotations.authoringDetails.controlAlgorithm.text = saved.document.elements[2].annotations.authoringDetails.controlAlgorithm.text;
  expected.elements[2].annotations.authoringDetails.controlAlgorithm.rules[1].text = 'Preserve original measurement times. Receiving or rechecking an old measurement does not make it new.';
  for (const value of [saved.document, expected]) {
    value.elements.sort((a, b) => a.id.localeCompare(b.id));
    value.relationships.sort((a, b) => a.id.localeCompare(b.id));
  }
  assert.deepEqual(saved.document, expected);
  assert.deepEqual(saved.result.identity.extension, { note: 'Keep this data', values: [1, 2, 3] });
  assert.deepEqual(saved.result.identity.entries.find(e => e.kind === 'rule').extension, saved.result.identity.extension);
});

test('repeated rules have distinct IDs and deleted IDs are never recycled', async () => {
  const { compileAuthoringSource } = await import('../src/lib/control-structure/resolve.ts');
  const source = 'Pilot (controller)\nPilot control algorithm:\n  Check position.\n  Check position.\n';
  const initial = compileAuthoringSource(source);
  const rules = initial.graph.details[0].rules;
  assert.notEqual(rules[0].id, rules[1].id);
  const removed = compileAuthoringSource('Pilot (controller)\nPilot control algorithm:\n', initial.identity);
  const restored = compileAuthoringSource(source, removed.identity);
  assert.ok(restored.graph.details[0].rules.every(r => !rules.some(old => old.id === r.id)));
});

test('visual edge rename preserves identities, parallel edges, quoting, and unrelated source', async () => {
  const { compileAuthoringSource } = await import('../src/lib/control-structure/resolve.ts');
  const { renameVisualConnection } = await import('../src/lib/control-structure/visual-edits.ts');
  const source = '# Keep this\r\nPilot (controller) -> Hoist (actuator): Raise\r\nPilot -> Hoist: Stop\r\nPilot control algorithm:\r\n  Raise only when permitted.\r\n';
  const original = compileAuthoringSource(source);
  const edge = original.graph.connections[0];
  const renamed = renameVisualConnection(original, edge.id, 'Raise: "carefully" [now]').result;
  assert.equal(renamed.source, source.replace(': Raise\r\n', ': "Raise: \\"carefully\\" [now]"\r\n'));
  assert.equal(renamed.graph.connections[0].id, edge.id);
  assert.equal(renamed.graph.connections[0].signalId, edge.signalId);
  assert.deepEqual(renamed.graph.connections[1], { ...original.graph.connections[1], from: renamed.graph.connections[1].from, to: renamed.graph.connections[1].to, source: renamed.graph.connections[1].source, target: renamed.graph.connections[1].target });
  assert.throws(() => renameVisualConnection(original, edge.id, 'Stop'), /already declared/);
  assert.throws(() => renameVisualConnection(original, edge.id, '  '), /Enter/);
});

test('direct controller editing retains IDs for multiple wording edits and saves complete blocks', async () => {
  const { readControlFile, writeControlFile } = await import('../src/lib/control-structure/file.ts');
  const { editVisualDetail } = await import('../src/lib/control-structure/visual-edits.ts');
  const content = fs.readFileSync(require('node:path').join(__dirname, 'fixtures/vigil-1-rule-identities.yaml'), 'utf8');
  let file = readControlFile('vigil.yaml', content);
  for (const kind of ['process_model', 'control_algorithm']) {
    const detail = file.result.graph.details.find(d => d.kind === kind);
    const body = detail.entries.map((entry, index) => index < 2 ? entry.text + ' Updated.' : entry.text).join('\n');
    const edited = editVisualDetail(file.result, detail.id, body).result;
    const changed = edited.graph.details.find(d => d.kind === kind);
    assert.equal(changed.id, detail.id);
    assert.deepEqual([...changed.variables, ...changed.rules].map(v => v.id), [...detail.variables, ...detail.rules].map(v => v.id));
    file = readControlFile('vigil.yaml', writeControlFile(file, edited.source, edited.identity));
    assert.equal(file.result.graph.details.find(d => d.kind === kind).body, body);
  }
  const model = file.result.graph.details.find(d => d.kind === 'process_model');
  assert.throws(() => editVisualDetail(file.result, model.id, 'Repeated\nRepeated'), /repeated/);
  assert.throws(() => editVisualDetail(file.result, model.id, ''), /Enter/);
});

test('inserting a controller entry cannot steal the identity of retained text', async () => {
  const { compileAuthoringSource } = await import('../src/lib/control-structure/resolve.ts');
  const { editVisualDetail } = await import('../src/lib/control-structure/visual-edits.ts');
  for (const kind of ['process model', 'control algorithm']) {
    const initial = compileAuthoringSource(`Pilot (controller)\nPilot ${kind}:\n  Position\n`);
    const detail = initial.graph.details[0];
    const oldId = [...detail.variables, ...detail.rules][0].id;
    const changed = editVisualDetail(initial, detail.id, 'Mode\nPosition').result.graph.details[0];
    const entries = [...changed.variables, ...changed.rules];
    assert.equal(entries[1].id, oldId);
    assert.notEqual(entries[0].id, oldId);
  }
});

test('identified controller rows edit together, allocate visible IDs, and remove identities without recycling', async () => {
  const { createControllerDraft, addControllerDraftItem, applyControllerDraft } = await import('../src/lib/control-structure/visual-edits.ts');
  const { readControlFile, writeControlFile } = await import('../src/lib/control-structure/file.ts');
  const content = fs.readFileSync(require('node:path').join(__dirname, 'fixtures/vigil-1-rule-identities.yaml'), 'utf8');
  const file = readControlFile('vigil.yaml', content);
  const ownerId = 'cs-vigil1-3';
  let draft = createControllerDraft(file.result, ownerId);
  assert.equal(applyControllerDraft(file.result, ownerId, draft).result.source, file.source);
  const removed = draft.sections.map(section => section.items.at(-1).id);
  for (const section of draft.sections) {
    // Swapping text edits its explicitly identified rows; it must not swap their IDs.
    [section.items[0].text, section.items[1].text] = [section.items[1].text, section.items[0].text];
    section.items.pop();
    draft = addControllerDraftItem(draft, section.kind);
  }
  for (const section of draft.sections) section.items.at(-1).text = section.kind === 'process_model' ? 'New belief' : 'New decision rule.';
  const created = draft.sections.map(section => section.items.at(-1).id);
  const edited = applyControllerDraft(file.result, ownerId, draft).result;
  const saved = readControlFile('vigil.yaml', writeControlFile(file, edited.source, edited.identity));
  for (const section of draft.sections) {
    const detail = saved.result.graph.details.find(d => d.kind === section.kind);
    assert.equal(detail.id, section.id);
    assert.deepEqual([...detail.variables, ...detail.rules].map(({ id, text }) => ({ id, text })), section.items);
  }
  assert.ok(removed.every(id => !saved.result.identity.entries.some(e => e.id === id)));
  assert.ok(created.every(id => saved.result.identity.entries.some(e => e.id === id)));
  const later = addControllerDraftItem(createControllerDraft(saved.result, ownerId), 'control_algorithm');
  assert.ok(!removed.includes(later.sections[1].items.at(-1).id));
});

test('controller row editor creates missing sections and validates entries atomically', async () => {
  const { createControllerDraft, addControllerDraftItem, applyControllerDraft } = await import('../src/lib/control-structure/visual-edits.ts');
  const { compileAuthoringSource } = await import('../src/lib/control-structure/resolve.ts');
  const initial = compileAuthoringSource('Pilot (controller)\n');
  let draft = createControllerDraft(initial, initial.graph.components[0].id);
  draft = addControllerDraftItem(addControllerDraftItem(draft, 'process_model'), 'control_algorithm');
  draft.sections[0].items[0].text = 'Position';
  draft.sections[1].items[0].text = 'Stop on request.';
  const next = applyControllerDraft(initial, initial.graph.components[0].id, draft).result;
  assert.equal(next.graph.details.length, 2);
  assert.equal(new Set(next.identity.entries.map(e => e.id)).size, next.identity.entries.length);
  const cleared = createControllerDraft(next, initial.graph.components[0].id);
  for (const section of cleared.sections) section.items = [];
  const empty = applyControllerDraft(next, initial.graph.components[0].id, cleared).result;
  assert.equal(empty.valid, true);
  assert.ok(empty.identity.entries.every(entry => entry.kind === 'component'));
  assert.equal(empty.identity.nextId, next.identity.nextId);
  draft.sections[1].items[0].text = '';
  assert.throws(() => applyControllerDraft(initial, initial.graph.components[0].id, draft), /Enter a rule/);
  assert.equal(initial.graph.details.length, 0);
});
