import JSZip from 'jszip';
import { DOMParser, type Element, type Document } from '@xmldom/xmldom';

export type DiagramShape = { id: string; kind: string; elementId: string; geometry: number[]; line: boolean; text: string; parentId: string; first: string; second: string; properties: Record<string, string>; referenceName: string; compartments: { id: string; hiddenIds: string[] }[] };
export type SavedTable = { rowIds: string[]; columns: { id: string; width: number }[] };
export type SavedDiagram = { id: string; name: string; type: string; shapes: DiagramShape[]; supported: boolean; notes: string[]; table?: SavedTable; contextId: string };
export const supportedDiagramTypes = ['SysML Block Definition Diagram', 'SysML Internal Block Diagram', 'SysML Package Diagram', 'Requirement Diagram', 'SysML Use Case Diagram', 'SysML Activity Diagram', 'SysML Sequence Diagram', 'SysML Parametric Diagram', 'SysML State Machine Diagram', 'Profile Diagram', 'Generic Table', 'Verify Requirement Matrix', 'SysML Allocation Matrix'];
const supportedTypes = new Set(supportedDiagramTypes);
const viewContainers = new Set(['mdOwnedViews', 'operands', 'parts', 'regions']);
const supportedShapes = new Set(['DiagramFrame', 'Class', 'Part', 'Port', 'Association', 'Connector', 'Generalization', 'Dependency', 'Realization', 'Abstraction', 'TextBox', 'TextBoxWithIcon', 'Role', 'ConnectorEnd', 'Note', 'NoteAnchor', 'Constraint', 'DiagramShape', 'Package', 'ContainmentLink', 'UseCase', 'Comment', 'Actor', 'Extend', 'Include', 'ObjectNode', 'PseudoNode', 'Bar', 'Decision', 'SignalAction', 'Pin', 'ObjectFlow', 'CallBehaviorAction', 'ControlFlow', 'Swimlane', 'SwimlaneHeader', 'SwimlaneCell', 'OpaqueAction', 'SequenceLifeline', 'LifeLineLine', 'SeqSelfMessage', 'MessageSignature', 'SeqMessage', 'Activation', 'TimeConstraint', 'LostMessage', 'StateInvariant', 'CombinedFragment', 'InteractionOperand', 'Split', 'DurationConstraint', 'InteractionUse', 'DataType', 'Enumeration', 'Tree', 'Interface', 'AssociationTextBox', 'Signal', 'State', 'Region', 'Transition', 'PseudoState', 'Separator', 'ProfileApplication', 'Component', 'InstanceSpecification']);
const children = (e: Element) => Array.from(e.childNodes).filter(n => n.nodeType === 1) as Element[];
const child = (e: Element, name: string) => children(e).find(c => c.localName === name);
const attr = (e: Element | undefined, name: string) => e ? Array.from(e.attributes).find(a => a.localName === name)?.value ?? '' : '';
function xml(text: string): Document {
  if (/<!DOCTYPE\s|<!ENTITY\s/i.test(text)) throw new Error('DTD and entity declarations are not supported.');
  const errors: string[] = [];
  const doc = new DOMParser({ onError: (_level, message) => errors.push(message) }).parseFromString(text, 'application/xml');
  if (errors.length || !doc.documentElement) throw new Error('Invalid diagram XML.');
  return doc;
}
export function diagramLabel(text: string): string {
  if (!text.trimStart().toLowerCase().startsWith('<html')) return text;
  const doc = new DOMParser({ onError: () => {} }).parseFromString(text, 'text/html');
  function read(node: import('@xmldom/xmldom').Node): string {
    if (node.nodeType === 3 || node.nodeType === 4) return node.nodeValue ?? '';
    const name = node.nodeName.toLowerCase();
    if (['script', 'style', 'head'].includes(name)) return '';
    if (name === 'br') return '\n';
    return Array.from(node.childNodes).map(read).join('') + (['p', 'div'].includes(name) ? '\n' : '');
  }
  return read(doc).trim();
}
export async function readSavedDiagrams(bytes: Uint8Array): Promise<SavedDiagram[]> {
  if (bytes.length > 50 * 1024 * 1024) throw new Error('Model archive exceeds 50 MiB.');
  const zip = await JSZip.loadAsync(bytes);
  let total = 0;
  async function read(name: string) {
    const entry = zip.file(name);
    if (!entry) throw new Error(`Missing diagram resource: ${name}`);
    const declared = (entry as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    if (declared > 25 * 1024 * 1024 || total + declared > 50 * 1024 * 1024) throw new Error('Diagram resources exceed the size limit.');
    const data = await entry.async('uint8array');
    total += data.length;
    if (data.length > 25 * 1024 * 1024 || total > 50 * 1024 * 1024) throw new Error('Diagram resources exceed the size limit.');
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  }
  const model = xml(await read('com.nomagic.magicdraw.uml_model.model'));
  const diagrams: SavedDiagram[] = [];
  for (const e of Array.from(model.getElementsByTagName('*'))) {
    if (e.localName !== 'ownedDiagram') continue;
    const representation = Array.from(e.getElementsByTagName('*')).find(n => n.localName === 'DiagramRepresentationObject');
    const type = representation?.getAttribute('type') ?? '';
    const diagram: SavedDiagram = { contextId: e.getAttribute('context') || e.getAttribute('ownerOfDiagram') || '', id: attr(e, 'id'), name: e.getAttribute('name') || 'Unnamed diagram', type, shapes: [], supported: supportedTypes.has(type), notes: [] };
    diagrams.push(diagram);
    if (!diagram.supported) continue;
    if (type === 'Generic Table') {
      const definition = Array.from(model.getElementsByTagName('*')).find(n => n.localName === 'DiagramTable' && n.getAttribute('base_Diagram') === diagram.id);
      if (definition) {
        const values = (name: string) => children(definition).filter(n => n.localName === name).map(n => n.textContent?.trim() ?? '');
        const hidden = new Set(values('hideColumns')), widths = values('columnWidth');
        diagram.table = { rowIds: values('rowElements'), columns: values('columnIds').map((id, i) => ({ id, width: Math.min(600, Math.max(35, Number(widths[i]) || 160)) })).filter(c => !hidden.has(c.id)) };
      } else diagram.notes.push('No saved table definition is present.');
      continue;
    }
    if (type.endsWith('Matrix')) continue; // Rows and relationships are compiled with the semantic model.
    const binary = Array.from(e.getElementsByTagName('*')).find(n => n.localName === 'binaryObject');
    const stream = binary?.getAttribute('streamContentID');
    if (!stream) { diagram.notes.push('No saved layout is present.'); continue; }
    // Native fragments omit the namespace declaration supplied by their container.
    const text = (await read(stream)).replace('<mdOwnedViews>', '<mdOwnedViews xmlns:xmi="http://www.omg.org/XMI">');
    const doc = xml(text);
    function visit(container: Element, parentId: string, depth: number) {
      if (depth > 256) throw new Error('Diagram nesting exceeds 256 levels.');
      for (const node of children(container).filter(n => n.localName === 'mdElement')) {
        const id = attr(node, 'id'), kind = node.getAttribute('elementClass') ?? '';
        const raw = child(node, 'geometry')?.textContent ?? '';
        const geometry = raw.split(/[;,\s]+/).filter(Boolean).map(Number);
        const line = raw.includes(';');
        if (geometry.length && (geometry.some(n => !Number.isFinite(n) || Math.abs(n) > 1000000) || (line ? geometry.length < 4 || geometry.length % 2 !== 0 : geometry.length !== 4 || geometry[2] < 0 || geometry[3] < 0))) {
          diagram.notes.push(`Invalid geometry for ${kind}.`);
        } else if (geometry.length) {
          if (!supportedShapes.has(kind)) diagram.notes.push(`Simplified symbol: ${kind}.`);
          const properties = Object.fromEntries(children(child(node, 'properties') ?? node).filter(n => n.localName === 'mdElement' && child(n, 'propertyID')).map(n => [child(n, 'propertyID')!.textContent ?? '', attr(child(n, 'value'), 'value') || child(n, 'value')?.textContent || 'false']));
          for (const c of children(node)) if (!viewContainers.has(c.localName ?? '') && !['properties', 'compartment'].includes(c.localName ?? '')) properties[c.localName ?? ''] = attr(c, 'value') || attr(c, 'idref') || c.textContent || '';
          const ref = Array.from(node.getElementsByTagName('*')).find(n => n.localName === 'referenceExtension');
          const compartments = children(node).filter(c => c.localName === 'compartment').map(c => ({ id: c.getAttribute('compartmentID') || '', hiddenIds: attr(c, 'value').split('^').filter(Boolean) }));
          diagram.shapes.push({ compartments, properties, referenceName: ref?.getAttribute('referentPath')?.split('::').at(-1) ?? '', id, kind, elementId: attr(child(node, 'elementID'), 'idref') || attr(child(node, 'elementID'), 'href'), geometry, line, text: diagramLabel(child(node, 'text')?.textContent ?? ''), parentId, first: attr(child(node, 'linkFirstEndID'), 'idref'), second: attr(child(node, 'linkSecondEndID'), 'idref') });
        }
        for (const owned of children(node).filter(n => viewContainers.has(n.localName ?? ''))) visit(owned, id, depth + 1);
      }
    }
    visit(doc.documentElement!, '', 0);
    diagram.notes = [...new Set(diagram.notes)];
  }
  return diagrams;
}
