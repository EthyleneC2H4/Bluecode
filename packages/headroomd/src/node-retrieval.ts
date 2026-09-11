import type { LayeredNode, LayeredSourceRef, RetrieveByNodeParams, RetrieveByNodeResult } from "@bluecode/contracts"
import { decodeCursor, encodeCursor, paginateText } from "@bluecode/shared"
import { readNode } from "./store/nodes"
import { loadHistoryCursor, saveHistoryCursor } from "./store/history-cursors"
import { readMessageObject, renderProjection } from "./store/objects"
import { ownsCasMeta, type HeadroomDb } from "./store/db"
import { readHistoryPage } from "./history-reader"

const descriptor = (node: LayeredNode) => ({ nodeId: node.nodeId, level: node.level, policyVersion: node.policyVersion, tokens: node.tokens, sourceTokens: node.sourceTokens })

export async function retrieveNode(meta: HeadroomDb, dataDir: string, params: RetrieveByNodeParams): Promise<RetrieveByNodeResult> {
  const root = readNode(meta, params.namespace, params.nodeId)
  if (!root) return { found: false }
  const detail = params.detail ?? "summary"
  const ref = JSON.stringify([params.namespace, params.nodeId, detail, params.depth ?? 1])
  const maxBytes = Math.min(params.maxBytes ?? 32768, 131072)
  const maxTokens = Math.min(params.maxTokens ?? 2048, 8192)
  // Count the full JSON envelope with the declared chars/4 estimate, separately from bytes.
  const fits = (value: unknown) => {
    const text = JSON.stringify(value)
    return Buffer.byteLength(text) <= maxBytes && Math.ceil(text.length / 4) <= maxTokens
  }
  const base = { found: true as const, node: descriptor(root), content: "" }
  if (detail === "children") {
    const ids: string[] = []
    const visit = (node: LayeredNode, depth: number, ancestors: Set<string>) => {
      if (ancestors.has(node.nodeId)) throw new Error("Invalid node lineage")
      if (depth <= 0 || !node.children.length) { ids.push(node.nodeId); return }
      const next = new Set(ancestors).add(node.nodeId)
      for (const id of node.children) {
        const child = readNode(meta, params.namespace, id)
        if (!child) throw new Error("Node child is missing")
        visit(child, depth - 1, next)
      }
    }
    visit(root, params.depth ?? 1, new Set())
    let index = decodeCursor(params.cursor, ref)
    if (index > ids.length) throw new Error("Cursor outside node children")
    const children: Array<{ nodeId: string; level: number; tokens: number }> = []
    while (index < ids.length) {
      const node = readNode(meta, params.namespace, ids[index]!)!
      const next = [...children, { nodeId: node.nodeId, level: node.level, tokens: node.tokens }]
      const result = { ...base, children: next, nextCursor: index + 1 < ids.length ? encodeCursor(ref, index + 1) : null, truncated: index + 1 < ids.length }
      if (!fits(result)) break
      children.push(next.at(-1)!)
      index++
    }
    if (!children.length && index < ids.length) throw new Error("Node retrieval budget cannot fit a reference")
    return { ...base, children, nextCursor: index < ids.length ? encodeCursor(ref, index) : null, truncated: index < ids.length }
  }
  let allowance = Math.max(1, Math.min(maxBytes, maxTokens * 4) - 512)
  for (let attempt = 0; attempt < 8; attempt++) {
    let result: RetrieveByNodeResult
    if (detail === "summary") {
      const page = paginateText(root.text, { ref, ...(params.cursor ? { cursor: params.cursor } : {}), maxBytes: allowance, maxTokens: allowance })
      result = { ...base, content: page.content, nextCursor: page.nextCursor, truncated: page.truncated }
    } else {
      const state = params.cursor ? loadHistoryCursor(meta, params.namespace, ref, params.cursor) : { stack: [{ hash: root.nodeId, offset: 0 }], ordinal: 0, intra: 0 }
      const actions = new Map<string, { child: string } | { source: LayeredSourceRef }>()
      let projection: Awaited<ReturnType<typeof readMessageObject>> = null
      const page = await readHistoryPage({
        row: async (id, offset) => {
          const node = readNode(meta, params.namespace, id)
          if (!node) throw new Error("Node child is missing")
          const child = node.children[offset]
          if (child) { actions.set(child, { child }); return { hash: child, role: "assistant", turnIndex: state.ordinal } }
          const source = node.sourceRefs[offset - node.children.length]
          if (!source) return null
          if (!ownsCasMeta(meta, params.namespace, source.contentHash)) throw new Error("Node source is not owned by namespace")
          projection = await readMessageObject(dataDir, source.contentHash)
          actions.set(source.contentHash, { source })
          return { hash: source.contentHash, role: projection?.info.role ?? "assistant", turnIndex: state.ordinal }
        },
        content: async ({ hash }) => {
          const action = actions.get(hash)!
          if ("child" in action) return action
          const message = projection
          if (!message) return null
          const source = action.source
          const part = source.partIndex !== undefined ? message.parts[source.partIndex] : undefined
          let text = part ? part.type === "text" ? part.text : part.state.output ?? part.state.error ?? "" : renderProjection(message)
          if (source.start !== undefined) text = text.slice(source.start, source.end)
          return { text }
        },
      }, state, { maxBytes: allowance, maxTokens: allowance, limit: 1 })
      if (page.missingHashes.length) throw new Error("Node source object is missing; archive is incomplete")
      result = { ...base, sourceItems: page.items, nextCursor: page.more ? saveHistoryCursor(meta, params.namespace, ref, page.state) : null, truncated: page.more }
    }
    if (fits(result)) return result
    allowance = Math.max(1, Math.floor(allowance / 2))
  }
  throw new Error("Node retrieval budget cannot fit the JSON envelope")
}
