// Grammar types ported from M45; persistence validation belongs to the file adapter.
export const AUTHORING_VERSION = "m45.control-structure-authoring.v1" as const
export const GRAMMAR_VERSION = "0.1" as const
export const COMPILER_VERSION = "control-structure-authoring-compiler-v2" as const
export const TYPES = ["controller", "process", "sensor", "actuator"] as const
export const RELATIONSHIPS = ["control", "feedback", "information", "effect"] as const
export type ComponentType = typeof TYPES[number]
export type RelationshipType = typeof RELATIONSHIPS[number] | "observation"
export type Range = { from: number; to: number }
export type Diagnostic = Range & { code: string; message: string; category: "syntax" | "classification" | "identity" | "profile"; severity: "error" | "warning" }
export type Token = Range & { kind: "name" | "type" | "keyword" | "arrow" | "relationship" | "label" | "comment" | "heading" | "body" }
export type Mention = Range & { name: string; type?: ComponentType }
export type Declaration = Range & { kind: "declaration"; owner: Mention }
export type Connection = Range & { kind: "connection"; source: Mention; target: Mention; relationship: RelationshipType; label: string }
export type DetailBlock = Range & { kind: "process_model" | "control_algorithm"; owner: Mention; body: string; entries: Array<Range & { text: string }>; headerTo: number }
export type SyntaxNode = Declaration | Connection | DetailBlock
export type Section = Range & { title: string; headerTo: number }
export type ParsedSource = { source: string; nodes: SyntaxNode[]; tokens: Token[]; diagnostics: Diagnostic[]; sections: Section[] }

export type IdentityState = { namespace: string; nextId: number; entries: Array<Range & { id: string; key: string; kind: "component" | "connection" | "signal" | "process_model" | "variable" | "control_algorithm" | "rule" }> }
export type TextEdit = { from: number; to: number; insert: string }
export type Component = { id: string; name: string; type?: ComponentType; mentions: Mention[] }
export type ResolvedConnection = Connection & { id: string; signalId?: string; sourceId: string; targetId: string }
export type ResolvedDetail = DetailBlock & { id?: string; ownerId: string; variables: Array<Range & { id: string; text: string }>; rules: Array<Range & { id: string; text: string }> }
export type AuthoredGraph = { components: Component[]; connections: ResolvedConnection[]; details: ResolvedDetail[] }
export type AuthoringResult = ParsedSource & { graph: AuthoredGraph; identity: IdentityState; valid: boolean; exportable: boolean }

export function emptyIdentity(namespace: string): IdentityState {
  return { namespace, nextId: 1, entries: [] }
}
