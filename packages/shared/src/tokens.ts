/**
 * Token estimation utilities.
 *
 * Two tiers by design:
 * - estimateTokens: O(1) heuristic for runtime thresholds (watermarks,
 *   budgets). Never loads any model data.
 * - ExactTokenCounter: real tokenizer counts for eval reports; lazy-loaded
 *   on first use because the rank tables are megabytes.
 */
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

interface TiktokenEncoding {
  encode(text: string): number[];
}

/** Cheap length-based estimate (~4 chars/token); runtime threshold use only. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface ExactTokenCounter {
  count(text: string): number;
  dispose(): void;
}

/**
 * Real tokenizer counter backed by js-tiktoken's o200k_base encoding.
 *
 * Lazy load: neither js-tiktoken nor its rank tables are touched until the
 * first count() call (synchronous require of the package's CJS entry, cached
 * per counter instance).
 */
export function createExactTokenCounter(): ExactTokenCounter {
  let encoding: TiktokenEncoding | null = null;
  let disposed = false;

  const loadEncoding = (): TiktokenEncoding => {
    if (encoding === null) {
      const mod = nodeRequire("js-tiktoken") as {
        getEncoding(name: string): TiktokenEncoding;
      };
      encoding = mod.getEncoding("o200k_base");
    }
    return encoding;
  };

  return {
    count(text: string): number {
      if (disposed) throw new Error("shared: ExactTokenCounter already disposed");
      return loadEncoding().encode(text).length;
    },
    dispose(): void {
      disposed = true;
      encoding = null;
    },
  };
}
