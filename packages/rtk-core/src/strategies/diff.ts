/**
 * diff strategy — hunk heads and +/- counts preserved.
 *
 * Anchors: `diff --git`, `---`/`+++` file headers, `@@ ... @@` hunk heads,
 * plus a per-file "+A/−D" summary inserted right after each file header.
 * Each hunk keeps its first and last 3 change lines (elidable-high); the
 * overflow folds into a single "[@@] +N −M lines elided" marker (elidable-low,
 * grouped by file). Context lines pass through elidable-normal.
 */
import { PRI } from "../anchor";
import { splitLines, type CLine, type Strategy, type StrategyResult } from "./types";

const GIT_HEADER_RE = /^diff --git \S+ (\S+)$/;
const HUNK_RE = /^@@+(?: .+?)? @@+/;

const KEEP_PER_SIDE = 3;

interface FileStats {
  added: number;
  deleted: number;
}

/** Change-line classification of one hunk-body entry. */
interface BodyEntry {
  cl: CLine;
  kind: "add" | "del" | null;
}

/** Pre-pass: total +/- per file so header summaries can be emitted in order. */
function collectStats(lines: string[]): Map<string, FileStats> {
  const stats = new Map<string, FileStats>();
  let file = "";
  let inHunk = false;
  for (const line of lines) {
    const git = GIT_HEADER_RE.exec(line);
    if (git !== null) {
      file = stripAB(git[1] ?? "");
      inHunk = false;
      continue;
    }
    // No explicit ---/+++ skip branches (devlog #39): those headers only
    // occur between the git header and the first hunk, where !inHunk below
    // already ignores them. Skipping them unconditionally instead would also
    // swallow hunk-body deletions of lines starting "-- " ("--- ..." inside a
    // hunk) and undercount the very +/- totals the header summary reports.
    if (HUNK_RE.test(line)) {
      inHunk = true;
      continue;
    }
    if (!inHunk || file === "") continue;
    if (line.startsWith("+")) incr(stats, file, "added");
    else if (line.startsWith("-")) incr(stats, file, "deleted");
  }
  return stats;
}

function stripAB(p: string): string {
  return p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p;
}

function incr(stats: Map<string, FileStats>, file: string, key: "added" | "deleted"): void {
  const s = stats.get(file) ?? { added: 0, deleted: 0 };
  s[key]++;
  stats.set(file, s);
}

export const diffStrategy: Strategy = ({ text }) => {
  const lines = splitLines(text);
  const out: CLine[] = [];
  const notes: string[] = [];

  const stats = collectStats(lines);
  let currentFile = "";
  let hunkBody: BodyEntry[] | null = null;

  const flushHunk = (): void => {
    if (hunkBody === null) return;
    const changeIdx: number[] = [];
    for (let i = 0; i < hunkBody.length; i++) {
      if (hunkBody[i]?.kind !== null && hunkBody[i] !== undefined) changeIdx.push(i);
    }
    const keep = new Set<number>();
    for (const idx of changeIdx.slice(0, KEEP_PER_SIDE)) keep.add(idx);
    if (changeIdx.length > KEEP_PER_SIDE * 2) {
      for (const idx of changeIdx.slice(-KEEP_PER_SIDE)) keep.add(idx);
    }

    // Counts are final before emission, so the marker text is exact up front.
    let foldAdded = 0;
    let foldDeleted = 0;
    for (const idx of changeIdx) {
      if (keep.has(idx)) continue;
      const e = hunkBody[idx];
      if (e?.kind === "add") foldAdded++;
      else if (e?.kind === "del") foldDeleted++;
    }

    let markerEmitted = false;
    for (let i = 0; i < hunkBody.length; i++) {
      const entry = hunkBody[i];
      if (entry === undefined) continue;
      if (keep.has(i) || entry.kind === null) {
        out.push(entry.cl);
        continue;
      }
      if (!markerEmitted) {
        markerEmitted = true;
        if (foldAdded + foldDeleted > 0) {
          out.push({
            text: `[@@] +${foldAdded} −${foldDeleted} lines elided`,
            anchor: false,
            priority: PRI.low,
            group: entry.cl.group ?? "",
          });
        }
      }
    }
    hunkBody = null;
  };

  for (const line of lines) {
    const git = GIT_HEADER_RE.exec(line);
    if (git !== null) {
      flushHunk();
      currentFile = stripAB(git[1] ?? "");
      out.push({ text: line, anchor: true, priority: PRI.critical, group: currentFile });
      continue;
    }

    if (/^(---|\+\+\+) /.test(line) && hunkBody === null) {
      flushHunk();
      if (line.startsWith("+++ ")) {
        const target = line.slice(4).trim();
        if (target !== "/dev/null") currentFile = stripAB(target);
      }
      out.push({ text: line, anchor: true, priority: PRI.critical, group: currentFile });
      if (line.startsWith("+++ ")) {
        const s = stats.get(currentFile);
        if (s !== undefined && (s.added > 0 || s.deleted > 0)) {
          out.push({
            text: `[diff] ${currentFile} +${s.added}/−${s.deleted}`,
            anchor: true,
            priority: PRI.high,
            group: currentFile,
          });
        }
      }
      continue;
    }

    if (HUNK_RE.test(line)) {
      flushHunk();
      out.push({ text: line, anchor: true, priority: PRI.critical, group: currentFile });
      hunkBody = [];
      continue;
    }

    if (hunkBody !== null) {
      if (line.startsWith("+")) {
        hunkBody.push({
          cl: { text: line, anchor: false, priority: PRI.high, group: currentFile },
          kind: "add",
        });
      } else if (line.startsWith("-")) {
        hunkBody.push({
          cl: { text: line, anchor: false, priority: PRI.high, group: currentFile },
          kind: "del",
        });
      } else {
        hunkBody.push({
          cl: { text: line, anchor: false, priority: PRI.normal, group: currentFile },
          kind: null,
        });
      }
      continue;
    }

    // Junk before any file header (e.g. log preamble around the diff).
    out.push({ text: line, anchor: false, priority: PRI.normal, group: "other" });
  }
  flushHunk();

  let totalAdd = 0;
  let totalDel = 0;
  for (const s of stats.values()) {
    totalAdd += s.added;
    totalDel += s.deleted;
  }
  notes.push(`diff: ${stats.size} file(s), +${totalAdd}/−${totalDel} change(s)`);

  return { lines: out, strategy: "diff", notes };
};
