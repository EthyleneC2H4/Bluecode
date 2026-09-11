import { layeredNodeSchema, type LayeredNode, type Namespace } from "@bluecode/contracts"
import { nodeContentHash } from "../layered"
import { ownsCasMeta, type HeadroomDb } from "./db"

export function initializeNodes(meta: HeadroomDb): void {
  meta.db.exec(`CREATE TABLE IF NOT EXISTS layered_nodes(
    project_id TEXT NOT NULL, session_id TEXT NOT NULL, node_id TEXT NOT NULL,
    level INTEGER NOT NULL, node TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(project_id,session_id,node_id));
    CREATE INDEX IF NOT EXISTS layered_node_level ON layered_nodes(project_id,session_id,level);
    CREATE TABLE IF NOT EXISTS layered_node_sources(
      project_id TEXT NOT NULL, session_id TEXT NOT NULL, node_id TEXT NOT NULL, hash TEXT NOT NULL,
      PRIMARY KEY(project_id,session_id,node_id,hash));
    CREATE INDEX IF NOT EXISTS layered_node_source_hash ON layered_node_sources(project_id,session_id,hash);`)
}

function validateIdentity(node: LayeredNode): void {
  const { nodeId, ...content } = node
  if (nodeContentHash(content) !== nodeId) throw new Error("Layered node identity mismatch")
}

export function readNode(meta: HeadroomDb, ns: Namespace, id: string): LayeredNode | null {
  const row = meta.db.prepare("SELECT node FROM layered_nodes WHERE project_id=? AND session_id=? AND node_id=?")
    .get(ns.projectId, ns.sessionId, id) as { node: string } | null
  if (!row) return null
  const node = layeredNodeSchema.parse(JSON.parse(row.node))
  validateIdentity(node)
  if (node.namespace.projectId !== ns.projectId || node.namespace.sessionId !== ns.sessionId || node.nodeId !== id)
    throw new Error("Layered node namespace mismatch")
  return node
}

/** Raw evidence is confirmed by the caller before this atomic metadata commit. */
export function saveNodes(meta: HeadroomDb, ns: Namespace, nodes: readonly LayeredNode[]): void {
  meta.db.transaction(() => {
    for (const value of [...nodes].sort((a, b) => a.level - b.level || a.nodeId.localeCompare(b.nodeId))) {
      const node = layeredNodeSchema.parse(value)
      validateIdentity(node)
      if (node.namespace.projectId !== ns.projectId || node.namespace.sessionId !== ns.sessionId)
        throw new Error("Layered node namespace mismatch")
      for (const ref of node.sourceRefs)
        if (!ownsCasMeta(meta, ns, ref.contentHash)) throw new Error("Layered node evidence is not archived in namespace")
      for (const childId of node.children) {
        const child = readNode(meta, ns, childId)
        if (!child || child.level >= node.level) throw new Error("Layered node has invalid child")
      }
      const existing = readNode(meta, ns, node.nodeId)
      if (existing && JSON.stringify(existing) !== JSON.stringify(node)) throw new Error("Immutable node collision")
      meta.db.prepare("INSERT OR IGNORE INTO layered_nodes VALUES(?,?,?,?,?,?)")
        .run(ns.projectId, ns.sessionId, node.nodeId, node.level, JSON.stringify(node), Date.now())
      for (const ref of node.sourceRefs) meta.db.prepare("INSERT OR IGNORE INTO layered_node_sources VALUES(?,?,?,?)")
        .run(ns.projectId, ns.sessionId, node.nodeId, ref.contentHash)
    }
  })()
}

export function nodesForSource(meta: HeadroomDb, ns: Namespace, hash: string): string[] {
  return (meta.db.prepare("SELECT node_id FROM layered_node_sources WHERE project_id=? AND session_id=? AND hash=? ORDER BY node_id LIMIT 3")
    .all(ns.projectId, ns.sessionId, hash) as Array<{ node_id: string }>).map((row) => row.node_id)
}

/** Read only the active graph's roots when preparing another generation. */
export function nodesForView(meta: HeadroomDb, ns: Namespace, ids: readonly string[]): LayeredNode[] {
  const visited = new Set<string>(), result: LayeredNode[] = []
  const queue = [...new Set(ids)]
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!
    if (visited.has(id)) continue
    if (visited.size >= 16384) throw new Error("Active node graph exceeds planning capacity")
    visited.add(id)
    const node = readNode(meta, ns, id)
    if (!node) continue
    result.push(node)
    queue.push(...node.children)
  }
  return result
}
