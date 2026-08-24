/**
 * Shared test helpers: temp CAS roots, deterministic fixtures, condition
 * polling, and a raw line-oriented harness around directly spawned servers
 * (for protocol-level tests that deliberately bypass RtkClient).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type RawProc = import("bun").Subprocess<"pipe", "pipe", "pipe">;

/**
 * Absolute path of the server entry used by every spawn in this suite.
 * fileURLToPath over .pathname for the same reason as RtkClient.entryPath:
 * percent-decoding plus Windows drive-letter correctness.
 */
export const BIN_TS = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

let tmpSeq = 0;
/** Unique per-call store root so tests never share CAS state. */
export async function makeDataDir(label: string): Promise<string> {
  tmpSeq += 1;
  return mkdtemp(path.join(tmpdir(), `bluecode-rtk-${label}-${tmpSeq}-`));
}

/**
 * Deterministic `ls -la` fixture: one directory, `fileCount` regular-file
 * lines. Beyond 8 files the ls strategy folds, and past ~600 files the raw
 * text clears both the client minBytes threshold and the 512-token budget,
 * so a wire compress reliably yields compressed=true.
 */
export function lsLaOutput(fileCount: number): string {
  const lines = [`total ${fileCount * 8}`];
  for (let i = 0; i < fileCount; i++) {
    const name =
      i < 8 ? `kept-${i}.ts` : `generated-file-${String(i).padStart(4, "0")}.mod.ts`;
    lines.push(`-rw-r--r--@ 1 user staff ${(i + 1) * 137} Aug 23 10:00 ${name}`);
  }
  return lines.join("\n");
}

/** Poll `cond` until truthy; throws after timeoutMs. */
export async function waitFor(
  cond: () => boolean,
  timeoutMs: number,
  message = "condition not met in time",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Incremental line reader over a byte stream (LF-separated). */
class LineReader {
  private lines: string[] = [];
  private done = false;
  private wake: (() => void) | null = null;

  constructor(stream: ReadableStream<Uint8Array>) {
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for await (const chunk of stream) {
          buffer += decoder.decode(chunk, { stream: true });
          for (;;) {
            const nl = buffer.indexOf("\n");
            if (nl === -1) break;
            this.lines.push(buffer.slice(0, nl));
            buffer = buffer.slice(nl + 1);
            this.wake?.();
            this.wake = null;
          }
        }
      } catch {
        // stream torn down — expected on kill paths
      } finally {
        if (buffer.length > 0) this.lines.push(buffer);
        this.done = true;
        this.wake?.();
        this.wake = null;
      }
    })();
  }

  async readLine(timeoutMs = 5000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const line = this.lines.shift();
      if (line !== undefined) return line;
      if (this.done) throw new Error("stream ended before a line arrived");
      if (Date.now() > deadline) throw new Error("timed out waiting for a line");
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        setTimeout(resolve, 10);
      });
    }
  }
}

export interface RawServer {
  proc: RawProc;
  stdout: LineReader;
  writeLine(line: string): void;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
  exited(): Promise<number | null>;
}

/**
 * Spawn bin.ts directly (no client). Env always carries a fresh dataDir;
 * `extraEnv` adds test-mode switches like BLUECODE_TEST.
 */
export async function spawnRawServer(extraEnv?: Record<string, string>): Promise<RawServer> {
  const proc = Bun.spawn([process.execPath, BIN_TS], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      BLUECODE_DATA_DIR: await makeDataDir("raw"),
      ...extraEnv,
    },
  }) as RawProc;
  // Drain stderr so the child never blocks on a full pipe.
  void (async () => {
    try {
      for await (const _ of proc.stderr) {
        /* diagnostics intentionally discarded */
      }
    } catch {
      /* ignore */
    }
  })();
  return {
    proc,
    stdout: new LineReader(proc.stdout),
    writeLine(line: string): void {
      proc.stdin.write(`${line}\n`);
    },
    kill(signal: "SIGTERM" | "SIGKILL" = "SIGKILL"): void {
      proc.kill(signal);
    },
    exited: () => proc.exited,
  };
}

/** Parse one response line into an object (test-local, schema-light). */
export function parseFrame<T = Record<string, unknown>>(line: string): T {
  return JSON.parse(line) as T;
}
