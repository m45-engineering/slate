// The DOM is a read model. Writes patch source ranges, never serialize the whole file.
type Range = { from: number; openEnd: number; closeStart: number; to: number; empty: boolean };
export type ReqifField = {
  id: string; name: string; kind: string; value: string; node: Element | null;
  displayNode?: Element; datatype?: Element; inherited: boolean; editable: boolean;
  options: { id: string; name: string }[]; selected: string[]; multi: boolean;
};
export type ReqifObject = { id: string; name: string; type: string; node: Element; fields: ReqifField[] };
export type ReqifRow = { key: string; id?: string; label: string; depth: number; ancestors: string[] };
export type ReqifRelation = { id: string; name: string; source: string; target: string };
export type ReqifDocument = {
  source: string; xml: Document; ranges: Map<Element, Range>; title: string;
  objects: Map<string, ReqifObject>; rows: ReqifRow[]; relations: ReqifRelation[]; warnings: string[];
};

const children = (node: Element | undefined | null, name?: string): Element[] =>
  node ? Array.from(node.children).filter(child => !name || child.localName === name) : [];
const child = (node: Element | undefined | null, name: string) => children(node, name)[0];
const ref = (node: Element | undefined | null, wrapper: string) => child(node, wrapper)?.textContent?.trim() ?? '';
const nameOf = (node: Element) => node.getAttribute('LONG-NAME') || node.getAttribute('LONG_NAME') || node.getAttribute('IDENTIFIER') || node.localName;
const kindOf = (node: Element) => node.localName.replace(/^ATTRIBUTE-(?:VALUE|DEFINITION)-/, '').toLowerCase();
const supported = new Set(['string', 'xhtml', 'boolean', 'integer', 'real', 'date', 'enumeration']);
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');

function parseXml(source: string): Document {
  const xml = new DOMParser().parseFromString(source, 'application/xml');
  if (xml.documentElement.localName === 'parsererror' || ['http://www.mozilla.org/newlayout/xml/parsererror.xml', 'http://www.w3.org/1999/xhtml'].some(namespace => xml.getElementsByTagNameNS(namespace, 'parsererror').length)) {
    throw new Error('Invalid XML. Correct the source before opening the visual view.');
  }
  if (xml.doctype) throw new Error('Documents with a DOCTYPE are available in Source view only.');
  return xml;
}

function sourceRanges(xml: Document, source: string): Map<Element, Range> {
  const elements = Array.from(xml.getElementsByTagName('*'));
  const ranges = new Map<Element, Range>();
  const stack: Range[] = [];
  let index = 0;
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[^\s/<>!?]+(?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
  for (const match of source.matchAll(tokens)) {
    const token = match[0];
    if (token.startsWith('<!') || token.startsWith('<?')) continue;
    if (token.startsWith('</')) {
      const range = stack.pop();
      if (!range) throw new Error('Cannot locate the XML source safely.');
      range.closeStart = match.index; range.to = match.index + token.length;
    } else {
      const element = elements[index++];
      if (!element || token.match(/^<([^\s/>]+)/)?.[1] !== element.tagName) throw new Error('Cannot locate the XML source safely.');
      const end = match.index + token.length;
      const range = { from: match.index, openEnd: end, closeStart: end, to: end, empty: /\/\s*>$/.test(token) };
      ranges.set(element, range);
      if (!range.empty) stack.push(range);
    }
  }
  if (index !== elements.length || stack.length) throw new Error('Cannot locate the XML source safely.');
  return ranges;
}

function inner(source: string, ranges: Map<Element, Range>, node?: Element) {
  const range = node && ranges.get(node);
  return range ? source.slice(range.openEnd, range.closeStart) : '';
}

export function isReqifFile(filename: string, source = ''): boolean {
  return /\.reqif(?:\.xml)?$/i.test(filename) || (/\.xml$/i.test(filename) && /<(?:[\w.-]+:)?REQ-IF(?:\s|>)/.test(source));
}

export function readReqif(source: string): ReqifDocument {
  const xml = parseXml(source);
  if (xml.documentElement.localName !== 'REQ-IF') throw new Error('Expected a REQ-IF document. Use Source view to inspect this file.');
  const ranges = sourceRanges(xml, source);
  const content = child(child(xml.documentElement, 'CORE-CONTENT'), 'REQ-IF-CONTENT');
  if (!content) throw new Error('The ReqIF document has no REQ-IF-CONTENT.');
  const warnings = new Set<string>();
  const byId = (nodes: Element[]) => {
    const map = new Map<string, Element>();
    for (const node of nodes) {
      const id = node.getAttribute('IDENTIFIER');
      if (!id || map.has(id)) throw new Error('Missing or duplicate ReqIF identifiers. Use Source view to repair the file.');
      map.set(id, node);
    }
    return map;
  };
  const types = byId(children(child(content, 'SPEC-TYPES')));
  const datatypes = byId(children(child(content, 'DATATYPES')));
  const objects = new Map<string, ReqifObject>();
  for (const [id, node] of byId(children(child(content, 'SPEC-OBJECTS'), 'SPEC-OBJECT'))) {
    const type = types.get(ref(node, 'TYPE'));
    if (!type) warnings.add('Some objects have unresolved types. Their attributes are read-only.');
    const definitions = byId(children(child(type, 'SPEC-ATTRIBUTES')));
    const values = children(child(node, 'VALUES'));
    const used = new Set<Element>();
    const fields: ReqifField[] = [];
    for (const [definitionId, definition] of definitions) {
      const valueNode = values.find(value => ref(value, 'DEFINITION') === definitionId);
      if (valueNode) used.add(valueNode);
      const defaultNode = children(child(definition, 'DEFAULT-VALUE'))[0];
      const value = valueNode ?? defaultNode;
      const kind = kindOf(definition);
      const datatype = datatypes.get(ref(definition, 'TYPE'));
      const options = children(child(datatype, 'SPECIFIED-VALUES'), 'ENUM-VALUE').map(option => ({ id: option.getAttribute('IDENTIFIER') ?? '', name: nameOf(option) }));
      const selected = children(child(value, 'VALUES'), 'ENUM-VALUE-REF').map(option => option.textContent?.trim() ?? '');
      const editable = supported.has(kind) && datatype?.localName === `DATATYPE-DEFINITION-${kind.toUpperCase()}` && (!value || kindOf(value) === kind) && definition.getAttribute('IS-EDITABLE') !== 'false' && node.getAttribute('IS-EDITABLE') !== 'false';
      fields.push({ id: definitionId, name: nameOf(definition), kind, node: valueNode ?? null, displayNode: value, datatype,
        inherited: !valueNode && !!defaultNode, editable, options, selected, multi: definition.getAttribute('MULTI-VALUED') === 'true',
        value: kind === 'xhtml' ? inner(source, ranges, child(value, 'THE-VALUE')) : kind === 'enumeration' ? selected.map(id => options.find(option => option.id === id)?.name ?? id).join(', ') : value?.getAttribute('THE-VALUE') ?? child(value, 'THE-VALUE')?.textContent ?? '',
      });
    }
    for (const value of values.filter(value => !used.has(value))) fields.push({ id: ref(value, 'DEFINITION'), name: ref(value, 'DEFINITION') || value.localName, kind: kindOf(value), value: value.getAttribute('THE-VALUE') ?? value.textContent ?? '', node: value, inherited: false, editable: false, options: [], selected: [], multi: false });
    objects.set(id, { id, node, name: nameOf(node), type: type ? nameOf(type) : ref(node, 'TYPE'), fields });
  }
  const rows: ReqifRow[] = [];
  const referenced = new Set<string>();
  for (const [index, spec] of children(child(content, 'SPECIFICATIONS'), 'SPECIFICATION').entries()) {
    const key = `spec-${index}`;
    rows.push({ key, label: nameOf(spec), depth: 0, ancestors: [] });
    const stack = children(child(spec, 'CHILDREN'), 'SPEC-HIERARCHY').reverse().map(node => ({ node, ancestors: [key] }));
    while (stack.length) {
      const { node, ancestors } = stack.pop()!;
      const id = ref(node, 'OBJECT');
      const key = `row-${rows.length}`;
      const object = objects.get(id);
      if (object) referenced.add(id);
      else warnings.add('Some hierarchy entries refer to missing objects.');
      rows.push({ key, id: object?.id, label: object?.name ?? `Missing object: ${id}`, depth: ancestors.length, ancestors });
      for (const nested of children(child(node, 'CHILDREN'), 'SPEC-HIERARCHY').reverse()) stack.push({ node: nested, ancestors: [...ancestors, key] });
    }
  }
  const unassigned = [...objects.values()].filter(object => !referenced.has(object.id));
  const groupUnassigned = unassigned.length > 0 && rows.length > 0;
  if (groupUnassigned) rows.push({ key: 'unassigned', label: 'Objects outside specifications', depth: 0, ancestors: [] });
  for (const object of unassigned) rows.push({ key: `object-${object.id}`, id: object.id, label: object.name, depth: groupUnassigned ? 1 : 0, ancestors: groupUnassigned ? ['unassigned'] : [] });
  const relations = children(child(content, 'SPEC-RELATIONS'), 'SPEC-RELATION').map(node => ({
    id: node.getAttribute('IDENTIFIER') ?? '', name: node.getAttribute('LONG-NAME') || nameOf(types.get(ref(node, 'TYPE')) ?? node), source: ref(node, 'SOURCE'), target: ref(node, 'TARGET'),
  }));
  const header = child(child(xml.documentElement, 'THE-HEADER'), 'REQ-IF-HEADER');
  return { source, xml, ranges, objects, rows, relations, warnings: [...warnings], title: child(header, 'TITLE')?.textContent || 'Requirements' };
}

type Patch = { from: number; to: number; text: string };
function attributePatch(document: ReqifDocument, node: Element, name: string, value: string): Patch {
  const range = document.ranges.get(node)!;
  const opening = document.source.slice(range.from, range.openEnd);
  const attributes = /([^\s=<>/]+)\s*=\s*("[^"]*"|'[^']*')/g;
  for (const match of opening.matchAll(attributes)) {
    if (match[1] !== name) continue;
    const start = range.from + match.index + match[0].indexOf(match[2]);
    return { from: start + 1, to: start + match[2].length - 1, text: escape(value) };
  }
  const end = range.openEnd - (range.empty ? 2 : 1);
  return { from: end, to: end, text: ` ${name}="${escape(value)}"` };
}

function contentPatch(document: ReqifDocument, node: Element, text: string): Patch {
  const range = document.ranges.get(node)!;
  return range.empty
    ? { from: range.openEnd - 2, to: range.openEnd, text: `>${text}</${node.tagName}>` }
    : { from: range.openEnd, to: range.closeStart, text };
}

function validateField(field: ReqifField, value: string | string[], object: ReqifObject) {
  if (!field.editable) throw new Error(`${field.name} is read-only.`);
  if (field.kind === 'enumeration') {
    if (!Array.isArray(value) || (!field.multi && value.length > 1) || value.some(id => !field.options.some(option => option.id === id))) throw new Error('Choose a declared enumeration value.');
    return;
  }
  if (typeof value !== 'string') throw new Error('Expected a text value.');
  if (field.kind === 'boolean' && !['true', 'false'].includes(value)) throw new Error('Choose true or false.');
  if (field.kind === 'integer' && !/^[+-]?\d+$/.test(value)) throw new Error('Enter a whole number.');
  if (field.kind === 'real' && (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value)))) throw new Error('Enter a finite number.');
  if (['integer', 'real'].includes(field.kind)) {
    for (const bound of ['MIN', 'MAX']) {
      const limit = field.datatype?.getAttribute(bound);
      if (limit !== null && limit !== undefined) {
        const outside = field.kind === 'integer' ? (bound === 'MIN' ? BigInt(value) < BigInt(limit) : BigInt(value) > BigInt(limit)) : (bound === 'MIN' ? Number(value) < Number(limit) : Number(value) > Number(limit));
        if (outside) throw new Error(`Value must be ${bound === 'MIN' ? 'at least' : 'at most'} ${limit}.`);
      }
    }
  }
  const maxLength = field.datatype?.getAttribute('MAX-LENGTH');
  if (field.kind === 'string' && maxLength && [...value].length > Number(maxLength)) throw new Error(`Use at most ${maxLength} characters.`);
  if (field.kind === 'date') {
    const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/);
    const [year, month, day, hour, minute, second, zoneHour = 0, zoneMinute = 0] = parts ? parts.slice(1).map(part => part === undefined ? 0 : Number(part)) : [];
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    if (!parts || month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59 || zoneHour > 14 || zoneMinute > 59 || (zoneHour === 14 && zoneMinute !== 0)) throw new Error('Enter an ISO date and time with a time zone, for example 2026-11-23T12:00:00Z.');
  }
  if (field.kind === 'xhtml') {
    // Parse in the original namespace context, including prefixes declared on ancestors.
    const namespaces = new Map<string, string>();
    for (let node: Element | null = child(field.node, 'THE-VALUE') ?? object.node; node; node = node.parentElement) {
      for (const attr of Array.from(node.attributes)) if ((attr.name === 'xmlns' || attr.name.startsWith('xmlns:')) && !namespaces.has(attr.name)) namespaces.set(attr.name, attr.value);
    }
    const wrapper = `<wrapper ${[...namespaces].map(([key, val]) => `${key}="${escape(val)}"`).join(' ')}>${value}</wrapper>`;
    const xml = parseXml(wrapper);
    const roots = Array.from(xml.documentElement.children);
    if (roots.length !== 1 || roots[0].localName !== 'div' || roots[0].namespaceURI !== 'http://www.w3.org/1999/xhtml') throw new Error('Rich text must contain one XHTML div. Keep its namespace and markup.');
  }
}

export function updateReqifField(document: ReqifDocument, objectId: string, fieldId: string, value: string | string[]): string {
  const object = document.objects.get(objectId);
  const field = object?.fields.find(field => field.id === fieldId);
  if (!object || !field) throw new Error('The selected attribute no longer exists.');
  validateField(field, value, object);
  if (Array.isArray(value) ? JSON.stringify(value) === JSON.stringify(field.selected) : value === field.value) return document.source;
  const patches: Patch[] = [];
  const prefix = object.node.prefix ? `${object.node.prefix}:` : '';
  const tag = (name: string) => `${prefix}${name}`;
  if (field.node) {
    if (field.kind === 'enumeration') {
      const values = child(field.node, 'VALUES');
      const body = (value as string[]).map(id => `<${tag('ENUM-VALUE-REF')}>${escape(id)}</${tag('ENUM-VALUE-REF')}>`).join('');
      if (values) {
        const refs = children(values, 'ENUM-VALUE-REF');
        const selected = value as string[];
        for (const [index, node] of refs.entries()) {
          const range = document.ranges.get(node)!;
          patches.push(index < selected.length ? contentPatch(document, node, escape(selected[index])) : { from: range.from, to: range.to, text: '' });
        }
        if (selected.length > refs.length) {
          const extra = selected.slice(refs.length).map(id => `<${tag('ENUM-VALUE-REF')}>${escape(id)}</${tag('ENUM-VALUE-REF')}>`).join('');
          const range = document.ranges.get(values)!;
          patches.push(range.empty ? contentPatch(document, values, extra) : { from: range.closeStart, to: range.closeStart, text: extra });
        }
      } else {
        const range = document.ranges.get(field.node)!;
        patches.push({ from: range.closeStart, to: range.closeStart, text: `<${tag('VALUES')}>${body}</${tag('VALUES')}>` });
      }
    } else {
      const element = child(field.node, 'THE-VALUE');
      if (element) patches.push(contentPatch(document, element, field.kind === 'xhtml' ? value as string : escape(value as string)));
      else if (field.kind === 'xhtml') throw new Error('Missing THE-VALUE. Repair this rich-text field in Source view.');
      else patches.push(attributePatch(document, field.node, 'THE-VALUE', value as string));
    }
  } else {
    const kind = field.kind.toUpperCase();
    const body = field.kind === 'xhtml' ? `<${tag('THE-VALUE')}>${value}</${tag('THE-VALUE')}>` : field.kind === 'enumeration' ? `<${tag('VALUES')}>${(value as string[]).map(id => `<${tag('ENUM-VALUE-REF')}>${escape(id)}</${tag('ENUM-VALUE-REF')}>`).join('')}</${tag('VALUES')}>` : '';
    const serialized = `<${tag(`ATTRIBUTE-VALUE-${kind}`)}${body || field.kind === 'enumeration' ? '' : ` THE-VALUE="${escape(value as string)}"`}><${tag('DEFINITION')}><${tag(`ATTRIBUTE-DEFINITION-${kind}-REF`)}>${escape(field.id)}</${tag(`ATTRIBUTE-DEFINITION-${kind}-REF`)}></${tag('DEFINITION')}>${body}</${tag(`ATTRIBUTE-VALUE-${kind}`)}>`;
    const values = child(object.node, 'VALUES');
    if (values) {
      const range = document.ranges.get(values)!;
      if (range.empty) patches.push(contentPatch(document, values, serialized));
      else patches.push({ from: range.closeStart, to: range.closeStart, text: serialized });
    } else {
      const range = document.ranges.get(object.node)!;
      patches.push({ from: range.closeStart, to: range.closeStart, text: `<${tag('VALUES')}>${serialized}</${tag('VALUES')}>` });
    }
  }
  patches.push(attributePatch(document, object.node, 'LAST-CHANGE', new Date().toISOString()));
  let next = document.source;
  for (const patch of patches.sort((a, b) => b.from - a.from)) next = next.slice(0, patch.from) + patch.text + next.slice(patch.to);
  readReqif(next);
  return next;
}
