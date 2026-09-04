/**
 * headroom_retrieve custom tool definition.
 *
 * Allows retrieving archived content by content hash, history hash, or query.
 *
 * Hash forms (the retrieval bridge — headroomd's reader cannot decode rtk's
 * CAS objects and vice versa, so the ROUTING lives here at the tool layer):
 * - `sha256:<64 hex>` → rtk CAS (canonical sanitized compressed tool output)
 * - `<64 hex>` bare   → headroomd archive (history turns)
 */
import { z } from "zod";
import { tool } from "./tool";
import type { ToolContext, ToolResult } from "./tool";
import { HeadroomClient } from "@bluecode/headroomd";
import type {
  HeadroomRetrieveParams,
  HeadroomRetrieveResult,
  RetrieveByHashResult,
  RetrieveByHistoryResult,
  RetrieveByQueryResult,
} from "@bluecode/contracts";
import { redactLocalPaths } from "@bluecode/shared";
import { getSharedHeadroomClient } from "./headroom";
import { getSharedRtkClient } from "./rtk-hook";

/** Protocol hygiene cap on query hits; truncate rather than error for LLM callers. */
const MAX_QUERY_LIMIT = 50;

/**
 * Get the shared HeadroomClient instance (initialized by the plugin factory).
 */
function getClient(): HeadroomClient | null {
  return getSharedHeadroomClient();
}

const RetrieveArgsShape = {
  hash: z
    .string()
    .regex(/^(?:sha256:)?[0-9a-f]{64}$/, "hash must be [\"sha256:\"] + 64 lowercase hex chars")
    .optional(),
  historyHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "historyHash must be 64 lowercase hex chars")
    .optional(),
  query: z.string().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  // LLM clients routinely stringify numerics (M7 real-session smoke: the
  // model sent limit="2" and strict zod rejected it) — coerce instead.
  limit: z.coerce.number().int().positive().optional(),
} satisfies z.ZodRawShape;

type RetrieveArgs = z.infer<z.ZodObject<typeof RetrieveArgsShape>>;

/**
 * Full schema enforcing exactly one retrieval mode. The raw
 * shape above is what opencode registers; execute re-parses through this
 * schema so the refine holds even when the host skips pre-validation.
 */
const RetrieveArgsSchema = z
  .object(RetrieveArgsShape)
  .superRefine((args, context) => {
    const modes = [args.hash, args.historyHash, args.query].filter(
      (value) => value !== undefined,
    ).length
    if (modes !== 1) {
      context.addIssue({
        code: "custom",
        message: "Exactly one of 'hash', 'historyHash', or 'query' must be provided",
      })
    }
    if (args.offset !== undefined && args.historyHash === undefined) {
      context.addIssue({
        code: "custom",
        path: ["offset"],
        message: "offset is only valid with historyHash",
      })
    }
  });

export const headroomRetrieveTool = tool({
  description:
    "Retrieve archived content by one of: a content hash, a paged historyHash, or a search query. " +
    "Hash forms: bare 64-hex searches the history archive; \"sha256:\"-prefixed 64-hex fetches the canonical sanitized tool output that compression stored.",
  args: RetrieveArgsShape,
  execute: async (args: RetrieveArgs, context: ToolContext): Promise<ToolResult> => {
    // Enforces the refine (and the shape) — throws ZodError on violation.
    const validated = RetrieveArgsSchema.parse(args);

    // Retrieval bridge FIRST, before any headroomd availability guard: the two
    // sidecars fail independently (factory continues when either connect fails),
    // and a sha256: fetch must work whenever rtk is alive — even mid-headroomd
    // outage. Bare hex falls through to the headroomd archive below.
    if (validated.hash !== undefined && validated.hash.startsWith("sha256:")) {
      const rtk = getSharedRtkClient();
      if (rtk === null) {
        return "Error: rtk client not available. Tool-output originals are only retrievable while output compression is connected.";
      }
      try {
        // rtk's wire form IS the prefixed hash — pass through verbatim.
        const outcome = await rtk.fetch({ hash: validated.hash, sessionId: context.sessionID });
        switch (outcome.kind) {
          case "found":
            return `**Historical content retrieved (hash: \`${validated.hash}\`):**\n\n${outcome.content}`;
          case "missing":
            return `**No content found** for hash: \`${validated.hash}\``;
          case "unavailable":
            // rtk's DegradedReason is the bare enum string itself.
            return `Error retrieving history: rtk degraded (${outcome.degraded}); canonical output unavailable.`;
        }
      } catch (err) {
        return `Error retrieving history: ${redactLocalPaths((err as Error).message)}`;
      }
    }

    const client = getClient();
    if (client === null) {
      return "Error: headroomd client not available. The history retrieval daemon is not connected.";
    }

    // Clamp at the tool boundary: contracts reject limit > 50 with
    // E_INVALID_PARAMS, but an LLM caller asking for 200 hits wants its first
    // 50, not a protocol error. Direct UDS callers keep the strict rejection.
    // Query mode is namespace-scoped server-side, so the session must be the
    // REAL one this tool was invoked in — archives live under their session
    // IDs, and a placeholder like "current" would search an empty namespace.
    // Content-hash and history-hash lookup are namespace-checked server-side.
    const namespace = { projectId: "default", sessionId: context.sessionID };

    try {
      const params: HeadroomRetrieveParams = validated.hash !== undefined
        ? { namespace, hash: validated.hash }
        : validated.historyHash !== undefined
          ? {
              namespace,
              historyHash: validated.historyHash,
              offset: validated.offset ?? 0,
              limit: Math.min(validated.limit ?? 10, MAX_QUERY_LIMIT),
            }
          : {
              namespace,
              query: validated.query!,
              limit: Math.min(validated.limit ?? 5, MAX_QUERY_LIMIT),
            };

      const result: HeadroomRetrieveResult = await client.retrieve(params);

      // Type guard to distinguish between hash and query results.
      // Keyed on "found", not "content": the found:false union member carries
      // no content field, so a "content" check misroutes miss results into
      // the unexpected-format fallback (M7 real-session smoke).
      const isHashResult = (r: HeadroomRetrieveResult): r is RetrieveByHashResult =>
        validated.hash !== undefined && "found" in r;
      const isHistoryResult = (r: HeadroomRetrieveResult): r is RetrieveByHistoryResult =>
        validated.historyHash !== undefined && "found" in r;
      const isQueryResult = (r: HeadroomRetrieveResult): r is RetrieveByQueryResult => "hits" in r;

      if (isHashResult(result)) {
        // Hash retrieval result
        if (result.found) {
          return `**Historical content retrieved (hash: \`${validated.hash}\`):**\n\n${result.content}`;
        } else {
          return `**No content found** for hash: \`${validated.hash}\``;
        }
      } else if (isHistoryResult(result)) {
        if (!result.found) {
          return `**No archived history found** for historyHash: \`${validated.historyHash}\``;
        }
        const lines = [
          `**Archived history (historyHash: \`${validated.historyHash}\`):**`,
        ]
        for (const item of result.items) {
          lines.push(`\n- turn ${item.turnIndex} (${item.role}) \`${item.contentHash}\``)
          lines.push(item.content)
        }
        if (result.partial) {
          lines.push(`\n**Warning: partial page. Missing/corrupt hashes:** ${result.missingHashes.map((hash) => `\`${hash}\``).join(", ")}`)
        }
        if (result.nextOffset !== null) {
          lines.push(`\nContinue with next offset: ${result.nextOffset}`)
        }
        return lines.join("\n")
      } else if (isQueryResult(result)) {
        // Query retrieval result
        if (result.hits.length === 0) {
          return `**No matches found** for query: "${validated.query}"`;
        }
        const lines = [`**Search results for "${validated.query}" (top ${result.hits.length}):**\n`];
        for (const hit of result.hits) {
          lines.push(`- **Score:** ${hit.score.toFixed(3)} | **Hash:** \`${hit.hash}\` | **Turn:** ${hit.turnIndex} | **Role:** ${hit.role}`);
          lines.push(`  \`\`\``);
          lines.push(`  ${hit.snippet}`);
          lines.push(`  \`\`\``);
          lines.push("");
        }
        return lines.join("\n");
      }
      // Fallback for unexpected result type
      return "Error retrieving history: Unexpected result format";
    } catch (err) {
      // Egress scrub: connect/spawn errors embed local absolute paths
      // (socket path, entry path) — never leak them into model context.
      return `Error retrieving history: ${redactLocalPaths((err as Error).message)}`;
    }
  },
});
