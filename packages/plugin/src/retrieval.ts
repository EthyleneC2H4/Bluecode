/** Retrieval uses the same instance and project namespace that published the refs. */
import { z } from "zod"
import {
  redactLocalPaths,
  paginateText,
  MAX_PAGE_TOKENS,
  MAX_PAGE_BYTES,
  DEFAULT_PAGE_TOKENS,
  DEFAULT_PAGE_BYTES,
} from "@bluecode/shared"
import type { HeadroomRetrieveParams } from "@bluecode/contracts"
import type { PluginRuntime } from "./runtime"
import { tool } from "./tool"

export function createRetrieveTool(runtime: PluginRuntime) {
  const shape = {
    hash: z
      .string()
      .regex(/^(?:sha256:)?[0-9a-f]{64}$/)
      .optional(),
    historyHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    query: z.string().optional(),
    nodeId: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    detail: z.enum(["summary", "children", "source"]).optional(),
    depth: z.coerce.number().int().nonnegative().max(20).optional(),
    cursor: z.string().max(4096).optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().positive().optional(),
    maxTokens: z.coerce.number().int().positive().optional(),
    maxBytes: z.coerce.number().int().positive().optional(),
  }
  return tool({
    description:
      "Recover archived evidence by hash (sha256: for tool output), historyHash, nodeId, or natural search query. Choose exactly one. Search returns short matching excerpts; expand only the relevant hash or node. nodeId accepts detail summary, children, or source and optional child depth. Responses are bounded; pass nextCursor verbatim when more evidence is needed. Retrieved text bypasses compression.",
    args: shape,
    async execute(args, context) {
      if ([args.hash, args.historyHash, args.query, args.nodeId].filter((v) => v !== undefined).length !== 1)
        throw new Error("Choose exactly one of hash, historyHash, query, nodeId")
      if ((args.detail !== undefined || args.depth !== undefined) && !args.nodeId)
        throw new Error("detail and depth require nodeId")
      if (args.offset !== undefined && args.historyHash === undefined)
        throw new Error("offset requires historyHash")
      const namespace = runtime.namespace(context.sessionID)
      const maxTokens = Math.min(args.maxTokens ?? DEFAULT_PAGE_TOKENS, MAX_PAGE_TOKENS)
      const maxBytes = Math.min(args.maxBytes ?? DEFAULT_PAGE_BYTES, MAX_PAGE_BYTES)
      const layered = runtime.strategy() === "layered"
      const envelopeBudget = Math.min(maxTokens * (layered ? 4 : 1), maxBytes)
      const boundedError = (text: string) =>
        paginateText(text, {
          ref: "retrieval-error",
          maxBytes: envelopeBudget,
          maxTokens: envelopeBudget,
        }).content
      let contentBudget = Math.max(1, Math.floor(envelopeBudget / 2))
      let limit = Math.min(args.limit ?? (args.query !== undefined ? 5 : 10), 50)
      context.metadata({ metadata: { bluecode: { retrieved: true } } })
      try {
        for (let attempt = 0; attempt < 8; attempt++) {
          const paging = {
            maxTokens: contentBudget,
            maxBytes: contentBudget,
            ...(args.cursor ? { cursor: args.cursor } : {}),
          }
          let result: unknown
          if (args.hash?.startsWith("sha256:")) {
            const client = runtime.rtk()
            if (!client)
              return boundedError("RTK archive is unavailable; retry after the sidecar reconnects.")
            result = await client.fetch({
              hash: args.hash,
              sessionId: JSON.stringify([namespace.projectId, namespace.sessionId]),
              ...paging,
            })
          } else {
            const client = runtime.headroom()
            if (!client)
              return boundedError(
                "History archive is unavailable; retry after the sidecar reconnects."
              )
            const params: HeadroomRetrieveParams = args.hash
              ? { namespace, hash: args.hash, ...paging }
              : args.historyHash
              ? {
                  namespace,
                  historyHash: args.historyHash,
                  offset: args.offset ?? 0,
                  limit,
                  ...paging,
                }
              : args.nodeId
              ? { namespace, nodeId: args.nodeId, ...(args.detail ? { detail: args.detail } : {}),
                  ...(args.depth !== undefined ? { depth: args.depth } : {}), ...paging }
              : { namespace, query: args.query!, limit, style: layered ? "cards" : "segments", ...paging }
            result = await client.retrieve(params)
          }
          const output = JSON.stringify(result)
          const size = Buffer.byteLength(output)
          if (size <= envelopeBudget)
            return {
              title: "Archived evidence",
              output,
              metadata: {
                bluecode: {
                  retrieved: true,
                  tokenCountKind: layered ? "chars-div-4-estimate" : "utf8-upper-bound",
                  maxTokens,
                  maxBytes,
                },
              },
            }
          // Refetch from the SAME input cursor with a smaller evidence allowance.
          // Never trim a returned page: that would silently skip its omitted tail.
          contentBudget = Math.max(1, contentBudget - (size - envelopeBudget) - 32)
          if (args.historyHash) limit = Math.max(1, Math.floor(limit / 2))
        }
        return boundedError("Retrieval budget too small for a cursor and evidence.")
      } catch (error) {
        return boundedError(
          `Archive retrieval failed: ${redactLocalPaths(
            error instanceof Error ? error.message : String(error)
          )}`
        )
      }
    },
  })
}
