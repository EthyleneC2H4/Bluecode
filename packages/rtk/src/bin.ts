#!/usr/bin/env bun
/**
 * rtk server entry point: `bun run <this file>`.
 *
 * Binds the protocol loop in server.ts to the real process streams:
 * stdin/stdout carry JSONL frames, stderr carries diagnostics only. The
 * process exits 0 once stdin reaches EOF (parent gone or graceful close).
 *
 * Environment:
 * - BLUECODE_DATA_DIR      CAS root (default <tmpdir>/bluecode-rtk; the
 *                          production path is injected by plugin config)
 * - BLUECODE_TEST=1        enables test-only ops (simulateCrash) and the
 *                          artificial response delay below
 * - BLUECODE_TEST_DELAY_MS per-response latency, honored only when
 *                          BLUECODE_TEST=1 (timeout-path fault injection)
 */
import { createLineReconstructor } from "@bluecode/shared";
import { startServer } from "./server";

const io = {
  writeFrame(line: string): void {
    process.stdout.write(line);
  },
  log(message: string): void {
    // console.log would corrupt the protocol stream; stderr only, always.
    process.stderr.write(`${message}\n`);
  },
};

const testMode = process.env.BLUECODE_TEST === "1";
const delayRaw = Number(process.env.BLUECODE_TEST_DELAY_MS ?? "0");
const responseDelayMs = Number.isFinite(delayRaw) && delayRaw > 0 ? delayRaw : 0;

const server = startServer(io, { testMode, responseDelayMs });

const frames = createLineReconstructor();
const decoder = new TextDecoder();

try {
  for await (const chunk of Bun.stdin.stream()) {
    for (const line of frames.push(decoder.decode(chunk, { stream: true }))) {
      await server.handleLine(line);
    }
  }
} catch (err) {
  io.log(`[rtk-server] stdin stream error: ${err instanceof Error ? err.message : String(err)}`);
}

// A trailing half-line on EOF is a protocol violation; answer E_PROTOCOL for
// completeness even though the parent may already be gone.
for (const line of frames.flush()) {
  try {
    await server.handleLine(line);
  } catch {
    // stdout is likely closed; nothing left to do.
  }
}
await server.finish();
process.exit(0);
