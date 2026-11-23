// Ported from M45 control-structure authoring; keep grammar behavior compatible.
import { identityAllocator } from "./identity.ts"
import { mentionsIn, parseAuthoringSource } from "./syntax.ts"
import { emptyIdentity, type AuthoringResult, type Component, type Diagnostic, type IdentityState, type Range, type TextEdit } from "./schema.ts"

export function compileAuthoringSource(source: string, previous: IdentityState = emptyIdentity("draft"), edits: readonly TextEdit[] = []): AuthoringResult {
  const parsed = parseAuthoringSource(source)
  const diagnostics = [...parsed.diagnostics]
  const report = (range: Range, category: Diagnostic["category"], code: string, message: string, severity: Diagnostic["severity"] = "error") => diagnostics.push({ ...range, category, code, message, severity })
  const ids = identityAllocator(previous, edits)
  const components = new Map<string, Component>()
  for (const mention of parsed.nodes.flatMap(mentionsIn)) {
    const existing = components.get(mention.name)
    if (existing) {
      existing.mentions.push(mention)
      if (mention.type && existing.type && mention.type !== existing.type) {
        for (const reference of existing.mentions.filter(m => m.type)) report(reference, "classification", "conflicting_type", `“${mention.name}” has conflicting component types.`)
      } else existing.type ??= mention.type
    } else components.set(mention.name, { id: ids.take("component", mention.name, mention), name: mention.name, type: mention.type, mentions: [mention] })
  }
  for (const component of components.values()) {
    if (!component.type) report(component.mentions[0], "classification", "missing_type", `Choose a role for “${component.name}”.`, "warning")
  }
  const graph: AuthoringResult["graph"] = { components: [...components.values()], connections: [], details: [] }
  const connections = new Map<string, Range>()
  const blocks = new Map<string, Range>()
  for (const node of parsed.nodes) {
    if (node.kind === "connection") {
      const from = components.get(node.source.name)!, to = components.get(node.target.name)!
      const prefix = `${JSON.stringify([from.id, to.id, node.relationship])}:`
      const key = prefix + node.label
      const duplicate = connections.get(key)
      if (duplicate) {
        report(node, "syntax", "duplicate_connection", "This exact connection is already declared.")
        report(duplicate, "syntax", "duplicate_connection", "This connection is duplicated below.")
      }
      connections.set(key, node)
      const id = ids.take("connection", key, node, prefix)
      const signalId = node.relationship === "observation" || node.relationship === "effect" ? undefined : ids.take("signal", id, node)
      graph.connections.push({ ...node, id, signalId, sourceId: from.id, targetId: to.id })
      if (node.relationship === "effect") report(node, "profile", "physical_effect", "Physical effects can be drawn and saved, but are outside the full DSL export profile.", "warning")
      if (from.type && to.type) {
        const supported = node.relationship === "control" ? from.type === "controller" && ["controller", "process", "actuator"].includes(to.type)
          : node.relationship === "feedback" ? to.type === "controller"
          : node.relationship === "observation" ? from.type === "sensor" && to.type === "process"
          : true
        if (!supported) {
          const explanation = node.relationship === "feedback"
            ? `“${to.name}” is marked as “${to.type}”. Feedback can currently be exported only when it goes to a controller. If this arrow only passes information, use [information] instead of [feedback].`
            : node.relationship === "control"
              ? `This arrow sends a control command from “${from.name}” (${from.type}) to “${to.name}” (${to.type}). Export currently requires a controller sending to a controller, process, or actuator.`
              : `“${from.name}” (${from.type}) measures “${to.name}” (${to.type}). Export currently requires a sensor measuring a process.`
          report(node, "profile", "endpoint_profile", `${explanation} You can still save and draw this connection.`, "warning")
        }
      }
    } else if (node.kind !== "declaration") {
      const owner = components.get(node.owner.name)!
      if (owner.type && owner.type !== "controller") report(node.owner, "classification", "block_owner", "Only a controller can own a process model or control algorithm.")
      const key = `${owner.id}:${node.kind}`
      const duplicate = blocks.get(key)
      if (duplicate) {
        report(node, "syntax", "duplicate_block", "Keep one block of each kind per controller.")
        report(duplicate, "syntax", "duplicate_block", "This controller block is repeated below.")
      }
      blocks.set(key, node)
      const id = node.body ? ids.take(node.kind, key, node) : undefined
      const seen = new Map<string, Range>()
      const variables = node.kind === "process_model" ? node.entries.map(entry => {
        const duplicateEntry = seen.get(entry.text)
        if (duplicateEntry) {
          report(entry, "syntax", "duplicate_variable", "This process-model entry is repeated.")
          report(duplicateEntry, "syntax", "duplicate_variable", "This process-model entry is repeated.")
        }
        seen.set(entry.text, entry)
        return { ...entry, id: ids.take("variable", `${id}:${entry.text}`, entry, `${id}:`) }
      }) : []
      graph.details.push({ ...node, id, ownerId: owner.id, variables })
    }
  }
  const valid = !diagnostics.some(d => d.severity === "error")
  return { ...parsed, diagnostics, graph, identity: valid ? ids.state : previous, valid, exportable: valid && diagnostics.length === 0 }
}
