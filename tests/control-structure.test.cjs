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
  assert.deepEqual(after.document.elements[2].annotations.authoringDetails, original.document.elements[2].annotations.authoringDetails);
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
