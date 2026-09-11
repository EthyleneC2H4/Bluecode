import type { LayeredNode, LayeredSourceRef, RetrieveByNodeParams, RetrieveByNodeResult } from "@bluecode/contracts"
import { paginateText } from "@bluecode/shared"
import { readNode } from "./store/nodes"
import { loadHistoryCursor, saveHistoryCursor } from "./store/history-cursors"
import { readMessageObject, renderProjection } from "./store/objects"
import { ownsCasMeta, type HeadroomDb } from "./store/db"
import { readHistoryPage, type HistoryFrontier } from "./history-reader"

const descriptor = (node: LayeredNode) => ({ nodeId: node.nodeId, level: node.level, policyVersion: node.policyVersion, tokens: node.tokens, sourceTokens: node.sourceTokens })

type ChildDescriptor = { nodeId: string; level: number; tokens: number }
/** Traverse only as far as the next bounded page; the stack survives daemon restart. */
export function readNodeChildren(
  read: (id: string) => (ChildDescriptor & { children: string[] }) | null,
  depth: number, original: HistoryFrontier, accepts: (items: ChildDescriptor[]) => boolean,
) {
  const state = structuredClone(original), children: ChildDescriptor[] = []
  while (state.stack.length) {
    const frame = state.stack.at(-1)!
    const node = read(frame.hash)
    if (!node) throw new Error("Node child is missing")
    if (state.stack.length - 1 >= depth || !node.children.length) {
      const entry = { nodeId: node.nodeId, level: node.level, tokens: node.tokens }
      if (!accepts([...children, entry])) break
      children.push(entry)
      state.stack.pop()
      state.ordinal++
      continue
    }
    const child = node.children[frame.offset]
    if (!child) { state.stack.pop(); continue }
    if (state.stack.some((part) => part.hash === child)) throw new Error("Invalid node lineage")
    frame.offset++
    state.stack.push({ hash: child, offset: 0 })
  }
  return { children, state, more: state.stack.length > 0 }
}

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
    const state = params.cursor ? loadHistoryCursor(meta, params.namespace, ref, params.cursor) : { stack: [{ hash: root.nodeId, offset: 0 }], ordinal: 0, intra: 0 }
    const page = readNodeChildren((id) => readNode(meta, params.namespace, id), params.depth ?? 1, state,
      (children) => fits({ ...base, children, nextCursor: `h3-${"0".repeat(36)}`, truncated: true }))
    if (!page.children.length && page.more) throw new Error("Node retrieval budget cannot fit a reference")
    const result = { ...base, children: page.children, nextCursor: page.more ? saveHistoryCursor(meta, params.namespace, ref, page.state) : null, truncated: page.more }
    if (!fits(result)) throw new Error("Node retrieval budget cannot fit the JSON envelope")
    return result
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
