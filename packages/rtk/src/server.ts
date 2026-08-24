/**
 * stdio JSONL server loop: handshake, framing, op dispatch, response
 * validation.
 *
 * Transport-agnostic over an injected io pair so bin.ts binds the real
 * process streams while tests can drive the loop in-process. Invariants:
 * - stdout carries protocol frames only; every diagnostic goes to stderr.
 * - Requests are processed strictly serially in arrival order (the loop
 *   awaits each line), which makes the handler lock-free by construction.
 * - A single request failing must never kill the loop: every failure path
 *   answers {ok:false,error:{code,message}} and keeps serving.
 * - Every response is schema-checked before it leaves the process — an
 *   internal bug must not leak onto the wire as a protocol violation.
 */
import {
  ErrorCode,
  PROTOCOL_VERSION,
  compressResultSchema,
  fetchResultSchema,
  pingResultSchema,
  responseSchema,
  rtkOpSchema,
  statsResultSchema,
  type ProtocolError,
  type RtkOp,
} from "@bluecode/contracts";
import { encodeFrame } from "@bluecode/shared";
import { createEngine, resolveDataDir, type RtkEngine } from "./engine";

export interface ServerIo {
  /** Protocol frames only (wired to stdout by bin.ts). */
  writeFrame(line: string): void;
  /** Diagnostics only (wired to stderr by bin.ts). Never protocol data. */
  log(message: string): void;
}

export interface ServeOptions {
  /** Overrides BLUECODE_DATA_DIR resolution (tests). */
  dataDir?: string;
  /** Enables simulateCrash and responseDelayMs. Off in production. */
  testMode?: boolean;
  /**
   * Artificial per-response latency for timeout-path tests. Honored only
   * when testMode is on; bin.ts sources it from BLUECODE_TEST_DELAY_MS.
   */
  responseDelayMs?: number;
}

export interface RtkServerHandle {
  /** Handle one complete line (no trailing LF). Serialized by the caller. */
  handleLine(line: string): Promise<void>;
  /** stdin reached EOF: report any residual half-line, then stop serving. */
  finish(): Promise<void>;
  /**
   * Best-effort E_PROTOCOL answer for a transport-level fault (frame overflow)
   * that hits BETWEEN lines, where no request id exists to answer. The entry
   * point exits after calling this — framing state is already discarded.
   */
  abortProtocol(message: string): Promise<void>;
  readonly pid: number;
}

/** Per-op result schemas — every outgoing payload is checked against these. */
const RESULT_SCHEMAS = {
  compress: compressResultSchema,
  fetch: fetchResultSchema,
  ping: pingResultSchema,
  stats: statsResultSchema,
} as const satisfies Record<Exclude<RtkOp, "simulateCrash">, unknown>;

/**
 * Envelope pre-check: deliberately looser than requestSchema so an unknown
 * `op` can be answered E_UNKNOWN_OP instead of collapsing into E_PROTOCOL.
 */
const ENVELOPE_PRE_SCHEMA = {
  safeParse(value: unknown):
    | { success: true; data: { v: 1; id: string; op: string; params: unknown } }
    | { success: false } {
    if (typeof value !== "object" || value === null) return { success: false };
    const v = (value as { v?: unknown }).v;
    const id = (value as { id?: unknown }).id;
    const op = (value as { op?: unknown }).op;
    if (v !== 1) return { success: false };
    if (typeof id !== "string" || id.length < 1) return { success: false };
    if (typeof op !== "string") return { success: false };
    return {
      success: true,
      data: { v: 1, id, op, params: (value as { params?: unknown }).params },
    };
  },
};

/**
 * Schema errors are duck-typed (ZodError instances carry an `issues` array).
 * Avoids adding a direct zod dependency to this package; zod remains a
 * transitive dep via @bluecode/contracts.
 */
function asParamIssueList(err: unknown): string[] | null {
  const issues = (err as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(issues)) return null;
  return issues.map((issue) => {
    const i = issue as { path?: PropertyKey[]; message?: string };
    const path = Array.isArray(i.path) ? i.path.join(".") : "";
    return path.length > 0 ? `${path}: ${i.message ?? "invalid"}` : (i.message ?? "invalid");
  });
}

/** Fallback id for frames too broken to yield one; responseSchema needs >=1 char. */
const UNKNOWN_ID = "?";

export function startServer(io: ServerIo, options: ServeOptions = {}): RtkServerHandle {
  const startedAtMs = Date.now();
  const engine: RtkEngine = createEngine({ dataDir: resolveDataDir(options.dataDir) });
  const responseDelayMs = options.testMode === true ? Math.max(0, options.responseDelayMs ?? 0) : 0;
  let linesSeen = 0;

  // Startup handshake: the first stdout frame, before any request is read.
  io.writeFrame(encodeFrame({ proto: PROTOCOL_VERSION, pid: process.pid }));

  function uptimeMs(): number {
    return Date.now() - startedAtMs;
  }

  async function emit(id: string, result: unknown, op: RtkOp): Promise<void> {
    // Validate the payload against its per-op schema first: a buggy result
    // must answer E_INTERNAL, never leak as a malformed success frame.
    let frame: unknown;
    const schema = op === "simulateCrash" ? undefined : RESULT_SCHEMAS[op];
    if (schema !== undefined && !schema.safeParse(result).success) {
      io.log(`[rtk-server] internal bug: ${op} result failed its wire schema; answering E_INTERNAL`);
      frame = { v: PROTOCOL_VERSION, id, ok: false, error: internalError("result failed schema") };
    } else {
      frame = { v: PROTOCOL_VERSION, id, ok: true, result };
    }
    await writeChecked(frame);
  }

  async function emitError(id: string, error: ProtocolError): Promise<void> {
    await writeChecked({ v: PROTOCOL_VERSION, id, ok: false, error });
  }

  /** Envelope-check, optionally delay, then write. Never throws past a log. */
  async function writeChecked(frame: unknown): Promise<void> {
    const checked = responseSchema.safeParse(frame);
    if (!checked.success) {
      // Should be unreachable; if it ever happens the id may be garbage, so
      // fall back to UNKNOWN_ID to keep the envelope itself well-formed.
      io.log("[rtk-server] internal bug: outgoing frame failed responseSchema");
      frame = {
        v: PROTOCOL_VERSION,
        id: UNKNOWN_ID,
        ok: false,
        error: internalError("outgoing frame failed response schema"),
      };
    }
    if (responseDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
    io.writeFrame(encodeFrame(frame));
  }

  function internalError(message: string): ProtocolError {
    return { code: ErrorCode.E_INTERNAL, message };
  }

  async function handleLine(line: string): Promise<void> {
    const lineNo = ++linesSeen;

    // ---- framing / parse layer -> E_PROTOCOL -----------------------------
    if (line.trim().length === 0) {
      await emitError(UNKNOWN_ID, {
        code: ErrorCode.E_PROTOCOL,
        message: "empty line is not a valid frame",
        detail: { line: lineNo },
      });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      await emitError(UNKNOWN_ID, {
        code: ErrorCode.E_PROTOCOL,
        message: "frame is not valid JSON",
        detail: { line: lineNo },
      });
      return;
    }

    const env = ENVELOPE_PRE_SCHEMA.safeParse(parsed);
    if (!env.success) {
      await emitError(UNKNOWN_ID, {
        code: ErrorCode.E_PROTOCOL,
        message: "malformed request envelope (expected {v:1,id,op,params})",
        detail: { line: lineNo },
      });
      return;
    }
    const { id, op } = env.data;

    const knownOp = rtkOpSchema.safeParse(op);
    if (!knownOp.success) {
      await emitError(id, {
        code: ErrorCode.E_UNKNOWN_OP,
        message: `unknown op ${JSON.stringify(op)}`,
      });
      return;
    }

    // ---- dispatch layer: one bad request never kills the loop ------------
    try {
      switch (knownOp.data) {
        case "ping": {
          await emit(id, { pong: true, uptimeMs: uptimeMs() }, "ping");
          return;
        }
        case "stats": {
          await emit(id, { ...engine.pipelineSnapshot(), uptimeMs: uptimeMs() }, "stats");
          return;
        }
        case "compress": {
          await emit(id, await engine.compress(env.data.params), "compress");
          return;
        }
        case "fetch": {
          await emit(id, await engine.fetch(env.data.params), "fetch");
          return;
        }
        case "simulateCrash": {
          if (options.testMode === true) {
            io.log("[rtk-server] simulateCrash received; exiting 137");
            process.exit(137);
          }
          // Test-only op outside the test environment: refuse loudly but
          // keep serving (deliberately E_PROTOCOL per the M3 brief).
          await emitError(id, {
            code: ErrorCode.E_PROTOCOL,
            message: "simulateCrash requires BLUECODE_TEST=1 (test-only op)",
          });
          return;
        }
      }
    } catch (err) {
      const issues = asParamIssueList(err);
      if (issues !== null) {
        await emitError(id, {
          code: ErrorCode.E_INVALID_PARAMS,
          message: "params failed schema validation",
          detail: issues,
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      io.log(`[rtk-server] op ${knownOp.data} failed: ${message}`);
      await emitError(id, internalError(message));
    }
  }

  async function finish(): Promise<void> {
    const elapsed = uptimeMs();
    io.log(`[rtk-server] stdin closed after ${elapsed}ms; shutting down cleanly`);
  }

  async function abortProtocol(message: string): Promise<void> {
    await emitError(UNKNOWN_ID, {
      code: ErrorCode.E_PROTOCOL,
      message,
      detail: { fatal: true },
    });
  }

  return { handleLine, finish, abortProtocol, pid: process.pid };
}
