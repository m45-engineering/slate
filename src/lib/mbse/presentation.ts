import type { ModelElement, ModelPackage, ModelRelationship } from './model.ts';
import type { DiagramShape } from './diagrams.ts';

export type CellValue = { text: string; elementId?: string };
export function tableCell(column: string, row: ModelElement, bundle: ModelPackage): CellValue[] {
  const key = column.replace('QPROP:Element:', '');
  const elements = new Map(bundle.model.elements.map(e => [e.id, e]));
  const refs = (ids: string[]): CellValue[] => [...new Set(ids)].map(id => ({ text: elements.get(id)?.name || id, elementId: id }));
  if (key === 'name') return [{ text: row.name || row.type.localName, elementId: row.id }];
  if (key === 'APPLIED_STEREOTYPES') return row.stereotypes.map(s => ({ text: s.type.localName }));
  if (key === 'owner') return refs(row.ownerId ? [row.ownerId] : []);
  if (key === 'type') return refs(row.references.filter(r => r.role === 'type').map(r => r.targetId));
  const relationshipColumns: Record<string, readonly [ModelRelationship['kind'], 'sourceIds' | 'targetIds', 'sourceIds' | 'targetIds']> = { SatisfiedBy: ['satisfaction', 'targetIds', 'sourceIds'], VerifiedBy: ['verification', 'targetIds', 'sourceIds'], allocatedTo: ['allocation', 'sourceIds', 'targetIds'], allocatedFrom: ['allocation', 'targetIds', 'sourceIds'] };
  const relationship = relationshipColumns[key];
  if (relationship) {
    const [kind, from, to] = relationship;
    return refs(bundle.model.relationships.filter(r => r.kind === kind && r[from].includes(row.id)).flatMap(r => r[to]));
  }
  const value = row.properties[key] ?? row.stereotypes.map(s => s.properties[key]).find(v => v !== undefined);
  return value === undefined ? [] : [{ text: value }];
}

export const textShapeKinds = new Set(['TextBox', 'TextBoxWithIcon', 'MessageSignature', 'AssociationTextBox']);
export const invisibleShapeKinds = new Set(['Role', 'ConnectorEnd']);
export const frameShapeKinds = new Set(['DiagramFrame', 'Swimlane', 'SwimlaneCell', 'Region', 'CombinedFragment', 'InteractionOperand']);

export function shapeLabel(shape: DiagramShape, elements: Map<string, ModelElement>): string {
  if (shape.text) return shape.text;
  const e = elements.get(shape.elementId);
  if (!e) return shape.referenceName;
  const related = (role: string) => elements.get(e.references.find(r => r.role === role)?.targetId ?? '');
  const typedName = (item: ModelElement) => {
    const typeId = item.references.find(r => r.role === 'type' || r.role === 'classifier')?.targetId;
    return `${item.name}${typeId ? ` : ${elements.get(typeId)?.name || typeId.split('#').at(-1)}` : ''}`;
  };
  if (shape.kind === 'SequenceLifeline') { const represented = related('represents'); return represented ? typedName(represented) : e.name; }
  if (['Part', 'ObjectNode', 'Pin', 'InstanceSpecification'].includes(shape.kind)) return typedName(e);
  if (shape.kind === 'SwimlaneHeader') { const represented = related('represents'); return e.name || (represented ? typedName(represented) : ''); }
  if (shape.kind === 'SignalAction') {
    const triggers = [...elements.values()].filter(c => c.ownerId === e.id && c.type.localName === 'Trigger');
    const names = triggers.map(t => elements.get(t.properties.event)).map(event => event?.name || elements.get(event?.properties.signal ?? '')?.name).filter(Boolean);
    return e.name || related('signal')?.name || names.join(', ');
  }
  if (shape.kind === 'Note') {
    const keys = (shape.properties.elementProperties || '').split(/[,;]/).filter(Boolean).map(k => k.replace('QPROP:Element:', ''));
    if (keys.length) return keys.map(key => {
      const value = e.properties[key] ?? e.stereotypes.map(s => s.properties[key]).find(v => v !== undefined);
      if (value !== undefined) return `${key}: ${value}`;
      const rel = ({tracedFrom:['trace',true],tracedTo:['trace',false],satisfiedBy:['satisfy',true],verifiedBy:['verify',true],refinedBy:['refine',true],allocatedTo:['allocate',false],allocatedFrom:['allocate',true]} as Record<string,[string,boolean]>)[key];
      if (!rel) return `${key}: —`;
      const [kind, reverse] = rel;
      const relations = [...elements.values()].filter(r => r.stereotypes.some(s => s.type.localName.toLowerCase() === kind) || r.type.localName.toLowerCase() === kind);
      const names = relations.filter(r => r.references.some(ref => ref.role === (reverse ? 'supplier' : 'client') && ref.targetId === e.id)).flatMap(r => r.references.filter(ref => ref.role === (reverse ? 'client' : 'supplier')).map(ref => elements.get(ref.targetId)?.name || ref.targetId));
      return `${key}: ${names.join(', ') || '—'}`;
    }).join('\n');
    return e.properties.body || e.stereotypes.map(s=>s.properties.Text).find(Boolean) || e.name;
  }
  if (shape.kind === 'CallBehaviorAction') return e.name || related('behavior')?.name || '';
  if (shape.kind === 'InteractionUse') return related('refersTo')?.name || e.properties.refersTo && elements.get(e.properties.refersTo)?.name || e.name;
  if (shape.kind === 'CombinedFragment') return e.properties.interactionOperator || 'seq';
  if (['StateInvariant', 'InteractionOperand', 'Constraint'].includes(shape.kind)) {
    const descendants = [...elements.values()].filter(c => c.ownerId === e.id);
    const bodies = descendants.flatMap(c => [c, ...[...elements.values()].filter(d => d.ownerId === c.id)]).map(c => c.properties.body || c.properties.value).filter(Boolean);
    return bodies.length ? `{${bodies.join(' ')}}` : e.name;
  }
  if (shape.kind === 'Comment') return e.properties.body || e.name;
  return e.name || e.properties.body || '';
}

/** Cameo routes begin at linkFirstEndID, which is usually the UML target. */
export function arrowAtStart(shape: DiagramShape, shapes: DiagramShape[], elements: Map<string, ModelElement>): boolean {
  const e = elements.get(shape.elementId);
  const targetId = e?.references.find(r => ['target', 'supplier', 'general', 'addition', 'extendedCase'].includes(r.role))?.targetId;
  if (targetId) {
    const first = shapes.find(s => s.id === shape.first), second = shapes.find(s => s.id === shape.second);
    if (first?.elementId === targetId) return true;
    if (second?.elementId === targetId) return false;
  }
  return true;
}

export type DisplayCompartment = { name: string; lines: string[] };

/** Cameo's COMPARTMENT symbol feature stores hidden elements, not visible members.
 * https://jdocs.nomagic.com/2022x_Refresh2/com/nomagic/magicdraw/uml/symbols/reflect/SymbolFeatureTypes.html
 */
export function savedCompartments(shape: DiagramShape, elements: Map<string, ModelElement>, shapes: DiagramShape[] = []): DisplayCompartment[] {
  const definitions: Record<string, [string, string]> = {
    OPERATIONS: ['operations', 'SUPPRESS_CLASS_OPERATIONS'],
    ATTRIBUTES: ['attributes', 'SUPPRESS_CLASS_ATTRIBUTES'],
    COMPARTMENT_ID_VALUES: ['values', 'SUPPRESS_VALUES_COMPARTMENT'],
    COMPARTMENT_ID_PARTS: ['parts', 'SUPPRESS_PARTS_COMPARTMENT'],
    COMPARTMENT_ID_REFERENCES: ['references', 'SUPPRESS_REFERENCES_COMPARTMENT'],
    CONSTRAINTS: ['constraints', 'SUPPRESS_CONSTRAINTS_COMPARTMENT'],
  };
  const children = (id: string) => [...elements.values()].filter(e => e.ownerId === id);
  const typed = (e: ModelElement): string => {
    const ref = e.references.find(r => r.role === 'type');
    const type = ref && elements.get(ref.targetId)?.name;
    return `${e.properties.isDerived === 'true' ? '/' : ''}${e.name}${type ? ` : ${type}` : ''}`;
  };
  const memberLabel = (e: ModelElement): string => {
    if (e.type.localName === 'Operation') {
      const parameters = children(e.id).filter(p => p.type.localName === 'Parameter');
      const result = parameters.find(p => p.properties.direction === 'return');
      const type = result?.references.find(r => r.role === 'type');
      const resultName = type && elements.get(type.targetId)?.name;
      return `${e.name}(${parameters.filter(p => p !== result).map(typed).join(', ')})${resultName ? ` : ${resultName}` : ''}`;
    }
    if (e.type.localName.endsWith('Constraint')) {
      const body = children(e.id).map(c => c.properties.body || c.properties.value).filter(Boolean).join(' ');
      return body ? `{${body}}` : e.name;
    }
    const defaultValue = e.properties['defaultValue.value'];
    return `${typed(e)}${defaultValue !== undefined ? ` = ${defaultValue}` : ''}`;
  };
  if (!['Class', 'DataType', 'Interface', 'Signal', 'Component'].includes(shape.kind)) return [];
  // A property drawn as a role, part, or port already has a place on this diagram.
  const represented = new Set(shapes.filter(s => ['Role', 'Part', 'Port', 'Constraint'].includes(s.kind)).map(s => s.elementId));
  const members = children(shape.elementId).filter(e => !represented.has(e.id));
  const hasStereotype = (e: ModelElement, name: string) => e.stereotypes.some(s => s.type.localName === name);
  const belongs: Record<string, (e: ModelElement) => boolean> = {
    OPERATIONS: e => e.type.localName === 'Operation',
    ATTRIBUTES: e => e.type.localName === 'Property' && !e.stereotypes.some(s => s.type.localName.endsWith('Property')),
    COMPARTMENT_ID_VALUES: e => hasStereotype(e, 'ValueProperty'),
    COMPARTMENT_ID_PARTS: e => hasStereotype(e, 'PartProperty'),
    COMPARTMENT_ID_REFERENCES: e => hasStereotype(e, 'ReferenceProperty'),
    CONSTRAINTS: e => e.type.localName === 'Constraint' || hasStereotype(e, 'ConstraintProperty'),
  };
  return Object.entries(definitions).flatMap(([id, [name, suppress]]) => {
    // An absent override inherits a diagram/profile default we have not imported.
    if (shape.properties[suppress] !== 'false') return [];
    const hidden = new Set(shape.compartments.find(c => c.id === id)?.hiddenIds);
    const lines = members.filter(e => belongs[id](e) && !hidden.has(e.id)).map(memberLabel).filter(Boolean);
    return lines.length ? [{ name, lines }] : [];
  });
}

/** Aggregation is stored on the part-typed property; its diamond belongs at the opposite (whole) end. */
export function associationMarkers(shape: DiagramShape, shapes: DiagramShape[], elements: Map<string, ModelElement>): { start?: string; end?: string } {
  if (shape.kind !== 'Association') return {};
  const marker = (roleId: string) => {
    const role = shapes.find(s => s.id === roleId);
    const aggregation = role && elements.get(role.elementId)?.properties.aggregation;
    return aggregation === 'composite' ? 'model-composition' : aggregation === 'shared' ? 'model-aggregation' : undefined;
  };
  return { start: marker(shape.properties.associationSecondEndID), end: marker(shape.properties.associationFirstEndID) };
}

export function visibleShapes(shapes: DiagramShape[]): DiagramShape[] {
  const byId = new Map(shapes.map(s => [s.id, s]));
  return shapes.filter(s => {
    let ancestor: DiagramShape | undefined = s;
    const visited = new Set<string>();
    while (ancestor && !visited.has(ancestor.id)) {
      if (ancestor.properties.visible === 'false') return false;
      visited.add(ancestor.id);
      ancestor = byId.get(ancestor.parentId);
    }
    return true;
  });
}
