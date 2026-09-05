/**
 * Pipeline orchestration — the package's single outward entry point.
 *
 * Steps: sanitize -> redact (= raw) -> hash raw (CAS happens server-side via
 * rawForStore; sanitization-before-hashing guarantees no secret reaches the
 * store) -> fast path on budget -> classify (overridable) -> strategy ->
 * budget trim -> anti-regression guard -> result assembly.
 */
import type { CompressResult, DegradedReason, StrategyName } from "@bluecode/contracts"
import { estimateTokens, noopRedactor, sanitize, sha256Hex, type Redactor } from "@bluecode/shared"
import { applyBudget } from "./budget"
import { classify, type Classification } from "./classify"
import { diffStrategy } from "./strategies/diff"
import { fallbackStrategy } from "./strategies/fallback"
import { grepStrategy } from "./strategies/grep"
import { lsStrategy } from "./strategies/ls"
import { readStrategy } from "./strategies/read"
import { testStrategy } from "./strategies/test"
import type { Strategy } from "./strategies/types"

/** Default compression budget, mirroring contracts' compressParamsSchema default. */
export const DEFAULT_BUDGET_TOKENS = 512

export interface CompressToolOutputInput {
  tool: string
  output: string
  /** Display title passthrough (unused by core logic; kept for M3 symmetry). */
  title?: string | undefined
  toolArgs?: import("@bluecode/contracts").CompressParams["toolArgs"]
  source?: import("@bluecode/contracts").CompressParams["source"]
  provenance?: import("@bluecode/contracts").CompressParams["provenance"]
  /** `metadata.truncated === true` is forwarded as the truncated flag. */
  metadata?: Record<string, unknown> | undefined
  /** Token budget; defaults to {@link DEFAULT_BUDGET_TOKENS} like the wire schema. */
  budgetTokens?: number | undefined
  /** Applied after sanitization, before hashing/CAS. Defaults to identity. */
  redactor?: Redactor | undefined
  /** Test hook: force a classification (full object or just a strategy name). */
  classifyOverride?: Classification | StrategyName | undefined
}

/** CompressResult plus pipeline extras the server needs but the wire doesn't. */
export type CompressToolOutputResult = CompressResult & {
  /** Exact post-sanitize/redact text whose sha256 is rawHash — CAS input. */
  rawForStore: string
  /** Human-readable processing notes (classification signals + strategy notes). */
  notes: string[]
}

const STRATEGIES: Record<StrategyName, Strategy> = {
  ls: lsStrategy,
  grep: grepStrategy,
  read: readStrategy,
  diff: diffStrategy,
  test: testStrategy,
  unknown: fallbackStrategy,
}

function normalizeOverride(override: Classification | StrategyName): Classification {
  if (typeof override === "string") {
    return { strategy: override, confidence: 1, signals: ["classifyOverride"] }
  }
  return override
}

export async function compressToolOutput(
  input: CompressToolOutputInput
): Promise<CompressToolOutputResult> {
  const budgetTokens = input.budgetTokens ?? DEFAULT_BUDGET_TOKENS
  const redactor = input.redactor ?? noopRedactor

  // 1-2. Sanitize, then redact; this exact text is what gets hashed/stored.
  const raw = redactor(sanitize(input.output))
  const rawHashRef = `sha256:${await sha256Hex(raw)}`
  const rawTokensEst = estimateTokens(raw)
  const truncated = input.metadata?.truncated === true

  // 4. Classify (explicit tool id first, feature scoring second).
  const classification =
    input.classifyOverride !== undefined
      ? normalizeOverride(input.classifyOverride)
      : classify(input.tool, raw)

  const build = (
    output: string,
    compressed: boolean,
    degraded: { reason: DegradedReason } | null,
    notes: string[],
    strategy: StrategyName = classification.strategy,
    omittedRanges: CompressResult["omittedRanges"] = []
  ): CompressToolOutputResult => ({
    output,
    status: degraded ? "degraded" : compressed ? "compressed" : "unchanged",
    targetTokens: budgetTokens,
    actualTokens: estimateTokens(output),
    budgetExceeded: estimateTokens(output) > budgetTokens,
    omittedRanges,
    diagnostics: notes,
    rawHash: rawHashRef,
    strategy,
    compressed,
    truncated,
    rawTokensEst,
    outTokensEst: estimateTokens(output),
    degraded,
    rawForStore: raw,
    notes,
  })

  // Parse before fast path so strategy reports the parser actually used.
  const strategyFn = STRATEGIES[classification.strategy] ?? fallbackStrategy
  const sr = strategyFn({ text: raw, toolId: input.tool })
  if (rawTokensEst <= budgetTokens || sr.strategy === "unknown" || sr.strategy === "read") {
    return build(raw, false, null, [...classification.signals, ...sr.notes], sr.strategy)
  }
  const notes = [...classification.signals, ...sr.notes]
  const budgeted = applyBudget(sr.lines, {
    budgetTokens,
    rawHash: rawHashRef,
    rawTokensEst,
    tool: input.tool,
  })

  // 7. Anti-regression: never return something bigger than the raw text.
  if (estimateTokens(budgeted.text) >= rawTokensEst) {
    return build(
      raw,
      false,
      null,
      [...notes, "no_gain: assembled output would not be smaller than raw"],
      sr.strategy
    )
  }

  // Summaries have no source index; duplicates retain their original identity.
  const retained = new Set(
    budgeted.keptLines.flatMap((line) => (line.sourceLine === undefined ? [] : [line.sourceLine]))
  )
  const sourceLines = raw.split("\n")
  if (sourceLines.at(-1) === "") sourceLines.pop()
  const omittedRanges: CompressResult["omittedRanges"] = []
  for (let i = 0; i < sourceLines.length; i++) {
    if (retained.has(i + 1)) continue
    const last = omittedRanges.at(-1)
    if (last && last.endLine === i) last.endLine = i + 1
    else omittedRanges.push({ startLine: i + 1, endLine: i + 1 })
  }
  return build(
    budgeted.text,
    true,
    null,
    [
      ...notes,
      `budget: ${budgeted.elidedTokens} token(s) elided across ${budgeted.groupsCollapsed} group(s)`,
    ],
    sr.strategy,
    omittedRanges
  )
}
