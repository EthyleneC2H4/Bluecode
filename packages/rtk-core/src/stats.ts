/**
 * Pipeline-level counters shared with the M3 server's stats op.
 */
import type { CompressResult, DegradedReason } from "@bluecode/contracts";

/** Immutable snapshot of pipeline counters. */
export interface PipelineStatsSnapshot {
  requests: number;
  compressedCount: number;
  passthroughCount: number;
  degradedCounts: Readonly<Record<DegradedReason, number>>;
}

const DEGRADED_REASONS: DegradedReason[] = [
  "spawn_failed",
  "timeout",
  "crash",
  "protocol",
  "no_gain",
];

/**
 * Create a fresh counter set. `record()` consumes CompressResults from
 * compressToolOutput; `snapshot()` returns a copy safe to hand to the wire.
 */
export function createPipelineStats(): {
  record: (result: CompressResult) => void;
  snapshot: () => PipelineStatsSnapshot;
} {
  let requests = 0;
  let compressedCount = 0;
  let passthroughCount = 0;
  const degradedCounts = Object.fromEntries(DEGRADED_REASONS.map((r) => [r, 0])) as Record<
    DegradedReason,
    number
  >;

  return {
    record(result: CompressResult): void {
      requests++;
      if (result.compressed) compressedCount++;
      else passthroughCount++;
      const reason = result.degraded?.reason;
      if (reason !== undefined) {
        degradedCounts[reason] = (degradedCounts[reason] ?? 0) + 1;
      }
    },
    snapshot(): PipelineStatsSnapshot {
      return {
        requests,
        compressedCount,
        passthroughCount,
        degradedCounts: { ...degradedCounts },
      };
    },
  };
}
