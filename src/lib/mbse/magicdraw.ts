// Adapted from M45 lib/mbse for local, read-only model viewing.
import { DOMParser, type Element, type Document } from "@xmldom/xmldom"
import JSZip from "jszip"

const MODEL_ENTRY = "com.nomagic.magicdraw.uml_model.model"
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
const MAX_MODEL_BYTES = 25 * 1024 * 1024
const MAX_DEPTH = 256
const XMI_NAMESPACES = new Set([
  "http://www.omg.org/spec/XMI/20131001",
  "http://www.omg.org/spec/XMI/20110701",
  "http://www.omg.org/XMI",
])

export interface NativeXmlName {
  namespace: string
  localName: string
}

export interface NativeXmlAttribute extends NativeXmlName {
  value: string
}

/** A source node, not an inferred M45 engineering entity. */
export interface MagicDrawNode extends NativeXmlName {
  index: number
  parentIndex: number | null
  children: number[]
  id?: string
  type?: NativeXmlName
  attributes: NativeXmlAttribute[]
  /** Direct text and CDATA only. Child text remains on the child node. */
  text: string
}

export interface MagicDrawSource {
  kind: "magicdraw-source"
  schemaVersion: 1
  source: { artifactPath: string; sha256: string; archiveEntry: string }
  nodes: MagicDrawNode[]
  /** Native XMI ID to node index. IDs are scoped to this archive entry. */
  idIndex: Record<string, number>
  profileDefinitions: { id: string; namespace: string; name: string; href: string; generalIds?: string[] }[]
  references: {
    nodeIndex: number
    kind: "idref" | "href"
    value: string
    targetIndex: number | null
  }[]
  diagnostics: { code: string; message: string; count?: number }[]
}

function isXmi(namespace: string | null | undefined): boolean {
  return XMI_NAMESPACES.has(namespace ?? "")
}

function xmiAttribute(element: Element, name: string): string | undefined {
  return Array.from(element.attributes).find(
    attribute => isXmi(attribute.namespaceURI) && attribute.localName === name,
  )?.value
}

function expandedType(element: Element): NativeXmlName | undefined {
  const value = xmiAttribute(element, "type")
  if (!value) return undefined
  const parts = value.split(":")
  if (parts.length > 2) throw new Error(`Invalid XMI type: ${value}`)
  const namespace = element.lookupNamespaceURI(parts.length === 2 ? parts[0] : null)
  if (parts.length === 2 && !namespace) throw new Error(`Unbound XMI type: ${value}`)
  return { namespace: namespace ?? "", localName: parts.at(-1)! }
}

function childElements(element: Element): Element[] {
  return Array.from(element.childNodes).filter(node => node.nodeType === 1) as Element[]
}

function isExtension(element: Element): boolean {
  return isXmi(element.namespaceURI) && element.localName === "Extension"
}

function isDiagram(element: Element): boolean {
  const type = expandedType(element)
  return type?.localName === "Diagram" && type.namespace.startsWith("http://www.omg.org/spec/UML/")
}

/** Read the primary model without executing profiles or following external URLs. */
export async function ingestMagicDraw(
  bytes: Uint8Array,
  input: { artifactPath: string },
): Promise<MagicDrawSource> {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error("MagicDraw archive exceeds 50 MiB.")
  const archive = await JSZip.loadAsync(bytes)
  const entry = archive.file(MODEL_ENTRY)
  if (!entry) throw new Error(`Unsupported MagicDraw archive: missing ${MODEL_ENTRY}.`)
  // JSZip exposes the ZIP directory's size here. Check before decompression too.
  const declaredSize = (entry as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize
  if (declaredSize !== undefined && declaredSize > MAX_MODEL_BYTES) {
    throw new Error("MagicDraw model exceeds 25 MiB.")
  }
  const modelBytes = await entry.async("uint8array")
  if (modelBytes.byteLength > MAX_MODEL_BYTES) throw new Error("MagicDraw model exceeds 25 MiB.")
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(modelBytes)
  // No DTD is needed for native XMI. Reject declarations before parsing entities.
  if (/<!DOCTYPE\s|<!ENTITY\s/i.test(xml)) throw new Error("DTD and entity declarations are not supported.")
  const errors: string[] = []
  const document = new DOMParser({
    onError: (_level, message) => errors.push(message),
  }).parseFromString(xml, "application/xml")
  if (errors.length || !document.documentElement) throw new Error(`Invalid MagicDraw XML: ${errors[0] ?? "missing root"}`)
  const root = document.documentElement
  if (!isXmi(root.namespaceURI) || root.localName !== "XMI") throw new Error("Expected a native XMI root.")
  const nodes: MagicDrawNode[] = []
  const profileDefinitions: MagicDrawSource["profileDefinitions"] = []
  for (const element of Array.from(document.getElementsByTagName("stereotype"))) {
    const name = element.getAttribute("name")
    const href = element.getAttribute("stereotypeHREF")
    if (!name || !href || !href.includes("#")) continue
    const [prefix, localName] = name.split(":")
    const namespace = element.lookupNamespaceURI(prefix)
    if (namespace && localName) profileDefinitions.push({ id: href.slice(href.lastIndexOf("#") + 1), namespace, name: localName, href })
  }
  // Resolve stereotype inheritance from bundled profile snapshots. Link each
  // resource through declared stereotype IDs; profile names alone are not proof.
  const declaredProfiles = [...profileDefinitions]
  let profileBytes = 0
  for (const cached of Object.values(archive.files)) {
    if (cached.dir || !cached.name.endsWith("resource_com$dnomagic$dmagicdraw$duml_umodel$dshared_umodel$dsnapshot")) continue
    const size = (cached as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize
    if (size !== undefined && profileBytes + size > MAX_MODEL_BYTES) throw new Error("Bundled profiles exceed 25 MiB.")
    const bytes = await cached.async("uint8array")
    profileBytes += bytes.byteLength
    if (profileBytes > MAX_MODEL_BYTES) throw new Error("Bundled profiles exceed 25 MiB.")
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    if (/<!DOCTYPE\s|<!ENTITY\s/i.test(text)) throw new Error("DTD and entity declarations are not supported.")
    const profileErrors: string[] = []
    const profile = new DOMParser({ onError: (_level, message) => profileErrors.push(message) }).parseFromString(text, "application/xml")
    if (profileErrors.length) throw new Error("Invalid bundled profile XML.")
    const stereotypes = Array.from(profile.getElementsByTagName("*" )).filter(element => {
      const type = element.getAttributeNS("http://www.w3.org/2001/XMLSchema-instance", "type")
      if (!type) return false
      const [prefix, name] = type.split(":")
      return name === "Stereotype" && ["http://www.nomagic.com/magicdraw/UML/2.5.1", "http://www.nomagic.com/magicdraw/UML/2.5.1.1"].includes(element.lookupNamespaceURI(prefix) ?? "")
    })
    const projectKey = cached.name.split("_resource_")[0].replace(/^proxy\.local__/, "").replace(/\$h/g, "-")
    const namespaces = new Set(stereotypes.flatMap(element => declaredProfiles
      .filter(def => def.href.startsWith(`local:/${projectKey}?`) && def.id === xmiAttribute(element, "id") && def.name === element.getAttribute("name"))
      .map(def => def.namespace)))
    if (namespaces.size !== 1) continue
    const namespace = [...namespaces][0]
    for (const element of stereotypes) {
      const id = xmiAttribute(element, "id"), name = element.getAttribute("name")
      if (!id || !name) continue
      if (declaredProfiles.some(def => def.id === id && def.namespace !== namespace)) continue
      const generalIds = childElements(element).filter(child => child.localName === "generalization").flatMap(child => {
        const general = child.getAttribute("general")
        return general ? general.split(/\s+/).filter(Boolean) : []
      })
      const existing = profileDefinitions.find(def => def.id === id && def.namespace === namespace)
      if (existing) existing.generalIds = generalIds
      else profileDefinitions.push({ id, namespace, name, href: `${cached.name}#${id}`, generalIds })
    }
  }
  const idIndex: Record<string, number> = Object.create(null)
  let omittedExtensions = 0

  const visit = (element: Element, parentIndex: number | null, depth: number): void => {
    if (depth > MAX_DEPTH) throw new Error("MagicDraw XML nesting exceeds 256 levels.")
    if (isExtension(element)) {
      omittedExtensions++
      // Diagram identities live inside vendor extensions. Keep those identities,
      // but do not treat their presentation objects as engineering model nodes.
      const findDiagrams = (container: Element, level: number): void => {
        if (level > MAX_DEPTH) throw new Error("MagicDraw XML nesting exceeds 256 levels.")
        for (const child of childElements(container)) {
          if (isDiagram(child)) visit(child, parentIndex, level)
          else findDiagrams(child, level + 1)
        }
      }
      findDiagrams(element, depth + 1)
      return
    }
    const id = xmiAttribute(element, "id")
    if (id !== undefined && Object.hasOwn(idIndex, id)) throw new Error(`Duplicate native XMI ID: ${id}`)
    const index = nodes.length
    const type = expandedType(element)
    const node: MagicDrawNode = {
      index,
      parentIndex,
      children: [],
      namespace: element.namespaceURI ?? "",
      localName: element.localName ?? element.nodeName,
      ...(id === undefined ? {} : { id }),
      ...(type === undefined ? {} : { type }),
      attributes: Array.from(element.attributes)
        .filter(attribute => attribute.namespaceURI !== "http://www.w3.org/2000/xmlns/")
        .map(attribute => ({ namespace: attribute.namespaceURI ?? "", localName: attribute.localName ?? attribute.name, value: attribute.value })),
      text: Array.from(element.childNodes)
        .filter(child => child.nodeType === 3 || child.nodeType === 4)
        .map(child => child.nodeValue ?? "").join(""),
    }
    nodes.push(node)
    if (id !== undefined) idIndex[id] = index
    if (parentIndex !== null) nodes[parentIndex].children.push(index)
    for (const child of childElements(element)) visit(child, index, depth + 1)
  }
  visit(root, null, 0)
  if (!nodes.some(node => (node.type?.localName === "Model" && node.type.namespace.startsWith("http://www.omg.org/spec/UML/")) ||
    (node.localName === "Model" && node.namespace.startsWith("http://www.omg.org/spec/UML/")))) {
    throw new Error("MagicDraw archive contains no UML model.")
  }

  const references: MagicDrawSource["references"] = []
  for (const node of nodes) {
    for (const attribute of node.attributes) {
      const kind = isXmi(attribute.namespace) && attribute.localName === "idref" ? "idref"
        : attribute.namespace === "" && attribute.localName === "href" ? "href" : null
      if (!kind) continue
      const localId = kind === "idref" ? attribute.value
        : attribute.value.startsWith("#") ? attribute.value.slice(1) : null
      references.push({ nodeIndex: node.index, kind, value: attribute.value,
        targetIndex: localId === null ? null : idIndex[localId] ?? null })
    }
  }
  const unresolved = references.filter(reference => reference.targetIndex === null).length
  return {
    kind: "magicdraw-source",
    schemaVersion: 1,
    source: { artifactPath: input.artifactPath, sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))), byte => byte.toString(16).padStart(2, "0")).join(""), archiveEntry: MODEL_ENTRY },
    nodes,
    idIndex,
    profileDefinitions,
    references,
    diagnostics: [
      { code: "primary-model-only", message: "Only the primary model is ingested. Bundled profile snapshots supply stereotype definitions and inheritance; external project models are not loaded." },
      { code: "presentation-omitted", message: "Diagram identities are retained. Vendor extensions, diagram layouts, and binary resources are omitted.", count: omittedExtensions },
      { code: "raw-native-properties", message: "Native attributes and child properties are preserved. Only explicit xmi:idref and local href references are resolved; attribute-encoded relationships remain raw." },
      ...(unresolved ? [{ code: "unresolved-references", message: "Some references target external resources or absent local IDs.", count: unresolved }] : []),
    ],
  }
}
