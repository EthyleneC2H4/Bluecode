/**
 * Frame layer for newline-delimited JSON streams.
 *
 * Deliberately dumb: this layer knows about LINES, never about JSON. Parsing
 * lives one layer up so protocol errors can be attributed cleanly (frame
 * failure -> E_PROTOCOL, parse failure -> E_INVALID_PARAMS).
 */

/** Serialize a value as one JSONL frame (the caller owns writing it). */
export function encodeFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * Incremental line reconstructor for chunked reads (TCP/pipe semantics).
 * Buffers partial lines across pushes and emits every completed line,
 * supporting sticky-packet (multiple frames per chunk) naturally.
 *
 * A line is LF-terminated; a trailing CRLF is tolerated and the CR stripped.
 */
export interface LineReconstructor {
  /** Feed one chunk; returns the complete lines it completed (without the LF). */
  push(chunk: string): string[];
  /**
   * Signal end-of-stream. Returns the residual half-line if one exists —
   * on a well-formed stream this is always [], and any non-empty result is
   * a protocol violation the caller must report as E_PROTOCOL.
   */
  flush(): string[];
}

export function createLineReconstructor(): LineReconstructor {
  let buffer = "";

  return {
    push(chunk: string): string[] {
      buffer += chunk;
      const lines: string[] = [];
      let start = 0;
      for (;;) {
        const nl = buffer.indexOf("\n", start);
        if (nl === -1) break;
        let line = buffer.slice(start, nl);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        lines.push(line);
        start = nl + 1;
      }
      buffer = buffer.slice(start);
      return lines;
    },

    flush(): string[] {
      const rest = buffer;
      buffer = "";
      return rest.length > 0 ? [rest] : [];
    },
  };
}
