/**
 * Frame layer for newline-delimited JSON streams.
 *
 * Deliberately dumb: this layer knows about LINES, never about JSON. Parsing
 * lives one layer up so protocol errors can be attributed cleanly (frame
 * failure -> E_PROTOCOL, parse failure -> E_INVALID_PARAMS).
 */

/** Serialize a value as one JSONL frame (the caller owns writing it). */
export function encodeFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

/**
 * Thrown by LineReconstructor.push when buffered bytes awaiting a newline
 * exceed maxFrameBytes. Callers map this onto their existing failure path
 * (server → best-effort E_PROTOCOL response + destroy; client → its
 * protocol-failure / failAll machinery) — no new plumbing required.
 */
export class FrameOverflowError extends Error {
  constructor(
    readonly maxFrameBytes: number,
    readonly completedLines: string[] = []
  ) {
    super(`frame exceeded ${maxFrameBytes} bytes without a newline`)
    this.name = "FrameOverflowError"
  }
}

export interface LineReconstructorOptions {
  /**
   * Max UTF8 bytes buffered while waiting for a newline before push() throws
   * FrameOverflowError and the partial frame is dropped. Default 8 MiB.
   *
   * Deliberately generous: contracts impose no max on compress.output /
   * fetch.content / retrieve payloads, and JSON.stringify escapes newlines,
   * so a legitimately huge tool output arrives as ONE frame — a tight cap
   * would break real sessions rather than only floods.
   */
  maxFrameBytes?: number
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
  push(chunk: string): string[]
  /**
   * Signal end-of-stream. Returns the residual half-line if one exists —
   * on a well-formed stream this is always [], and any non-empty result is
   * a protocol violation the caller must report as E_PROTOCOL.
   */
  flush(): string[]
}

export function createLineReconstructor(options: LineReconstructorOptions = {}): LineReconstructor {
  const maxFrameBytes = options.maxFrameBytes ?? 8 * 1024 * 1024
  let parts: string[] = []
  let bytes = 0
  let previousHigh = false
  const reset = (): void => {
    parts = []
    bytes = 0
    previousHigh = false
  }
  const append = (part: string): void => {
    if (part.length === 0) return
    // A UTF16 surrogate pair may straddle pushes from string callers.
    const first = part.charCodeAt(0)
    bytes +=
      Buffer.byteLength(part, "utf8") - (previousHigh && first >= 0xdc00 && first <= 0xdfff ? 2 : 0)
    const last = part.charCodeAt(part.length - 1)
    previousHigh = last >= 0xd800 && last <= 0xdbff
    if (bytes > maxFrameBytes) {
      reset()
      throw new FrameOverflowError(maxFrameBytes)
    }
    parts.push(part)
  }
  return {
    push(chunk: string): string[] {
      const lines: string[] = []
      let start = 0
      try {
        for (;;) {
          const nl = chunk.indexOf("\n", start)
          if (nl === -1) break
          append(chunk.slice(start, nl))
          let line = parts.join("")
          if (line.endsWith("\r")) line = line.slice(0, -1)
          lines.push(line)
          reset()
          start = nl + 1
        }
        append(chunk.slice(start))
      } catch (error) {
        // Successful frames belong to the caller even if the same read also
        // contains a later oversized frame. Pipe/TCP chunking must not erase them.
        if (error instanceof FrameOverflowError) throw new FrameOverflowError(maxFrameBytes, lines)
        throw error
      }
      return lines
    },
    flush(): string[] {
      const rest = parts.join("")
      reset()
      return rest.length > 0 ? [rest] : []
    },
  }
}
