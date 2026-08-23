/**
 * Deterministic sanitization of terminal noise in tool output.
 *
 * Three independent, ordered passes:
 * 1. stripAnsi              — escape-sequence removal (CSI / OSC / single-char)
 * 2. collapseCarriageReturns — progress-bar overwrite model
 * 3. collapseBackspaces      — character-erase fixed point
 *
 * All passes are pure string functions: same input, same output, no locale,
 * no wall-clock — required so CAS hashes stay stable across replays.
 */

/**
 * Matches:
 * - CSI sequences: ESC [ <params 0x30-0x3F>* <intermediates 0x20-0x2F>* <final 0x40-0x7E>
 * - OSC sequences: ESC ] <any text but BEL/ESC> then BEL or ST (ESC \)
 * - nF sequences:  ESC <intermediates 0x20-0x2F> <final 0x30-0x7E> (e.g. charset ESC ( B)
 * - single-char escapes: ESC <0x30-0x7E> (e.g. ESC c reset, ESC 7/8 save/restore)
 */
const ANSI_PATTERN =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[\x20-\x2f][\x30-\x7e]|\x1b[\x30-\x7e]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * Progress-bar overwrite semantics as a deterministic model: split by LF;
 * within a line keep the last non-empty CR-separated segment.
 */
export function collapseCarriageReturns(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const segments = line.split("\r");
      for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i];
        if (seg !== undefined && seg.length > 0) return seg;
      }
      return "";
    })
    .join("\n");
}

/**
 * Erase semantics as a deterministic fixed point: each BS deletes the
 * preceding code point (whole surrogate pair / astral char at once); BS with
 * nothing to delete is dropped.
 */
export function collapseBackspaces(text: string): string {
  const out: string[] = [];
  for (const ch of text) {
    if (ch === "\b") {
      out.pop();
    } else {
      out.push(ch);
    }
  }
  return out.join("");
}

/** Canonical pipeline: stripAnsi -> collapseCarriageReturns -> collapseBackspaces. */
export function sanitize(text: string): string {
  return collapseBackspaces(collapseCarriageReturns(stripAnsi(text)));
}
