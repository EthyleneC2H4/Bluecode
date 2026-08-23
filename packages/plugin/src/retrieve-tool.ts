/**
 * headroom_retrieve custom tool definition.
 *
 * Allows retrieving original conversation content by hash or query.
 */
import { z } from "zod";
import { tool } from "./tool";
import type { ToolContext, ToolResult } from "./tool";
import { HeadroomClient } from "@bluecode/headroomd";
import type { HeadroomRetrieveParams, HeadroomRetrieveResult, RetrieveByHashResult, RetrieveByQueryResult } from "@bluecode/contracts";

let headroomClient: HeadroomClient | null = null;

/**
 * Get the headroom client instance (initialized by the plugin factory).
 */
export function setHeadroomClient(client: HeadroomClient | null): void {
  headroomClient = client;
}

const RetrieveArgsShape = {
  hash: z.string().regex(/^[0-9a-f]{64}$/, "hash must be 64 lowercase hex chars").optional(),
  query: z.string().optional(),
  // LLM clients routinely stringify numerics (M7 real-session smoke: the
  // model sent limit="2" and strict zod rejected it) — coerce instead.
  limit: z.coerce.number().int().positive().default(5),
} satisfies z.ZodRawShape;

type RetrieveArgs = z.infer<z.ZodObject<typeof RetrieveArgsShape>>;

/**
 * Full schema WITH the brief's refine ("at least one of hash/query"). The raw
 * shape above is what opencode registers; execute re-parses through this
 * schema so the refine holds even when the host skips pre-validation.
 */
const RetrieveArgsSchema = z
  .object(RetrieveArgsShape)
  .refine((a) => a.hash !== undefined || a.query !== undefined, {
    message: "Either 'hash' or 'query' must be provided",
  });

export const headroomRetrieveTool = tool({
  description: "Retrieve original conversation content from headroomd history store by content hash or search query.",
  args: RetrieveArgsShape,
  execute: async (args: RetrieveArgs, context: ToolContext): Promise<ToolResult> => {
    // Enforces the refine (and the shape) — throws ZodError on violation.
    RetrieveArgsSchema.parse(args);

    if (headroomClient === null) {
      return "Error: headroomd client not available. The history retrieval daemon is not connected.";
    }

    // Query mode is namespace-scoped server-side, so the session must be the
    // REAL one this tool was invoked in — archives live under their session
    // IDs, and a placeholder like "current" would search an empty namespace.
    // By-hash ignores namespace by design (content is the address), but using
    // the real ID costs nothing and keeps both modes honest.
    const namespace = { projectId: "default", sessionId: context.sessionID };

    try {
      const params: HeadroomRetrieveParams = args.hash !== undefined
        ? { namespace, hash: args.hash }
        : { namespace, query: args.query!, limit: args.limit };

      const result: HeadroomRetrieveResult = await headroomClient.retrieve(params);

      // Type guard to distinguish between hash and query results.
      // Keyed on "found", not "content": the found:false union member carries
      // no content field, so a "content" check misroutes miss results into
      // the unexpected-format fallback (M7 real-session smoke).
      const isHashResult = (r: HeadroomRetrieveResult): r is RetrieveByHashResult => "found" in r;
      const isQueryResult = (r: HeadroomRetrieveResult): r is RetrieveByQueryResult => "hits" in r;

      if (isHashResult(result)) {
        // Hash retrieval result
        if (result.found) {
          return `**Historical content retrieved (hash: \`${args.hash}\`):**\n\n${result.content}`;
        } else {
          return `**No content found** for hash: \`${args.hash}\``;
        }
      } else if (isQueryResult(result)) {
        // Query retrieval result
        if (result.hits.length === 0) {
          return `**No matches found** for query: "${args.query}"`;
        }
        const lines = [`**Search results for "${args.query}" (top ${result.hits.length}):**\n`];
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
      return `Error retrieving history: ${(err as Error).message}`;
    }
  },
});