// Ported from M45 control-structure authoring; keep grammar behavior compatible.
import { RELATIONSHIPS, TYPES, type ComponentType, type DetailBlock, type Mention, type ParsedSource, type Range, type RelationshipType, type Token } from "./schema.ts"

/** Mask quoted strings without changing UTF-16 offsets. Grammar delimiters only. */
export function outsideQuotes(text: string): string {
  let quoted = false, escaped = false, result = ""
  for (const char of text) {
    if (quoted) {
      result += " ".repeat(char.length)
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') { quoted = true; result += " " }
    else result += char
  }
  if (quoted) throw new Error("Close the quoted string.")
  return result
}

function decoded(text: string): string {
  const value = text.trim()
  if (!value) throw new Error("Enter a name or label.")
  if (value.startsWith('"')) {
    const result: unknown = JSON.parse(value)
    if (typeof result !== "string" || !result.trim()) throw new Error("Enter a nonempty quoted name or label.")
    return result.trim().normalize("NFC")
  }
  if (/["():\[\]]|->|→|\bmeasures\b|\bprocess model\b|\bcontrol algorithm\b/.test(value)) throw new Error("Quote text containing reserved language punctuation or keywords.")
  return value.normalize("NFC")
}

export function quoteName(value: string): string {
  try { if (!value.startsWith("#") && decoded(value) === value) return value } catch { /* Reserved syntax needs quoting. */ }
  return JSON.stringify(value)
}

export function parseAuthoringSource(source: string): ParsedSource {
  const result: ParsedSource = { source, nodes: [], tokens: [], diagnostics: [], sections: [] }
  const token = (kind: Token["kind"], from: number, to: number) => { if (to > from) result.tokens.push({ kind, from, to }) }
  const error = (message: string, from: number, to: number) => result.diagnostics.push({ code: "syntax", category: "syntax", severity: "error", message, from, to })
  const endpoint = (text: string, offset: number, implied?: ComponentType): Mention => {
    let raw = text.trim(), from = offset + text.indexOf(raw)
    const mask = outsideQuotes(raw)
    const typeMatch = /\(([a-z_]+)\)$/.exec(mask)
    let type = implied
    if (typeMatch) {
      if (!(TYPES as readonly string[]).includes(typeMatch[1])) throw new Error(`Unknown component type (${typeMatch[1]}). Use ${TYPES.join(", ")}.`)
      const explicit = typeMatch[1] as ComponentType
      if (implied && implied !== explicit) throw new Error(`This position requires (${implied}).`)
      type = explicit
      token("type", from + typeMatch.index, from + raw.length)
      raw = raw.slice(0, typeMatch.index).trimEnd()
    }
    const name = decoded(raw)
    const mention = { name, type, from, to: from + raw.length }
    token("name", mention.from, mention.to)
    return mention
  }

  let offset = 0
  let block: { node: DetailBlock; indent?: number; lines: string[] } | undefined
  const finishBlock = () => {
    if (!block) return
    block.node.body = block.lines.join("\n").trim()
    block = undefined
  }
  for (const rawLine of source.split("\n")) {
    const line = rawLine.replace(/\r$/, ""), from = offset, to = from + line.length
    offset += rawLine.length + 1
    if (!line.trim()) {
      if (block) { block.lines.push(""); block.node.to = to }
      continue
    }
    if (/^[ \t]/.test(line)) {
      if (!block) { error("Remove this indentation or add a process model: or control algorithm: header.", from, to); continue }
      const spaces = /^ */.exec(line)![0].length
      if (/^[ \t]*\t/.test(line) || (block.indent !== undefined && spaces !== block.indent)) {
        error("Use the same space indentation for every line in this block (two spaces recommended).", from, from + Math.max(1, spaces)); continue
      }
      block.indent ??= spaces
      const body = line.slice(spaces)
      block.lines.push(body)
      block.node.entries.push({ text: body.trim(), from: from + spaces, to })
      block.node.to = to
      token("body", from + spaces, to)
      continue
    }
    finishBlock()
    if (line.startsWith("#")) {
      if (/^# [^\s]/.test(line)) {
        const previous = result.sections.at(-1)
        if (previous) previous.to = from
        result.sections.push({ title: line.slice(2).trim(), from, headerTo: to, to: source.length })
        token("heading", from, to)
      } else token("comment", from, to)
      continue
    }
    try {
      const mask = outsideQuotes(line)
      const header = / (process model|control algorithm):\s*$/.exec(mask)
      if (header) {
        const owner = endpoint(line.slice(0, header.index), from)
        const node: DetailBlock = { kind: header[1] === "process model" ? "process_model" : "control_algorithm", owner, from, to, headerTo: to, body: "", entries: [] }
        result.nodes.push(node)
        token("keyword", from + header.index + 1, to)
        block = { node, lines: [] }
        continue
      }
      const arrows = [...mask.matchAll(/->|→/g)]
      if (arrows.length) {
        if (arrows.length !== 1) throw new Error("Use one connection per line; chained arrows are not supported.")
        const arrow = arrows[0], split = arrow.index!, afterArrow = split + arrow[0].length
        const colon = mask.indexOf(":", afterArrow)
        if (colon < 0) throw new Error("Add a colon and connection label after the target.")
        const sourceMention = endpoint(line.slice(0, split), from)
        const target = endpoint(line.slice(afterArrow, colon), from + afterArrow)
        let labelText = line.slice(colon + 1), relationship: RelationshipType = "control"
        const suffix = /\[([^\]]*)\]\s*$/.exec(mask.slice(colon + 1))
        if (suffix) {
          if (!(RELATIONSHIPS as readonly string[]).includes(suffix[1])) throw new Error(`Unknown relationship [${suffix[1]}].`)
          relationship = suffix[1] as RelationshipType
          token("relationship", from + colon + 1 + suffix.index, to)
          labelText = labelText.slice(0, suffix.index)
        }
        const label = decoded(labelText)
        token("arrow", from + split, from + afterArrow)
        token("label", from + colon + 1, from + colon + 1 + labelText.length)
        result.nodes.push({ kind: "connection", source: sourceMention, target, label, relationship, from, to })
        continue
      }
      const measures = /\s+measures\s+/.exec(mask)
      if (measures) {
        const sensor = endpoint(line.slice(0, measures.index), from, "sensor")
        const processStart = measures.index + measures[0].length
        const process = endpoint(line.slice(processStart), from + processStart, "process")
        token("keyword", from + measures.index, from + processStart)
        result.nodes.push({ kind: "connection", source: sensor, target: process, relationship: "observation", label: "Observes", from, to })
        continue
      }
      result.nodes.push({ kind: "declaration", owner: endpoint(line, from), from, to })
    } catch (caught) {
      error(caught instanceof Error ? caught.message : "Invalid statement.", from, to)
    }
  }
  finishBlock()
  result.tokens.sort((a, b) => a.from - b.from || a.to - b.to)
  return result
}

export function mentionsIn(node: ParsedSource["nodes"][number]): Mention[] {
  return node.kind === "connection" ? [node.source, node.target] : [node.owner]
}

export function sourceLine(source: string, range: Range): number {
  return source.slice(0, range.from).split("\n").length
}
