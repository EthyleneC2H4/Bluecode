/**
 * Business orchestration behind the rtk wire ops.
 *
 * compress: contracts per-op schema first (wire defaults such as
 * budgetTokens=512 materialize here) -> @bluecode/rtk-core pipeline ->
 * rawForStore persisted to CAS -> session ownership persisted -> wire-shaped
 * CompressResult. The stored value is the pipeline's canonical
 * post-sanitize/redact text (the default redactor is intentionally a no-op).
 *
 * fetch: format-checked hash -> CAS read -> text content.
 */
import {
  compressParamsSchema,
  fetchParamsSchema,
  type CompressResult,
  type FetchResult,
} from "@bluecode/contracts"
import {
  compressToolOutput,
  createPipelineStats,
  type PipelineStatsSnapshot,
} from "@bluecode/rtk-core"
import { chmodSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs"
import { readObject, writeObject, paginateText } from "@bluecode/shared"
import { DEFAULT_DATA_DIR } from "./paths"
import { openOwnershipStore } from "./ownership"

/**
 * Durable per-user store root when BLUECODE_DATA_DIR is unset.
 */
export { DEFAULT_DATA_DIR }

/**
 * Production supplies the store root from plugin configuration via the
 * BLUECODE_DATA_DIR environment variable (the rtk client always passes it
 * through to the server process). Tests explicitly use unique temporary roots.
 */
export function resolveDataDir(fromEnv?: string | undefined): string {
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : DEFAULT_DATA_DIR
}

export interface RtkEngine {
  /** Wire params (unvalidated) in, validated CompressResult out. */
  compress(params: unknown): Promise<CompressResult>
  /** Wire params (unvalidated) in, FetchResult out. */
  fetch(params: unknown): Promise<FetchResult>
  /** Counter snapshot for the stats op (uptimeMs is added by the server). */
  pipelineSnapshot(): PipelineStatsSnapshot
  close(): void
}

export function createEngine(options: { dataDir: string; maxStorageBytes?: number }): RtkEngine {
  const { dataDir } = options
  const maxStorageBytes = options.maxStorageBytes ?? 1024 ** 3
  const existingObjects: Array<{ hash: string; size: number }> = []
  const objects = `${dataDir}/objects`
  if (existsSync(objects)) {
    for (const bucket of readdirSync(objects, { withFileTypes: true })) {
      if (!bucket.isDirectory() || !/^[0-9a-f]{2}$/.test(bucket.name)) continue
      for (const file of readdirSync(`${objects}/${bucket.name}`, { withFileTypes: true })) {
        if (file.isFile() && /^[0-9a-f]{64}$/.test(file.name))
          existingObjects.push({
            hash: file.name,
            size: statSync(`${objects}/${bucket.name}/${file.name}`).size,
          })
      }
    }
  }
  let storageTail: Promise<void> = Promise.resolve()
  // Create the store root up front with owner-only permissions: the CAS layer
  // mkdirs lazily without a mode, so on shared <tmpdir> targets (Linux) an
  // attacker could otherwise create/plant objects first. chmod even when the
  // dir already exists — test mkdtemp roots are already 0700; production
  // injected paths may not be. macOS tmpdir is per-user; redundant but safe.
  mkdirSync(dataDir, { recursive: true })
  chmodSync(dataDir, 0o700)
  const ownership = openOwnershipStore(dataDir)
  // Backfill legacy objects; pending entries are reconciled only while holding
  // the cross-process publication mutex, preserving live reservations.
  for (const object of existingObjects)
    ownership.reserve(object.hash, object.size, Number.MAX_SAFE_INTEGER)
  const stats = createPipelineStats()
  const decoder = new TextDecoder()

  return {
    async compress(params) {
      // Per-op schema: validation AND defaults (budgetTokens etc.) land here.
      // sessionId/callId are wire-only association fields (plugin-side
      // logging); rtk-core's pipeline deliberately does not consume them.
      const parsed = compressParamsSchema.parse(params)
      const run = await compressToolOutput({
        tool: parsed.tool,
        output: parsed.output,
        title: parsed.title,
        toolArgs: parsed.toolArgs,
        source: parsed.source,
        provenance: parsed.provenance,
        metadata: parsed.metadata,
        budgetTokens: parsed.budgetTokens,
      })

      // Persist the exact post-sanitize text whose hash is rawHash. The
      // recomputed hash doubles as a corruption tripwire: pipeline and CAS
      // disagreeing is an internal bug and surfaces as E_INTERNAL upstream.
      const expectedHex = run.rawHash.slice("sha256:".length)
      const { rawForStore, notes, ...result } = run
      // Serialize quota reservation with publication even for direct engine callers.
      const store = storageTail.then(async () => {
        const size = Buffer.byteLength(rawForStore, "utf8")
        try {
          return await ownership.publish(async () => {
            if (!ownership.reserve(expectedHex, size, maxStorageBytes))
              return "storage_capacity" as const
            const stored = await writeObject(dataDir, rawForStore)
            if (stored.hash !== expectedHex) throw new Error("CAS hash mismatch")
            ownership.grant(parsed.sessionId, expectedHex)
            return null
          })
        } catch {
          return "storage_error" as const
        }
      })
      storageTail = store.then(
        () => undefined,
        () => undefined
      )
      const failure = await store
      if (failure !== null) {
        result.output = rawForStore
        result.compressed = false
        result.status = "degraded"
        result.degraded = { reason: failure }
        result.actualTokens = result.outTokensEst = result.rawTokensEst
        result.budgetExceeded = result.actualTokens > result.targetTokens
        result.omittedRanges = []
        result.diagnostics = [...result.diagnostics, failure]
      }
      stats.record(result)
      return result
    },

    async fetch(params) {
      const { hash, sessionId, ...paging } = fetchParamsSchema.parse(params)
      const hex = hash.slice("sha256:".length)
      if (!ownership.owns(sessionId, hex)) return { found: false }
      const bytes = await readObject(dataDir, hex)
      if (bytes === null) return { found: false }
      const page = paginateText(decoder.decode(bytes), { ref: `${sessionId}:${hash}`, ...paging })
      return {
        found: true,
        content: page.content,
        nextCursor: page.nextCursor,
        truncated: page.truncated,
      }
    },

    pipelineSnapshot: () => stats.snapshot(),
    close: () => ownership.close(),
  }
}
