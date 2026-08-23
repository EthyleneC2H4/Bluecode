/**
 * ls strategy — directory tree folding.
 *
 * Shape A (`ls -la`, incl. `-R` section headers): keep the "total" line, the
 * section header, and all directory lines (anchor); keep the first 8 files
 * per directory; fold the rest into "[+N files in <dir>]".
 * Shape B (recursive/path list): group by directory, keep the first 5 entries
 * per directory (anchor), fold the rest into "[+N in <dir>/]". A deep common
 * prefix is extracted as a header line.
 */
import { PRI } from "../anchor";
import { splitLines, type CLine, type Strategy, type StrategyResult } from "./types";

const LS_PERM_RE = /^[dcb\-l][rwxStTs\-]{9}[@.+]*\s/;
const LS_TOTAL_RE = /^total \d+$/;
/** `path:` / `path/:` section headers emitted by `ls -laR`. */
const LS_SECTION_RE = /^[\w.@~+/-]+:$/;
const PATH_LINE_RE =
  /^(?:\.{1,2}\/|~\/)?[\w.@+-]+(?:\/[\w.@+-]+)+\/?$|^[\w.@+-]+\/$|^\.{1,2}\/[\w.@+-]+$/;

const KEEP_FILES_PER_DIR = 8;
const KEEP_ENTRIES_PER_DIR = 5;

interface FoldState {
  markers: Map<string, CLine>;
  counts: Map<string, number>;
}

/** Count one folded line for `key`; create or grow its summary marker in `out`. */
function bumpFold(
  state: FoldState,
  out: CLine[],
  key: string,
  render: (n: number) => string,
): void {
  const next = (state.counts.get(key) ?? 0) + 1;
  state.counts.set(key, next);
  const existing = state.markers.get(key);
  if (existing !== undefined) {
    existing.text = render(next);
    return;
  }
  const marker: CLine = { text: render(1), anchor: false, priority: PRI.low, group: key };
  state.markers.set(key, marker);
  out.push(marker);
}

function parseLsLa(line: string): { isDir: boolean; name: string } | null {
  if (!LS_PERM_RE.test(line)) return null;
  const fields = line.split(/\s+/);
  // perms links owner group size month day time/year name...
  if (fields.length < 9 || fields[0] === undefined) return null;
  return { isDir: fields[0].startsWith("d"), name: fields.slice(8).join(" ") };
}

function dirNameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  if (slash === -1) return ".";
  if (slash === 0) return "/";
  return path.slice(0, slash);
}

/** Longest common directory-segment prefix of all paths ([] when none). */
function commonDirPrefix(paths: string[]): string[] {
  if (paths.length === 0) return [];
  const dirSegs = (p: string) => p.replace(/^\.\//, "").split("/").slice(0, -1);
  let prefix = dirSegs(paths[0] ?? "");
  for (const path of paths.slice(1)) {
    const segs = dirSegs(path);
    const next: string[] = [];
    for (let i = 0; i < Math.min(prefix.length, segs.length); i++) {
      if (prefix[i] !== segs[i]) break;
      next.push(prefix[i] ?? "");
    }
    prefix = next;
    if (prefix.length === 0) break;
  }
  return prefix;
}

export const lsStrategy: Strategy = ({ text }) => {
  const lines = splitLines(text);
  const notes: string[] = [];

  const nonEmpty = lines.filter((l) => l.trim() !== "");
  const permCount = nonEmpty.filter((l) => LS_PERM_RE.test(l)).length;
  const isLsLa = nonEmpty.length > 0 && permCount / nonEmpty.length >= 0.5;

  // ------------------------------------------------------- shape A: ls -la ---
  if (isLsLa) {
    const out: CLine[] = [];
    const fold: FoldState = { markers: new Map(), counts: new Map() };
    const fileNth = new Map<string, number>();
    let currentDir = ".";
    let keptFiles = 0;
    let foldedFiles = 0;

    for (const line of lines) {
      if (line.trim() === "") continue;
      if (LS_TOTAL_RE.test(line)) {
        out.push({ text: line, anchor: true, priority: PRI.critical });
        continue;
      }
      if (LS_SECTION_RE.test(line)) {
        currentDir = line.slice(0, -1);
        out.push({ text: line, anchor: true, priority: PRI.critical, group: currentDir });
        continue;
      }
      const entry = parseLsLa(line);
      if (entry === null) {
        out.push({ text: line, anchor: false, priority: PRI.normal, group: currentDir });
        continue;
      }
      if (entry.isDir) {
        out.push({ text: line, anchor: true, priority: PRI.critical, group: currentDir });
        continue;
      }
      const nth = (fileNth.get(currentDir) ?? 0) + 1;
      fileNth.set(currentDir, nth);
      if (nth <= KEEP_FILES_PER_DIR) {
        keptFiles++;
        out.push({ text: line, anchor: false, priority: PRI.high, group: currentDir });
      } else {
        foldedFiles++;
        bumpFold(fold, out, currentDir, (n) =>
          `[+${n} file${n === 1 ? "" : "s"} in ${currentDir}]`,
        );
      }
    }

    if (foldedFiles > 0) {
      notes.push(`ls -la: kept ${keptFiles} file(s), folded ${foldedFiles} into summaries`);
    } else {
      notes.push(`ls -la: ${keptFiles} file(s), nothing to fold`);
    }
    return { lines: out, strategy: "ls", notes };
  }

  // -------------------------------------------------- shape B: path list ---
  const pathLines = nonEmpty.filter((l) => PATH_LINE_RE.test(l));
  const pathRatio = nonEmpty.length > 0 ? pathLines.length / nonEmpty.length : 0;

  if (pathRatio >= 0.4) {
    const out: CLine[] = [];
    const fold: FoldState = { markers: new Map(), counts: new Map() };
    const entryNth = new Map<string, number>();
    const prefixSegs = commonDirPrefix(pathLines);
    if (prefixSegs.length > 0) {
      out.push({
        text: `${prefixSegs.join("/")}/ (common prefix, ${pathLines.length} entries)`,
        anchor: true,
        priority: PRI.critical,
      });
      notes.push(`extracted common prefix ${prefixSegs.join("/")}/`);
    }

    let keptEntries = 0;
    let foldedEntries = 0;
    for (const line of lines) {
      if (!PATH_LINE_RE.test(line)) {
        out.push({
          text: line,
          anchor: false,
          priority: line.trim() === "" ? PRI.low : PRI.normal,
          group: "other",
        });
        continue;
      }
      const dir = dirNameOf(line.replace(/^\.\//, ""));
      const nth = (entryNth.get(dir) ?? 0) + 1;
      entryNth.set(dir, nth);
      if (nth <= KEEP_ENTRIES_PER_DIR) {
        keptEntries++;
        out.push({ text: line, anchor: true, priority: PRI.critical, group: dir });
      } else {
        foldedEntries++;
        bumpFold(fold, out, dir, (n) => `[+${n} in ${dir === "/" ? "/" : `${dir}/`}]`);
      }
    }

    if (foldedEntries > 0) {
      notes.push(
        `path list: kept ${keptEntries} entr(y|ies), folded ${foldedEntries} into summaries across ${entryNth.size} director(y|ies)`,
      );
    } else {
      notes.push(`path list: ${keptEntries} entr(y|ies), nothing to fold`);
    }
    return { lines: out, strategy: "ls", notes };
  }

  // -------------------------------------------------------- unrecognized ---
  notes.push("unrecognized ls shape; all lines kept elidable");
  return {
    lines: lines.map((l) => ({ text: l, anchor: false, priority: PRI.normal, group: "output" })),
    strategy: "ls",
    notes,
  };
};
