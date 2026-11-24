// Adapted from M45 lib/mbse for local, read-only model viewing.
import { parseMatrixCriterion, profileIsA, relationshipKind, type RelationshipKind } from "./matrix-criteria.ts"
import { ingestMagicDraw, type MagicDrawNode, type MagicDrawSource, type NativeXmlName } from "./magicdraw.ts"

export interface ModelReference {
  role: string
  targetId: string
  resolved: boolean
}
export interface ModelElement {
  id: string
  name: string
  type: NativeXmlName
  ownerId: string | null
  properties: Record<string, string>
  references: ModelReference[]
  stereotypes: { id: string; type: NativeXmlName; properties: Record<string, string> }[]
}
export interface ModelRelationship {
  id: string
  kind: RelationshipKind | "dependency" | "connection" | "transition"
  sourceIds: string[]
  targetIds: string[]
  stereotypeId: string
}
export const MBSE_COMPILER_VERSION = 3

export interface SemanticModel {
  compilerVersion?: number
  schemaVersion: "m45.mbse.model.v1"
  source: MagicDrawSource["source"] & { format?: "sysml-v2"; parserVersion?: string }
  nativeSyntax?: unknown
  elements: ModelElement[]
  relationships: ModelRelationship[]
  diagnostics: string[]
}
export interface AllocationMatrix {
  id: string
  filename: string
  name: string
  schemaVersion: "m45.mbse.matrix.v1"
  sourceHash: string
  definition: { rowScope: string[]; columnScope: string[]; rowTypes: string[]; columnTypes: string[]; criteria: string[]; direction: string }
  rowIds: string[]
  columnIds: string[]
  cells: { rowId: string; columnId: string; relationshipIds: string[]; direction: "forward" | "reverse" }[]
  /** Supported explicit rules evaluated; other saved criteria remain unevaluated. */
  partial?: boolean
  diagnostics: string[]
}
export interface ModelPackage { model: SemanticModel; matrices: AllocationMatrix[] }

const UML = "http://www.omg.org/spec/UML/"
const SYSML = "http://www.omg.org/spec/SysML/"
// UML properties typed as element references. Literal values such as name,
// body, visibility, and aggregation must never be interpreted as identifiers.
const REFERENCE_PROPERTIES = new Set(["type", "general", "specific", "client", "supplier", "source", "target", "role", "partWithPort", "definingFeature", "classifier", "classifierBehavior", "behavior", "operation", "signal", "event", "effect", "guard", "represented", "covered", "sendEvent", "receiveEvent", "memberEnd", "association", "annotatedElement", "importedPackage", "importedElement", "appliedProfile", "redefinedProperty", "subsettedProperty", "contract", "implementingClassifier", "conveyed", "informationSource", "informationTarget", "inPartition", "represents"])
const words = (value = "") => value.trim().split(/\s+/).filter(Boolean)
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
const properties = (node: MagicDrawNode) => Object.fromEntries(node.attributes.filter(a => !a.namespace).map(a => [a.localName, a.value]))
const isType = (type: NativeXmlName | undefined, namespace: string, name?: string) => Boolean(type?.namespace.startsWith(namespace) && (!name || type.localName === name))

export async function buildModelPackage(bytes: Uint8Array, artifactPath: string): Promise<ModelPackage> {
  const source = await ingestMagicDraw(bytes, { artifactPath })
  return compileModelPackage(source)
}

export function compileModelPackage(source: MagicDrawSource): ModelPackage {
  const byId = new Map<string, ModelElement>()
  const sourceNodes = new Map<string, MagicDrawNode>()
  for (const node of source.nodes) {
    const type = node.type ?? { namespace: node.namespace, localName: node.localName }
    if (!node.id || !isType(type, UML)) continue
    let owner = node.parentIndex === null ? undefined : source.nodes[node.parentIndex]
    while (owner && (!owner.id || !isType(owner.type ?? { namespace: owner.namespace, localName: owner.localName }, UML))) {
      owner = owner.parentIndex === null ? undefined : source.nodes[owner.parentIndex]
    }
    const props = properties(node)
    byId.set(node.id, { id: node.id, name: props.name ?? "", type, ownerId: owner?.id ?? null, properties: props, references: [], stereotypes: [] })
    sourceNodes.set(node.id, node)
  }
  const diagnostics: string[] = [
    "Only explicit source assertions are imported. Allocation does not establish implementation, satisfaction, or verification.",
    "Bundled profile definitions resolve stereotype inheritance. External project models are not imported. Behavior expressions are preserved, not executed or proved.",
  ]
  for (const [id, element] of byId) {
    const node = sourceNodes.get(id)!
    for (const [role, value] of Object.entries(element.properties)) {
      if (REFERENCE_PROPERTIES.has(role)) for (const targetId of words(value)) element.references.push({ role, targetId, resolved: byId.has(targetId) })
    }
    const readChildren = (parent: MagicDrawNode, rolePath: string): void => {
      for (const index of parent.children) {
        const child = source.nodes[index]
        // Owned UML elements have their own semantic record.
        if (child.id && byId.has(child.id)) continue
        const role = rolePath ? `${rolePath}.${child.localName}` : child.localName
        const p = properties(child)
        const idref = child.attributes.find(a => a.localName === "idref" && a.namespace.includes("XMI"))?.value
        if (idref) element.references.push({ role, targetId: idref, resolved: byId.has(idref) })
        if (p.href) {
          const targetId = p.href.startsWith("#") ? p.href.slice(1) : p.href
          element.references.push({ role, targetId, resolved: byId.has(targetId) })
        }
        if (child.text.trim()) element.properties[role] = child.text
        readChildren(child, role)
      }
    }
    readChildren(node, "")
  }
  for (const node of source.nodes) {
    if (!node.id) continue
    const p = properties(node)
    for (const [role, targetId] of Object.entries(p)) {
      if (!role.startsWith("base_")) continue
      const target = byId.get(targetId)
      if (target) target.stereotypes.push({ id: node.id, type: { namespace: node.namespace, localName: node.localName }, properties: p })
      else diagnostics.push(`Stereotype ${node.id} has an unresolved base element ${targetId}.`)
    }
  }
  const relationships: ModelRelationship[] = []
  for (const element of byId.values()) {
    for (const stereotype of element.stereotypes) {
      const definition = source.profileDefinitions.find(d => d.namespace === stereotype.type.namespace && d.name === stereotype.type.localName)
      const kind = relationshipKind(definition, source.profileDefinitions)
      if (!kind) continue
      const sourceIds = element.references.filter(r => r.role === "client").map(r => r.targetId)
      const targetIds = element.references.filter(r => r.role === "supplier").map(r => r.targetId)
      relationships.push({ id: element.id, kind, sourceIds, targetIds, stereotypeId: stereotype.id })
      if (!sourceIds.length || !targetIds.length || [...sourceIds, ...targetIds].some(id => !byId.has(id))) diagnostics.push(`Relationship ${element.id} has missing or unresolved endpoints.`)
    }
  }
  const unresolved = [...byId.values()].flatMap(e => e.references).filter(r => !r.resolved)
  if (unresolved.length) diagnostics.push(`${unresolved.length} references are outside the imported primary model or unresolved; their original targets are retained.`)
  const model: SemanticModel = { compilerVersion: MBSE_COMPILER_VERSION, schemaVersion: "m45.mbse.model.v1", source: source.source, elements: [...byId.values()], relationships, diagnostics }
  const matrices = source.nodes.filter(n => n.localName === "DependencyMatrix" && n.namespace === "http://www.magicdraw.com/schemas/Dependency_Matrix_Profile.xmi").map(def => {
    const p = properties(def)
    const filter = source.nodes.find(n => n.localName === "MatrixFilter" && n.namespace === def.namespace && properties(n).base_Diagram === p.base_Diagram)
    const fp = filter ? properties(filter) : {}
    const values = (node: MagicDrawNode | undefined, name: string) => node?.children.map(i => source.nodes[i]).filter(n => n.localName === name).map(n => properties(n).href ?? n.text.trim()) ?? []
    const matrix: AllocationMatrix = {
      id: p.base_Diagram, filename: `views/${encodeURIComponent(p.base_Diagram)}.json`,
      name: byId.get(p.base_Diagram)?.name || p.base_Diagram, schemaVersion: "m45.mbse.matrix.v1", sourceHash: source.source.sha256,
      definition: { rowScope: words(fp.rowScope), columnScope: words(fp.columnScope), rowTypes: values(filter, "rowElementType"), columnTypes: values(filter, "columnElementType"), criteria: values(def, "dependencyCriteria"), direction: p.direction ?? "" },
      rowIds: [], columnIds: [], cells: [], diagnostics: [],
    }
    if (!filter) matrix.diagnostics.push("Matrix filter is missing.")
    if (p.showElements !== "All") matrix.diagnostics.push("This matrix's element visibility rule is not supported yet.")
    if (p.takeWholeModelAsScope !== "false" || ![undefined, "true"].includes(fp.rowScopeDefined) || ![undefined, "true"].includes(fp.columnScopeDefined)) matrix.diagnostics.push("This matrix needs explicit row and column scopes.")
    const criteria = matrix.definition.criteria.map(value => parseMatrixCriterion(value, source.profileDefinitions))
    if (!criteria.some(value => value !== null)) matrix.diagnostics.push("This matrix uses a relationship rule that M45 cannot read yet.")
    if (!["Both", "Row to column", "Column to row"].includes(p.direction)) matrix.diagnostics.push("This matrix uses a direction rule that M45 cannot read yet.")
    if (model.elements.some(e => e.stereotypes.some(s => isType(s.type, SYSML, "Allocate") && ["sourcePropertyPath", "targetPropertyPath", "sourceContext", "targetContext"].some(key => Boolean(s.properties[key]))))) {
      matrix.diagnostics.push("Context-qualified allocations need additional resolution before this matrix can be reconstructed.")
    }
    const inScope = (element: ModelElement, scopes: string[]): boolean => {
      const seen = new Set<string>(); let current: ModelElement | undefined = element
      while (current && !seen.has(current.id)) { if (scopes.includes(current.id)) return true; seen.add(current.id); current = current.ownerId ? byId.get(current.ownerId) : undefined }
      return false
    }
    const select = (side: "row" | "column"): string[] => {
      const scopes = matrix.definition[`${side}Scope`], types = matrix.definition[`${side}Types`]
      if (!scopes.length || scopes.some(id => !byId.has(id))) matrix.diagnostics.push(`${side} scope is missing or unresolved.`)
      if (!types.length) matrix.diagnostics.push(`${side} type filter is missing.`)
      const predicates = types.map(href => {
        if (href === "http://www.omg.org/spec/UML/20131001/UML.xmi#Activity" || href === "http://www.omg.org/spec/UML/20131001/UML.xmi#Interaction") {
          const name = href.split("#")[1]
          return (e: ModelElement) => isType(e.type, UML, name)
        }
        // Cameo saves either a native stereotype ID or a standard SysML URI.
        const [resource, fragment] = href.split("#")
        const candidates = source.profileDefinitions.filter(d => d.id === fragment ||
          (resource.startsWith(SYSML) && resource.endsWith("/SysML.xmi") && fragment === `SysML.${d.name}` && d.namespace === resource.slice(0, -4)))
        const d = candidates.length === 1 ? candidates[0] : undefined
        if (d) return (e: ModelElement) => e.stereotypes.some(s => {
          const actual = source.profileDefinitions.find(def => def.namespace === s.type.namespace && def.name === s.type.localName)
          return actual && (fp[`${side}TypesIncludeSubtypes`] === "true" ? profileIsA(actual, d, source.profileDefinitions) : actual.id === d.id && actual.namespace === d.namespace)
        })
        matrix.diagnostics.push(`The ${side} element types could not be resolved from the bundled profiles.`)
        return () => false
      })
      // Include model specialization when the saved filter requests subtypes.
      const matches = (e: ModelElement, visited = new Set<string>()): boolean => {
        if (visited.has(e.id)) return false
        visited.add(e.id)
        if (predicates.some(test => test(e))) return true
        if (fp[`${side}TypesIncludeSubtypes`] !== "true") return false
        return model.elements.filter(g => g.ownerId === e.id && g.type.localName === "Generalization").some(g => g.references.some(r => r.role === "general" && byId.has(r.targetId) && matches(byId.get(r.targetId)!, visited)))
      }
      const removed = new Set(words(fp[side === "row" ? "removedRowElements" : "removedColumnElements"]))
      return model.elements.filter(e => !removed.has(e.id) && inScope(e, scopes) && matches(e)).sort((a,b) => compare(a.name,b.name) || compare(a.id,b.id)).map(e => e.id)
    }
    matrix.rowIds = select("row"); matrix.columnIds = select("column")
    if (!matrix.diagnostics.length) {
      const rows = new Set(matrix.rowIds), columns = new Set(matrix.columnIds)
      const cells = new Map<string, AllocationMatrix["cells"][number]>()
      const matchingRelationships = relationships.filter(rel => {
        const application = byId.get(rel.id)?.stereotypes.find(s => s.id === rel.stereotypeId)
        const actual = application && source.profileDefinitions.find(d => d.namespace === application.type.namespace && d.name === application.type.localName)
        return actual && criteria.some(criterion => criterion && (criterion.includeSubtypes ? profileIsA(actual, criterion.stereotype, source.profileDefinitions) : actual.id === criterion.stereotype.id && actual.namespace === criterion.stereotype.namespace))
      })
      for (const rel of matchingRelationships) {
        const application = byId.get(rel.id)!.stereotypes.find(s => s.id === rel.stereotypeId)!
        const actual = source.profileDefinitions.find(d => d.namespace === application.type.namespace && d.name === application.type.localName)!
        for (const criterion of criteria) {
          if (!criterion || !(criterion.includeSubtypes ? profileIsA(actual, criterion.stereotype, source.profileDefinitions) : actual.id === criterion.stereotype.id && actual.namespace === criterion.stereotype.namespace)) continue
          for (const sourceId of rel.sourceIds) for (const targetId of rel.targetIds) {
            const [s,t] = criterion.direction === "forward" ? [sourceId,targetId] : [targetId,sourceId]
            const pairs = [[s,t,"forward"],[t,s,"reverse"]] as const
            for (const [rowId,columnId,direction] of pairs) {
              if (p.direction === "Row to column" && direction !== "forward") continue
              if (p.direction === "Column to row" && direction !== "reverse") continue
              if (!rows.has(rowId) || !columns.has(columnId)) continue
              const key = `${rowId}:${columnId}:${direction}`
              const cell = cells.get(key) ?? { rowId,columnId,direction,relationshipIds: [] }
              if (!cell.relationshipIds.includes(rel.id)) cell.relationshipIds.push(rel.id)
              cells.set(key,cell)
            }
          }
        }
      }
      matrix.cells = [...cells.values()]
      if (matchingRelationships.some(r => [...r.sourceIds, ...r.targetIds].some(id => !byId.has(id)))) matrix.diagnostics.push("Unresolved relationship endpoints may affect this matrix.")
    }
    if (criteria.some(value => value !== null) && criteria.some(value => value === null)) {
      if (!matrix.diagnostics.length) matrix.partial = true
      matrix.diagnostics.push("Some saved relationship rules cannot be evaluated. Only supported explicit relationships are shown; additional relationships may be missing.")
    }
    matrix.diagnostics = [...new Set(matrix.diagnostics)]
    return matrix
  })
  return { model, matrices }
}
