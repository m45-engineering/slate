// Ported from M45 control-structure authoring; keep grammar behavior compatible.
import { compileAuthoringSource } from "./resolve.ts"
import { mentionsIn, quoteName } from "./syntax.ts"
import { TYPES, RELATIONSHIPS, type AuthoringResult, type ComponentType, type TextEdit } from "./schema.ts"

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
