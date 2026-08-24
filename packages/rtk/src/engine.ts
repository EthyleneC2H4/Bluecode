/**
 * Business orchestration behind the rtk wire ops.
 *
 * compress: contracts per-op schema first (wire defaults such as
 * budgetTokens=512 materialize here) -> @bluecode/rtk-core pipeline ->
 * rawForStore persisted to CAS -> wire-shaped CompressResult. The CAS write
 * is what makes `fetch(rawHash)` round-trips work; the pipeline hashes the
 * post-sanitize/redact text, so nothing secret ever reaches the store.
 *
 * fetch: format-checked hash -> CAS read -> text content.
 */
import {
  compressParamsSchema,
  fetchParamsSchema,
  type CompressResult,
  type FetchResult,
} from "@bluecode/contracts";
import {
  compressToolOutput,
  createPipelineStats,
  type PipelineStatsSnapshot,
} from "@bluecode/rtk-core";
import { chmodSync, mkdirSync } from "node:fs";
import { defaultSidecarDataDir, readObject, writeObject } from "@bluecode/shared";

/**
 * Fallback store root when BLUECODE_DATA_DIR is unset. Namespaced per uid /
 * XDG_RUNTIME_DIR by @bluecode/shared: a fixed <tmpdir>/bluecode-rtk is
 * writable by every account on multi-user hosts, letting one account plant
 * objects another account's fetch() would happily serve.
 */
export const DEFAULT_DATA_DIR = defaultSidecarDataDir("bluecode-rtk");

/**
 * Production supplies the store root from plugin configuration via the
 * BLUECODE_DATA_DIR environment variable (the rtk client always passes it
 * through to the server process); the tmpdir default keeps dev/test servers
 * self-contained.
 */
export function resolveDataDir(fromEnv?: string | undefined): string {
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : DEFAULT_DATA_DIR;
}

export interface RtkEngine {
  /** Wire params (unvalidated) in, validated CompressResult out. */
  compress(params: unknown): Promise<CompressResult>;
  /** Wire params (unvalidated) in, FetchResult out. */
  fetch(params: unknown): Promise<FetchResult>;
  /** Counter snapshot for the stats op (uptimeMs is added by the server). */
  pipelineSnapshot(): PipelineStatsSnapshot;
}

export function createEngine(options: { dataDir: string }): RtkEngine {
  const { dataDir } = options;
  // Create the store root up front with owner-only permissions: the CAS layer
  // mkdirs lazily without a mode, so on shared <tmpdir> targets (Linux) an
  // attacker could otherwise create/plant objects first. chmod even when the
  // dir already exists — test mkdtemp roots are already 0700; production
  // injected paths may not be. macOS tmpdir is per-user; redundant but safe.
  mkdirSync(dataDir, { recursive: true });
  chmodSync(dataDir, 0o700);
  const stats = createPipelineStats();
  const decoder = new TextDecoder();

  return {
    async compress(params) {
      // Per-op schema: validation AND defaults (budgetTokens etc.) land here.
      // sessionId/callId are wire-only association fields (plugin-side
      // logging); rtk-core's pipeline deliberately does not consume them.
      const parsed = compressParamsSchema.parse(params);
      const run = await compressToolOutput({
        tool: parsed.tool,
        output: parsed.output,
        title: parsed.title,
        metadata: parsed.metadata,
        budgetTokens: parsed.budgetTokens,
      });

      // Persist the exact post-sanitize text whose hash is rawHash. The
      // recomputed hash doubles as a corruption tripwire: pipeline and CAS
      // disagreeing is an internal bug and surfaces as E_INTERNAL upstream.
      const stored = await writeObject(dataDir, run.rawForStore);
      const expectedHex = run.rawHash.slice("sha256:".length);
      if (stored.hash !== expectedHex) {
        throw new Error(
          `cas hash mismatch: stored ${stored.hash} but pipeline hashed ${expectedHex}`,
        );
      }

      // Wire result only — rawForStore/notes are internal pipeline extras.
      const result: CompressResult = {
        output: run.output,
        rawHash: run.rawHash,
        strategy: run.strategy,
        compressed: run.compressed,
        truncated: run.truncated,
        rawTokensEst: run.rawTokensEst,
        outTokensEst: run.outTokensEst,
        degraded: run.degraded,
      };
      stats.record(result);
      return result;
    },

    async fetch(params) {
      const { hash } = fetchParamsSchema.parse(params);
      const hex = hash.slice("sha256:".length);
      const bytes = await readObject(dataDir, hex);
      if (bytes === null) return { found: false };
      return { found: true, content: decoder.decode(bytes) };
    },

    pipelineSnapshot: () => stats.snapshot(),
  };
}
