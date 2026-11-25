// Ported from M45 control-structure authoring; keep grammar behavior compatible.
import { compileAuthoringSource } from "./resolve.ts"
import { mentionsIn, quoteName } from "./syntax.ts"
import { TYPES, RELATIONSHIPS, type AuthoringResult, type ComponentType, type RelationshipType, type TextEdit } from "./schema.ts"

function editable(result: AuthoringResult) {
  if (!result.valid) throw new Error("Finish correcting the text before changing the diagram.")
}

function value(text: string, field: string) {
  const normalized = text.trim().normalize("NFC")
  if (!normalized) throw new Error(`Enter a ${field}.`)
  return normalized
}

function written(text: string) {
  return /[\r\n]/.test(text) ? JSON.stringify(text) : quoteName(text)
}

function finish(result: AuthoringResult, edits: TextEdit[]) {
  editable(result)
  let source = result.source
  for (const edit of [...edits].sort((a, b) => b.from - a.from)) source = source.slice(0, edit.from) + edit.insert + source.slice(edit.to)
  const next = compileAuthoringSource(source, result.identity, edits)
  if (!next.valid) throw new Error(next.diagnostics.find(d => d.severity === "error")!.message)
  return { edits, result: next }
}

function append(result: AuthoringResult, line: string) {
  const newline = result.source.includes("\r\n") ? "\r\n" : "\n"
  return finish(result, [{ from: result.source.length, to: result.source.length, insert: `${result.source && !result.source.endsWith("\n") ? newline : ""}${line}${newline}` }])
}

export function addVisualComponent(result: AuthoringResult, name: string, type: ComponentType) {
  editable(result)
  const normalized = value(name, "component name")
  if (!TYPES.includes(type)) throw new Error("Choose a component role.")
  if (result.graph.components.some(c => c.name === normalized)) throw new Error("That component name is already in use.")
  return append(result, `${written(normalized)} (${type})`)
}

export function addVisualConnection(result: AuthoringResult, input: { sourceId: string; targetId: string; label: string; relationship: typeof RELATIONSHIPS[number] }) {
  editable(result)
  const source = result.graph.components.find(c => c.id === input.sourceId)
  const target = result.graph.components.find(c => c.id === input.targetId)
  if (!source || !target) throw new Error("Choose both components for the connection.")
  if (source.id === target.id) throw new Error("Choose two different components.")
  if (!RELATIONSHIPS.includes(input.relationship)) throw new Error("Choose a connection kind.")
  const label = value(input.label, "connection label")
  return append(result, `${written(source.name)} -> ${written(target.name)}: ${written(label)}${input.relationship === "control" ? "" : ` [${input.relationship}]`}`)
}

export function renameVisualConnection(result: AuthoringResult, connectionId: string, label: string) {
  editable(result)
  const connection = result.graph.connections.find(c => c.id === connectionId)
  if (!connection) throw new Error("Select a connection to rename it.")
  const token = result.tokens.find(t => t.kind === "label" && t.from >= connection.from && t.to <= connection.to)
  if (!token) throw new Error("Observation labels are fixed by the M45 measures syntax.")
  const original = result.source.slice(token.from, token.to)
  return finish(result, [{ from: token.from + original.length - original.trimStart().length,
    to: token.to - (original.length - original.trimEnd().length), insert: written(value(label, "connection label")) }])
}

export function editVisualComponent(result: AuthoringResult, componentId: string, input: { name: string; type: ComponentType; removeDetails?: boolean }) {
  editable(result)
  const component = result.graph.components.find(c => c.id === componentId)
  if (!component) throw new Error("Select a component to edit it.")
  const name = value(input.name, "component name")
  if (!TYPES.includes(input.type)) throw new Error("Choose a component role.")
  if (result.graph.components.some(c => c.id !== componentId && c.name === name)) throw new Error("That component name is already in use.")
  if (name === component.name && input.type === component.type) return { edits: [], result }
  const removed = result.nodes.filter(node => node.kind !== "connection" && node.kind !== "declaration" && node.owner.name === component.name && input.type !== "controller")
  if (removed.some(node => node.kind !== "connection" && node.kind !== "declaration" && node.body) && !input.removeDetails) {
    throw new Error("Confirm removal of the process model and control algorithm before changing the role.")
  }
  const edits: TextEdit[] = removed.map(node => {
    const end = result.source.indexOf("\n", node.to)
    return { from: node.from, to: end < 0 ? result.source.length : end + 1, insert: "" }
  })
  const mentions = result.nodes.filter(node => !removed.includes(node)).flatMap(mentionsIn).filter(m => m.name === component.name)
  let hasType = false
  for (const mention of mentions) {
    if (name !== component.name) edits.push({ from: mention.from, to: mention.to, insert: written(name) })
    const token = result.tokens.find(t => t.kind === "type" && t.from >= mention.to && !result.source.slice(mention.to, t.from).trim())
    if (token) {
      hasType = true
      if (component.type !== input.type) edits.push({ from: token.from, to: token.to, insert: `(${input.type})` })
    }
  }
  if (!hasType) {
    if (mentions.length) edits.push({ from: mentions[0].to, to: mentions[0].to, insert: ` (${input.type})` })
    else {
      const newline = result.source.includes("\r\n") ? "\r\n" : "\n"
      edits.push({ from: result.source.length, to: result.source.length, insert: `${result.source.endsWith("\n") ? "" : newline}${written(name)} (${input.type})${newline}` })
    }
  }
  const identity = { ...result.identity, entries: result.identity.entries.map(entry => entry.kind === "component" && entry.id === componentId ? { ...entry, key: name } : entry) }
  return finish({ ...result, identity }, edits)
}

export function editVisualConnection(result: AuthoringResult, connectionId: string, input: { sourceId: string; targetId: string; label: string; relationship: RelationshipType }) {
  editable(result)
  const connection = result.graph.connections.find(c => c.id === connectionId)
  const source = result.graph.components.find(c => c.id === input.sourceId)
  const target = result.graph.components.find(c => c.id === input.targetId)
  if (!connection || !source || !target) throw new Error("Choose both components for the connection.")
  if (source.id === target.id) throw new Error("Choose two different components.")
  if (input.relationship !== "observation" && !RELATIONSHIPS.includes(input.relationship)) throw new Error("Choose a connection kind.")
  if (input.relationship === "observation" && (source.type !== "sensor" || target.type !== "process")) throw new Error("An observation must connect a sensor to a process.")
  const label = input.relationship === "observation" ? "Observes" : value(input.label, "connection label")
  if (connection.sourceId === source.id && connection.targetId === target.id && connection.label === label && connection.relationship === input.relationship) return { edits: [], result }
  const endpoint = (component: typeof source) => `${written(component.name)}${component.type ? ` (${component.type})` : ""}`
  const text = input.relationship === "observation" ? `${endpoint(source)} measures ${endpoint(target)}`
    : `${endpoint(source)} -> ${endpoint(target)}: ${written(label)}${input.relationship === "control" ? "" : ` [${input.relationship}]`}`
  // Retargeting must not delete an old endpoint whose only mention was this arrow.
  const remaining = result.nodes.filter(node => node.from !== connection.from).flatMap(mentionsIn)
  const declarations = result.graph.components.filter(c => [connection.sourceId, connection.targetId].includes(c.id) && ![source.id, target.id].includes(c.id))
    .filter(c => !remaining.some(m => m.name === c.name && (!c.type || m.type === c.type))).map(endpoint)
  const newline = result.source.includes("\r\n") ? "\r\n" : "\n"
  const key = `${JSON.stringify([source.id, target.id, input.relationship])}:${label}`
  const identity = { ...result.identity, entries: result.identity.entries.map(entry => entry.kind === "connection" && entry.id === connectionId ? { ...entry, key } : entry) }
  return finish({ ...result, identity }, [{ from: connection.from, to: connection.to, insert: [...declarations, text].join(newline) }])
}

export function editVisualDetail(result: AuthoringResult, detailId: string, body: string) {
  editable(result)
  const detail = result.graph.details.find(d => d.id === detailId)
  if (!detail?.entries.length) throw new Error("Select a controller detail to edit it.")
  const lines = value(body, "controller detail").replace(/\r\n?/g, "\n").split("\n").map(line => line.trim())
  // Separate wording edits retain each entry's identity, even when several
  // lines change in the same dialog submission.
  if (lines.length === detail.entries.length) return finish(result, detail.entries.flatMap((entry, index) =>
    entry.text === lines[index] ? [] : [{ from: entry.from, to: entry.to, insert: lines[index] }]))
  const first = detail.entries[0], last = detail.entries.at(-1)!
  const lineStart = result.source.lastIndexOf("\n", first.from - 1) + 1
  const indent = result.source.slice(lineStart, first.from)
  const newline = result.source.includes("\r\n") ? "\r\n" : "\n"
  return finish(result, [{ from: first.from, to: last.to, insert: lines.join(newline + indent) }])
}

export type ControllerDraft = {
  namespace: string;
  nextId: number;
  sections: Array<{ kind: "process_model" | "control_algorithm"; id?: string; items: Array<{ id: string; text: string }> }>;
}

export function createControllerDraft(result: AuthoringResult, ownerId: string): ControllerDraft {
  return { namespace: result.identity.namespace, nextId: result.identity.nextId, sections: (["process_model", "control_algorithm"] as const).map(kind => {
    const detail = result.graph.details.find(d => d.ownerId === ownerId && d.kind === kind);
    return { kind, id: detail?.id, items: (kind === "process_model" ? detail?.variables : detail?.rules)?.map(({ id, text }) => ({ id, text })) ?? [] };
  }) };
}

export function addControllerDraftItem(draft: ControllerDraft, kind: ControllerDraft["sections"][number]["kind"]): ControllerDraft {
  let nextId = draft.nextId;
  const take = () => `cs-${draft.namespace}-${nextId++}`;
  const sections = draft.sections.map(section => section.kind !== kind ? section : {
    ...section, id: section.id ?? take(), items: [...section.items, { id: take(), text: "" }],
  });
  return { ...draft, nextId, sections };
}

export function applyControllerDraft(result: AuthoringResult, ownerId: string, draft: ControllerDraft) {
  editable(result);
  const owner = result.graph.components.find(c => c.id === ownerId);
  if (!owner || owner.type !== "controller") throw new Error("Select a controller to edit its details.");
  const newline = result.source.includes("\r\n") ? "\r\n" : "\n";
  const edits: TextEdit[] = [], additions: string[] = [];
  const identity = { ...result.identity, nextId: draft.nextId, entries: [...result.identity.entries] };
  for (const section of draft.sections) {
    const detail = result.graph.details.find(d => d.ownerId === ownerId && d.kind === section.kind);
    const items = section.items.map(item => {
      const text = value(item.text, section.kind === "process_model" ? "process-model entry" : "rule");
      if (/[\r\n]/.test(text)) throw new Error("Keep one entry per row. Add another row for a separate entry.");
      return { ...item, text };
    });
    const previousItems = section.kind === "process_model" ? detail?.variables : detail?.rules;
    if (detail && section.id === detail.id && items.length === previousItems?.length && items.every((item, index) =>
      item.id === previousItems[index].id && item.text === previousItems[index].text)) continue;
    const oldIds = new Set([detail?.id, ...(detail?.variables ?? []).map(i => i.id), ...(detail?.rules ?? []).map(i => i.id)]);
    identity.entries = identity.entries.filter(entry => !oldIds.has(entry.id));
    const occurrences = new Map<string, number>();
    if (items.length) {
      if (!section.id) throw new Error("The controller section is missing its identity.");
      identity.entries.push({ ...result.identity.entries.find(entry => entry.id === section.id),
        kind: section.kind, key: `${ownerId}:${section.kind}`, id: section.id, from: 0, to: 0 });
      for (const item of items) {
        const occurrence = (occurrences.get(item.text) ?? 0) + 1;
        occurrences.set(item.text, occurrence);
        const kind = section.kind === "process_model" ? "variable" : "rule";
        const key = `${section.id}:${kind === "variable" ? item.text : JSON.stringify([item.text, occurrence])}`;
        identity.entries.push({ ...result.identity.entries.find(entry => entry.id === item.id), kind, key, id: item.id, from: 0, to: 0 });
      }
    }
    if (detail) {
      const first = detail.entries[0];
      const lineStart = first ? result.source.lastIndexOf("\n", first.from - 1) + 1 : 0;
      const indent = first ? result.source.slice(lineStart, first.from) : "  ";
      edits.push({ from: detail.headerTo, to: detail.entries.at(-1)?.to ?? detail.headerTo, insert: items.length ? newline + items.map(item => indent + item.text).join(newline) : "" });
    } else if (items.length) {
      additions.push(`${written(owner.name)} ${section.kind === "process_model" ? "process model" : "control algorithm"}:${newline}${items.map(item => `  ${item.text}`).join(newline)}`);
    }
  }
  if (additions.length) edits.push({ from: result.source.length, to: result.source.length,
    insert: `${result.source.endsWith("\n") ? "" : newline}${additions.join(newline)}${newline}` });
  return finish({ ...result, identity }, edits);
}

export function deleteVisualConnection(result: AuthoringResult, connectionId: string) {
  editable(result)
  const connection = result.graph.connections.find(c => c.id === connectionId)
  if (!connection) throw new Error("Select a connection to delete it.")
  const remaining = result.nodes.filter(node => node.from !== connection.from).flatMap(mentionsIn)
  const newline = result.source.includes("\r\n") ? "\r\n" : "\n"
  const declarations = result.graph.components.filter(c => c.id === connection.sourceId || c.id === connection.targetId).flatMap(component => {
    const references = remaining.filter(m => m.name === component.name)
    // A removed line may be the only mention or the only declaration of a role.
    if (references.length && (!component.type || references.some(m => m.type === component.type))) return []
    return [`${written(component.name)}${component.type ? ` (${component.type})` : ""}`]
  })
  const lineEnd = result.source.indexOf("\n", connection.to)
  const to = lineEnd < 0 ? result.source.length : lineEnd + 1
  return finish(result, [{ from: connection.from, to, insert: declarations.length ? declarations.join(newline) + (lineEnd < 0 ? "" : newline) : "" }])
}

export function deleteVisualComponent(result: AuthoringResult, componentId: string) {
  editable(result)
  const component = result.graph.components.find(c => c.id === componentId)
  if (!component) throw new Error("Select a component to delete it.")
  const removed = result.nodes.filter(node => mentionsIn(node).some(m => m.name === component.name))
  const remaining = result.nodes.filter(node => !removed.includes(node)).flatMap(mentionsIn)
  const newline = result.source.includes("\r\n") ? "\r\n" : "\n"
  const declarations = result.graph.components.filter(c => c.id !== componentId).flatMap(c => {
    const references = remaining.filter(m => m.name === c.name)
    if (references.length && (!c.type || references.some(m => m.type === c.type))) return []
    return [`${written(c.name)}${c.type ? ` (${c.type})` : ""}`]
  })
  const edits = removed.map((node, index) => {
    const end = result.source.indexOf("\n", node.to)
    return { from: node.from, to: end < 0 ? result.source.length : end + 1,
      insert: index === 0 && declarations.length ? declarations.join(newline) + newline : "" }
  })
  return finish(result, edits)
}
