#!/usr/bin/env bun
/**
 * rtk server entry point: `bun run <this file>`.
 *
 * Binds the protocol loop in server.ts to the real process streams:
 * stdin/stdout carry JSONL frames, stderr carries diagnostics only. The
 * process exits 0 once stdin reaches EOF (parent gone or graceful close).
 *
 * Environment:
 * - BLUECODE_DATA_DIR      CAS root (default: per-uid sidecar dir from
 *                          @bluecode/shared; production injects the plugin-
 *                          configured path)
 * - BLUECODE_TEST=1        enables test-only ops (simulateCrash) and the
 *                          artificial response delay below
 * - BLUECODE_TEST_DELAY_MS per-response latency, honored only when
 *                          BLUECODE_TEST=1 (timeout-path fault injection)
 */
import { createLineReconstructor, FrameOverflowError } from "@bluecode/shared";
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

// Test-only frame-size ceiling so the overflow path is exercisable without
// streaming 64 MiB through a pipe; gated like BLUECODE_TEST_DELAY_MS.
let maxFrameBytes: number | undefined;
if (testMode) {
  const rawMax = Number(process.env.BLUECODE_MAX_FRAME_BYTES ?? "");
  if (Number.isInteger(rawMax) && rawMax > 0) maxFrameBytes = rawMax;
}
const frames = createLineReconstructor(maxFrameBytes !== undefined ? { maxFrameBytes } : {});
const decoder = new TextDecoder();

try {
  for await (const chunk of Bun.stdin.stream()) {
    for (const line of frames.push(decoder.decode(chunk, { stream: true }))) {
      await server.handleLine(line);
    }
  }
} catch (err) {
  if (err instanceof FrameOverflowError) {
    // Best-effort E_PROTOCOL so a live parent learns why, then exit: the
    // reconstructor dropped the oversized bytes, so continuing would re-frame
    // the stream from an arbitrary mid-JSON offset.
    io.log(`[rtk-server] stdin frame exceeded ${err.maxFrameBytes} bytes; aborting protocol`);
    try {
      await server.abortProtocol(`frame exceeded ${err.maxFrameBytes} bytes without a newline`);
    } catch {
      // Parent likely gone; nothing left to answer.
    }
    process.exit(0);
  }
  io.log(`[rtk-server] stdin stream error: ${err instanceof Error ? err.message : String(err)}`);
}

// Final no-arg decode() flushes a multibyte char split across chunk boundaries
// into the frame stream (devlog #35); without it, a code point ending exactly
// at EOF is silently dropped. Outside the stdin try so the error path also
// terminates cleanly.
for (const line of frames.push(decoder.decode())) {
  try {
    await server.handleLine(line);
  } catch {
    // stdout is likely closed; nothing left to do.
  }
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
