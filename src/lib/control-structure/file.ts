import YAML from 'yaml';
import { CONTROL_EXAMPLE } from './example.ts';
import { retainedLayout, validPosition, type ControlLayout } from './layout.ts';
import { compileAuthoringSource } from './resolve.ts';
import { AUTHORING_VERSION, GRAMMAR_VERSION, emptyIdentity, type AuthoringResult, type IdentityState } from './schema.ts';

type RecordValue = Record<string, unknown>;
type Element = RecordValue & { id: string; label: string; kind: string; annotations?: RecordValue };
type Relationship = Element & { sourceId: string; targetId: string };
type Document = RecordValue & { id: string; title: string; elements: Element[]; relationships: Relationship[]; metadata?: RecordValue };
export type ControlFile = { layout: ControlLayout; source: string; result: AuthoringResult; document: Document; format: 'json' | 'yaml' };
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
const kinds: Record<string, string> = { control: 'control_action', feedback: 'feedback', information: 'data_flow', effect: 'physical_effect', observation: 'other' };

export function createControlFile(title = 'Untitled control structure', format: 'yaml' | 'json' = 'yaml'): string {
  const namespace = crypto.randomUUID();
  const result = compileAuthoringSource(CONTROL_EXAMPLE, emptyIdentity(namespace));
  const document = projectControlDocument(result, {
    schemaVersion: 'm45-control-structure/v1',
    id: `control-${namespace}`,
    title,
    elements: [],
    relationships: [],
    views: [{ id: 'default', layoutKind: 'm45-default', nodes: [], edges: [] }],
  });
  return format === 'json' ? JSON.stringify(document, null, 2) + '\n' : YAML.stringify(document, { lineWidth: 0 });
}

export function isControlFile(filename: string, content: string) {
  return /\.(?:ya?ml|json)$/i.test(filename) && /^\s*(?:schemaVersion:\s*["']?m45-control-structure\/v1|\{\s*"schemaVersion"\s*:\s*"m45-control-structure\/v1")/m.test(content);
}
function identity(value: unknown): IdentityState {
  if (!record(value) || typeof value.namespace !== 'string' || !/^[\w-]+$/.test(value.namespace) || !Number.isSafeInteger(value.nextId) || Number(value.nextId) < 1 || !Array.isArray(value.entries)) throw new Error('Invalid M45 authoring identity. Use Source to inspect the file.');
  const ids = new Set<string>(), keys = new Set<string>();
  for (const entry of value.entries) {
    if (!record(entry) || typeof entry.id !== 'string' || typeof entry.key !== 'string' || !['component', 'connection', 'signal', 'process_model', 'variable', 'control_algorithm'].includes(String(entry.kind)) || !Number.isInteger(entry.from) || !Number.isInteger(entry.to) || Number(entry.from) < 0 || Number(entry.to) < Number(entry.from) || ids.has(entry.id) || keys.has(`${entry.kind}:${entry.key}`)) throw new Error('Invalid or duplicate M45 identity entry. Use Source to inspect the file.');
    const prefix = `cs-${value.namespace}-`;
    const serial = entry.id.slice(prefix.length);
    if (!entry.id.startsWith(prefix) || !/^[1-9][0-9]*$/.test(serial) || Number(serial) >= Number(value.nextId)) throw new Error('Invalid M45 identity sequence. Use Source to inspect the file.');
    ids.add(entry.id); keys.add(`${entry.kind}:${entry.key}`);
  }
  return value as IdentityState;
}

export function readControlFile(filename: string, content: string): ControlFile {
  const format = content.trimStart().startsWith('{') ? 'json' : 'yaml';
  const raw: unknown = format === 'json' ? JSON.parse(content) : YAML.parse(content);
  if (!record(raw) || raw.schemaVersion !== 'm45-control-structure/v1' || typeof raw.id !== 'string' || typeof raw.title !== 'string' || !Array.isArray(raw.elements) || !Array.isArray(raw.relationships)) throw new Error('This is not an M45 control structure document.');
  const ids = new Set<string>();
  for (const item of [...raw.elements, ...raw.relationships]) {
    if (!record(item) || typeof item.id !== 'string' || typeof item.label !== 'string' || typeof item.kind !== 'string' || ids.has(item.id)) throw new Error('The control structure contains an invalid or duplicate record.');
    ids.add(item.id);
  }
  const document = raw as Document;
  const payload = document.metadata?.authoring;
  if (record(payload)) {
    if (payload.version !== AUTHORING_VERSION || payload.grammarVersion !== GRAMMAR_VERSION || typeof payload.source !== 'string') throw new Error('Unsupported M45 authoring version. Use Source to preserve this file.');
    const result = compileAuthoringSource(payload.source, identity(payload.identity));
    if (result.valid && !document.metadata?.slateDraft) {
      const projected = projectControlDocument(result, document);
      const semantics = (doc: Document) => JSON.stringify({
        elements: doc.elements.map(e => [e.id, e.label, e.kind, e.annotations?.authoringDetails ?? null]).sort(),
        relationships: doc.relationships.map(e => [e.id, e.label, e.kind, e.sourceId, e.targetId, e.annotations?.authoringKind]).sort(),
      });
      if (semantics(document) !== semantics(projected)) throw new Error('The stored graph differs from its simple source. Use Source to resolve the mismatch before editing the diagram.');
    }
    const views = Array.isArray(document.views) ? document.views : [];
    const view = views.find(v => record(v) && v.id === 'default') ?? views[0];
    const nodes = record(view) && view.layoutKind === 'manual' && Array.isArray(view.nodes) ? view.nodes : [];
    const layout = Object.fromEntries(nodes.filter(n => record(n) && typeof n.elementId === 'string' && validPosition(n.position)).map(n => {
      const node = n as RecordValue;
      return [node.elementId, { ...(node.position as object), ...(typeof node.width === 'number' ? { width: node.width } : {}), ...(typeof node.height === 'number' ? { height: node.height } : {}) }];
    })) as ControlLayout;
    return { source: payload.source, result, layout: retainedLayout(layout, result), document, format };
  }
  throw new Error('This file has no M45 authored text. Use Source to preserve it, or export its written structure from M45.');
}

function retainedAnnotations(previous: RecordValue | undefined, changed: boolean) {
  const next = { ...previous };
  if (changed) {
    const support: RecordValue = {};
    for (const key of ['sources', 'evidenceIds', 'dslEntities', 'dslConnection', 'authoringInternalEvidence']) {
      if (key in next) { support[key] = next[key]; delete next[key]; }
    }
    if (Object.keys(support).length) next.historicalSupport = [...(Array.isArray(next.historicalSupport) ? next.historicalSupport : []), { reason: 'Authored content changed; this evidence supports the earlier content only.', ...support }];
  }
  return next;
}
export function projectControlDocument(result: AuthoringResult, base: Document): Document {
  const elements = result.graph.components.map(component => {
    const previous = base.elements.find(e => e.id === component.id);
    const details = result.graph.details.filter(d => d.ownerId === component.id);
    const model = details.find(d => d.kind === 'process_model'), algorithm = details.find(d => d.kind === 'control_algorithm');
    const detail = details.length ? { version: 1,
      ...(model ? { processModel: { id: model.id, variables: model.variables.map(v => ({ id: v.id, text: v.text })) } } : {}),
      ...(algorithm ? { controlAlgorithm: { id: algorithm.id, text: algorithm.body } } : {}),
    } : undefined;
    const kind = component.type === 'process' ? 'controlled_process' : component.type ?? 'other';
    const changed = !!previous && (previous.label !== component.name || previous.kind !== kind || JSON.stringify(previous.annotations?.authoringDetails) !== JSON.stringify(detail));
    const annotations = retainedAnnotations(previous?.annotations, changed);
    delete annotations.authoringDetails;
    if (detail) annotations.authoringDetails = detail;
    annotations.authoringUnclassified = !component.type;
    return { ...previous, id: component.id, label: component.name, kind, annotations };
  });
  const relationships = result.graph.connections.map(connection => {
    const previous = base.relationships.find(e => e.id === connection.id);
    const kind = kinds[connection.relationship];
    const changed = !!previous && (previous.label !== connection.label || previous.kind !== kind || previous.sourceId !== connection.sourceId || previous.targetId !== connection.targetId);
    return { ...previous, id: connection.id, label: connection.label, kind, sourceId: connection.sourceId, targetId: connection.targetId,
      annotations: { ...retainedAnnotations(previous?.annotations, changed), authoringKind: connection.relationship } };
  });
  const metadata = { ...base.metadata, authoring: { version: AUTHORING_VERSION, grammarVersion: GRAMMAR_VERSION, source: result.source, identity: result.identity }, lifecycle: result.exportable ? 'authored' : 'draft' };
  delete (metadata as RecordValue).slateDraft;
  const elementIds = new Set(elements.map(e => e.id)), relationshipIds = new Set(relationships.map(e => e.id));
  const views = Array.isArray(base.views) ? base.views.map(view => record(view) ? { ...view,
    ...(Array.isArray(view.nodes) ? { nodes: view.nodes.filter(node => record(node) && elementIds.has(String(node.elementId))) } : {}),
    ...(Array.isArray(view.edges) ? { edges: view.edges.filter(edge => record(edge) && relationshipIds.has(String(edge.relationshipId))) } : {}),
  } : view) : base.views;
  return { ...base, elements, relationships, ...(views ? { views } : {}), metadata };
}

export function writeControlFile(file: ControlFile, source: string, previousIdentity = file.result.identity, layout = file.layout): string {
  let start = 0, end = file.source.length, nextEnd = source.length;
  while (start < end && start < nextEnd && file.source[start] === source[start]) start++;
  while (end > start && nextEnd > start && file.source[end - 1] === source[nextEnd - 1]) { end--; nextEnd--; }
  const result = compileAuthoringSource(source, previousIdentity, [{ from: start, to: end, insert: source.slice(start, nextEnd) }]);
  const positions = retainedLayout(layout, result);
  let base = file.document;
  if (layout !== file.layout) {
    const views = Array.isArray(base.views) ? base.views : [];
    const existing = views.find(v => record(v) && v.id === 'default');
    const view = { ...(record(existing) ? existing : {}), id: 'default', layoutKind: Object.keys(positions).length ? 'manual' : 'm45-default',
      nodes: Object.entries(positions).map(([elementId, p]) => ({ elementId, position: { x: p.x, y: p.y }, ...(p.width ? { width: p.width } : {}), ...(p.height ? { height: p.height } : {}) })), edges: [] };
    base = { ...base, views: [...views.filter(v => !record(v) || v.id !== 'default'), view] };
  }
  const document = result.valid ? projectControlDocument(result, base) : { ...base, metadata: { ...base.metadata, slateDraft: true, authoring: { version: AUTHORING_VERSION, grammarVersion: GRAMMAR_VERSION, source, identity: file.result.identity } } };
  return file.format === 'json' ? JSON.stringify(document, null, 2) + '\n' : YAML.stringify(document, { lineWidth: 0 });
}
