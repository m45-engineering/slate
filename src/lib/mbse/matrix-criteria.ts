// Adapted from M45 lib/mbse for local, read-only model viewing.
import { DOMParser, type Element, type Document } from "@xmldom/xmldom"
import type { MagicDrawSource } from "./magicdraw.ts"

export type RelationshipKind = "allocation" | "verification" | "satisfaction"
export type ProfileDefinition = MagicDrawSource["profileDefinitions"][number]
export interface MatrixCriterion {
  stereotype: ProfileDefinition
  includeSubtypes: boolean
  direction: "forward" | "reverse"
}
const NAMESPACE = "http://www.nomagic.com/schemas/MagicDraw/StructuredExpression/2013"
const XSI = "http://www.w3.org/2001/XMLSchema-instance"

export function profileIsA(actual: ProfileDefinition, target: ProfileDefinition, definitions: ProfileDefinition[], seen = new Set<string>()): boolean {
  if (actual.id === target.id && actual.namespace === target.namespace) return true
  const key = `${actual.namespace}#${actual.id}`
  if (seen.has(key)) return false
  seen.add(key)
  return (actual.generalIds ?? []).some(id => {
    const parent = definitions.find(def => def.id === id && def.namespace === actual.namespace)
    return parent ? profileIsA(parent, target, definitions, seen) : false
  })
}

export function relationshipKind(definition: ProfileDefinition | undefined, definitions: ProfileDefinition[]): RelationshipKind | null {
  if (!definition) return null
  for (const [name, kind] of [["Allocate", "allocation"], ["Verify", "verification"], ["Satisfy", "satisfaction"]] as const) {
    const root = definitions.find(def => def.namespace.startsWith("http://www.omg.org/spec/SysML/") && def.name === name)
    if (root && profileIsA(definition, root, definitions)) return kind
  }
  return null
}

const children = (element: Element) => Array.from(element.childNodes).filter(node => node.nodeType === 1) as Element[]
function hasType(element: Element, name: string): boolean {
  const value = element.getAttributeNS(XSI, "type") ?? ""
  const parts = value.split(":")
  return parts.length <= 2 && parts.at(-1) === name && element.lookupNamespaceURI(parts.length === 2 ? parts[0] : "") === NAMESPACE
}

/** Parse only the native direct relationship grammar. Never execute expressions. */
export function parseMatrixCriterion(value: string, definitions: ProfileDefinition[]): MatrixCriterion | null {
  let id: string | undefined, includeSubtypes = true
  if (!value.trimStart().startsWith("<")) {
    const fields = value.split(";")
    if (fields[1] !== "DSLRelation" || fields[3] !== "Source to target" || fields.slice(4).some(Boolean)) return null
    id = fields[2]
  } else {
    if (/<!DOCTYPE\s|<!ENTITY\s/i.test(value)) return null
    const errors: string[] = []
    const doc = new DOMParser({ onError: (_level, message) => errors.push(message) }).parseFromString(value, "application/xml")
    const root = doc.documentElement
    if (errors.length || !root || root.namespaceURI !== NAMESPACE || root.localName !== "callExpressionSpecification") return null
    const parts = children(root)
    if (parts.some(e => e.namespaceURI !== NAMESPACE || !["taggedValues", "argument", "expression"].includes(e.localName ?? ""))) return null
    const args = parts.filter(e => e.localName === "argument"), expressions = parts.filter(e => e.localName === "expression")
    if (args.length !== 1 || expressions.length !== 1) return null
    if (!hasType(args[0], "lookupExpressionSpecification") || args[0].getAttribute("symbol") !== "THIS" || children(args[0]).length) return null
    const expression = expressions[0]
    if (!hasType(expression, "dslRelationExpressionSpecification") || children(expression).some(e => e.namespaceURI !== NAMESPACE || e.localName !== "taggedValues")) return null
    const nativeDirection = expression.getAttribute("direction"), subtypes = expression.getAttribute("includeSubtypes") ?? ""
    if (nativeDirection !== "DIRECT" || !["true", "false"].includes(subtypes)) return null
    id = expression.getAttribute("stereotype") ?? undefined
    includeSubtypes = subtypes === "true"
  }
  const candidates = definitions.filter(def => def.id === id)
  if (candidates.length !== 1 || !relationshipKind(candidates[0], definitions)) return null
  return { stereotype: candidates[0], includeSubtypes, direction: "forward" }
}
