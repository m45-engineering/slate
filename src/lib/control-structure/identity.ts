// Ported from M45 control-structure authoring; keep grammar behavior compatible.
import { type IdentityState, type Range, type TextEdit } from "./schema.ts"
import { mentionsIn, parseAuthoringSource, quoteName } from "./syntax.ts"

export function mapOffset(position: number, edits: readonly TextEdit[], association: -1 | 1 = 1): number {
  let delta = 0
  for (const edit of [...edits].sort((a, b) => a.from - b.from)) {
    if (position < edit.from || (position === edit.from && association < 0)) break
    if (position <= edit.to) return edit.from + delta + (association < 0 ? 0 : edit.insert.length)
    delta += edit.insert.length - (edit.to - edit.from)
  }
  return position + delta
}

export function identityAllocator(previous: IdentityState, edits: readonly TextEdit[] = []) {
  const state: IdentityState = { namespace: previous.namespace, nextId: previous.nextId, entries: [] }
  const used = new Set<string>()
  function take(kind: IdentityState["entries"][number]["kind"], key: string, range: Range, editPrefix?: string): string {
    let existing = previous.entries.find(e => e.kind === kind && e.key === key && !used.has(e.id))
    if (!existing && edits.length && editPrefix) {
      const matches = previous.entries.filter(e => e.kind === kind && e.key.startsWith(editPrefix) && !used.has(e.id) &&
        mapOffset(e.from, edits, -1) <= range.to && mapOffset(e.to, edits, 1) >= range.from)
      if (matches.length === 1) existing = matches[0]
    }
    const id = existing?.id ?? `cs-${state.namespace}-${state.nextId++}`
    used.add(id)
    state.entries.push({ kind, key, id, from: range.from, to: range.to })
    return id
  }
  return { state, take }
}

/** Rename only syntactically resolved references; never prose that happens to match. */
export function renameComponent(source: string, identity: IdentityState, oldName: string, newName: string) {
  const normalized = newName.trim().normalize("NFC")
  if (!normalized) throw new Error("Enter a component name.")
  const parsed = parseAuthoringSource(source)
  if (parsed.diagnostics.length) throw new Error("Resolve syntax errors before renaming.")
  const mentions = parsed.nodes.flatMap(mentionsIn)
  if (oldName !== normalized && mentions.some(m => m.name === normalized)) throw new Error("That component name is already in use.")
  const edits = mentions.filter(m => m.name === oldName).map(m => ({ from: m.from, to: m.to, insert: quoteName(normalized) }))
  let next = source
  for (const edit of [...edits].sort((a, b) => b.from - a.from)) next = next.slice(0, edit.from) + edit.insert + next.slice(edit.to)
  return {
    source: next, edits,
    identity: { ...identity, entries: identity.entries.map(e => ({ ...e, ...(e.kind === "component" && e.key === oldName ? { key: normalized } : {}) })) },
  }
}
