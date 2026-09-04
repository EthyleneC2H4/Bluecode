import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import {
  ErrorCode,
  PROTOCOL_VERSION,
  chatMessageSchema,
  compressParamsSchema,
  compressResultSchema,
  errorSchema,
  fetchParamsSchema,
  fetchResultSchema,
  headroomCompressParamsSchema,
  headroomCompressResultSchema,
  headroomRetrieveParamsSchema,
  healthParamsSchema,
  healthResultSchema,
  helloSchema,
  pingResultSchema,
  requestSchema,
  responseSchema,
  retrieveByHashParamsSchema,
  retrieveByHashResultSchema,
  retrieveByQueryParamsSchema,
  sha256RefSchema,
  statsResultSchema,
} from "../src/index";
import type {
  CompressParams,
  FetchParams,
  HeadroomCompressParams,
  RetrieveByHashParams,
} from "../src/index";

const SHA = `sha256:${"a".repeat(64)}`;

/** Compile-time mutual-assignability guard: hand-written wire interfaces must
 * stay identical to the corresponding zod input types. */
type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const compressParamsAligned: AssertEqual<CompressParams, z.input<typeof compressParamsSchema>> =
  true;
const fetchParamsAligned: AssertEqual<FetchParams, z.input<typeof fetchParamsSchema>> = true;
const headroomCompressParamsAligned: AssertEqual<
  HeadroomCompressParams,
  z.input<typeof headroomCompressParamsSchema>
> = true;
const retrieveByHashAligned: AssertEqual<
  RetrieveByHashParams,
  z.infer<typeof retrieveByHashParamsSchema>
> = true;
void [compressParamsAligned, fetchParamsAligned, headroomCompressParamsAligned];

describe("errors", () => {
  test("errorSchema accepts a well-formed error", () => {
    expect(errorSchema.parse({ code: "E_INTERNAL", message: "boom", detail: { at: 1 } })).toEqual(
      { code: "E_INTERNAL", message: "boom", detail: { at: 1 } },
    );
    expect(errorSchema.parse({ code: "E_PROTOCOL", message: "bad frame" })).toEqual({
      code: "E_PROTOCOL",
      message: "bad frame",
    });
  });

  test("errorSchema rejects an unknown code", () => {
    expect(errorSchema.safeParse({ code: "E_NOPE", message: "x" }).success).toBe(false);
  });

  test("schema codes cover every ErrorCode value", () => {
    for (const code of Object.values(ErrorCode)) {
      expect(errorSchema.pick({ code: true }).safeParse({ code }).success).toBe(true);
    }
  });
});

describe("rtk protocol v2", () => {
  test("hello handshake", () => {
    expect(helloSchema.parse({ proto: 2, pid: 4242 })).toEqual({ proto: 2, pid: 4242 });
    expect(helloSchema.safeParse({ proto: 1, pid: 4242 }).success).toBe(false);
    expect(helloSchema.safeParse({ proto: 2, pid: -1 }).success).toBe(false);
    expect(PROTOCOL_VERSION).toBe(2);
  });

  test("compress params require a session and fill budgetTokens default 512", () => {
    const parsed = compressParamsSchema.parse({ tool: "bash", output: "line\n", sessionId: "sess-1" });
    expect(parsed.budgetTokens).toBe(512);
    expect(compressParamsSchema.parse({ tool: "t", output: "o", sessionId: "sess-1", budgetTokens: 64 }).budgetTokens)
      .toBe(64);
    expect(compressParamsSchema.safeParse({ tool: "t", output: "o", sessionId: "sess-1", budgetTokens: 0 }).success)
      .toBe(false);
    expect(compressParamsSchema.safeParse({ tool: "t", output: "o" }).success).toBe(false);
    expect(compressParamsSchema.safeParse({ tool: "t", output: "o", sessionId: "" }).success)
      .toBe(false);
  });

  test("sha256Ref enforces hash format", () => {
    expect(sha256RefSchema.safeParse(SHA).success).toBe(true);
    expect(sha256RefSchema.safeParse("abc").success).toBe(false);
    expect(sha256RefSchema.safeParse(`sha256:${"A".repeat(64)}`).success).toBe(false);
    expect(fetchParamsSchema.safeParse({ hash: "abc", sessionId: "sess-1" }).success).toBe(false);
    expect(fetchParamsSchema.safeParse({ hash: SHA }).success).toBe(false);
    expect(fetchParamsSchema.parse({ hash: SHA, sessionId: "sess-1" })).toEqual({
      hash: SHA,
      sessionId: "sess-1",
    });
  });

  test("compress result round-trips", () => {
    const ok = compressResultSchema.parse({
      output: "summary",
      rawHash: SHA,
      strategy: "grep",
      compressed: true,
      truncated: false,
      rawTokensEst: 1000,
      outTokensEst: 120,
      degraded: null,
    });
    expect(ok.strategy).toBe("grep");
    expect(
      compressResultSchema.safeParse({
        output: "raw",
        rawHash: SHA,
        strategy: "unknown",
        compressed: false,
        truncated: false,
        rawTokensEst: 10,
        outTokensEst: 10,
        degraded: { reason: "no_gain" },
      }).success,
    ).toBe(true);
    expect(
      compressResultSchema.safeParse({
        output: "raw",
        rawHash: SHA,
        strategy: "nope",
        compressed: false,
        truncated: false,
        rawTokensEst: 10,
        outTokensEst: 10,
        degraded: null,
      }).success,
    ).toBe(false);
  });

  test("fetch result discriminated union", () => {
    expect(fetchResultSchema.parse({ found: true, content: "text" })).toEqual({
      found: true,
      content: "text",
    });
    expect(fetchResultSchema.parse({ found: false })).toEqual({ found: false });
    // found:true without content is invalid
    expect(fetchResultSchema.safeParse({ found: true }).success).toBe(false);
    // unknown strategy of the union still tolerates extra keys via strip mode
    expect(fetchResultSchema.safeParse({ found: false, content: "x" }).success).toBe(true);
  });

  test("ping and stats results", () => {
    expect(pingResultSchema.parse({ pong: true, uptimeMs: 5 })).toEqual({ pong: true, uptimeMs: 5 });
    const stats = statsResultSchema.parse({
      requests: 3,
      compressedCount: 2,
      passthroughCount: 1,
      degradedCounts: { spawn_failed: 0, timeout: 1, crash: 0, protocol: 0, no_gain: 0 },
      uptimeMs: 9000,
    });
    expect(stats.degradedCounts.timeout).toBe(1);
  });

  test("request envelope", () => {
    expect(requestSchema.parse({ v: 2, id: "r_1_ab", op: "ping", params: {} })).toEqual({
      v: 2,
      id: "r_1_ab",
      op: "ping",
      params: {},
    });
    expect(requestSchema.safeParse({ v: 1, id: "r", op: "ping", params: {} }).success).toBe(false);
    expect(requestSchema.safeParse({ v: 2, id: "", op: "ping", params: {} }).success).toBe(false);
    expect(requestSchema.safeParse({ v: 2, id: "r", op: "nope", params: {} }).success).toBe(false);
  });

  test("response envelope both branches", () => {
    expect(responseSchema.parse({ v: 2, id: "r", ok: true, result: { pong: true } })).toEqual({
      v: 2,
      id: "r",
      ok: true,
      result: { pong: true },
    });
    expect(
      responseSchema.parse({
        v: 2,
        id: "r",
        ok: false,
        error: { code: "E_UNKNOWN_OP", message: "?" },
      }),
    ).toEqual({ v: 2, id: "r", ok: false, error: { code: "E_UNKNOWN_OP", message: "?" } });
    // ok:false without error payload is invalid
    expect(responseSchema.safeParse({ v: 2, id: "r", ok: false }).success).toBe(false);
  });
});

describe("headroomd protocol v1", () => {
  const ns = { projectId: "p1", sessionId: "s1" };

  test("chat message projection", () => {
    const msg = chatMessageSchema.parse({
      info: { id: "m1", role: "assistant" },
      parts: [
        { type: "text", text: "hi" },
        { type: "tool", tool: "bash", state: { status: "completed" } },
        { type: "tool", tool: "read", state: { status: "done", output: "file body" } },
      ],
    });
    expect(msg.parts).toHaveLength(3);
    expect(
      chatMessageSchema.safeParse({ info: { id: "m2", role: "system" }, parts: [] }).success,
    ).toBe(false);
  });

  test("compress params defaults triggerRatio=0.7 retainRecentTurns=4", () => {
    const parsed = headroomCompressParamsSchema.parse({
      sessionId: "s1",
      projectId: "p1",
      messages: [],
      contextWindowTokens: 200000,
    });
    expect(parsed.triggerRatio).toBe(0.7);
    expect(parsed.retainRecentTurns).toBe(4);
  });

  test("compress result invariant via refine", () => {
    const compacted = {
      compacted: true,
      historyHash: SHA.slice("sha256:".length),
      summary: "sum",
      refs: [{ contentHash: SHA.slice("sha256:".length), role: "user" as const, turnIndex: 0 }],
      replacedMessageIds: ["m1", "m2"],
      rawTokens: 1000,
      summaryTokens: 100,
      freedTokens: 900,
    };
    expect(headroomCompressResultSchema.parse(compacted).compacted).toBe(true);
    // missing replacedMessageIds is invalid even when compacted
    expect(
      headroomCompressResultSchema.safeParse({ ...compacted, replacedMessageIds: undefined })
        .success,
    ).toBe(false);
    // inert result is valid
    expect(
      headroomCompressResultSchema.safeParse({
        compacted: false,
        historyHash: null,
        summary: null,
        refs: [],
        replacedMessageIds: [],
        rawTokens: 500,
        summaryTokens: 0,
        freedTokens: 0,
      }).success,
    ).toBe(true);
    // inert-looking but non-zero freedTokens must fail
    expect(
      headroomCompressResultSchema.safeParse({
        compacted: false,
        historyHash: null,
        summary: null,
        refs: [],
        replacedMessageIds: [],
        rawTokens: 500,
        summaryTokens: 0,
        freedTokens: 12,
      }).success,
    ).toBe(false);
    // compacted=false with dangling non-null fields must fail
    expect(
      headroomCompressResultSchema.safeParse({ ...compacted, compacted: false }).success,
    ).toBe(false);
  });

  test("retrieve hash mode", () => {
    // Headroom hashes are bare hex (no rtk "sha256:" prefix) — refs from
    // compress must be usable as retrieve params verbatim.
    const BARE = SHA.slice("sha256:".length);
    expect(retrieveByHashParamsSchema.safeParse({ namespace: ns, hash: BARE }).success).toBe(true);
    expect(retrieveByHashParamsSchema.safeParse({ namespace: ns, hash: SHA }).success).toBe(false);
    expect(retrieveByHashParamsSchema.safeParse({ namespace: ns, hash: "zz" }).success).toBe(
      false,
    );
    // found:true requires content (Task 2 review finding, tightened in M4)
    expect(retrieveByHashResultSchema.safeParse({ found: true }).success).toBe(false);
    expect(retrieveByHashResultSchema.safeParse({ found: true, content: "raw text" }).success)
      .toBe(true);
    expect(retrieveByHashResultSchema.safeParse({ found: false }).success).toBe(true);
  });

  test("retrieve query mode fills limit default 5", () => {
    const q = retrieveByQueryParamsSchema.parse({ namespace: ns, query: "auth flow" });
    expect(q.limit).toBe(5);
    expect(retrieveByQueryParamsSchema.parse({ namespace: ns, query: "q", limit: 2 }).limit)
      .toBe(2);
  });

  test("retrieve union dispatches by shape and rejects ambiguity", () => {
    const byQuery = headroomRetrieveParamsSchema.parse({ namespace: ns, query: "auth flow" });
    if ("query" in byQuery) {
      expect(byQuery.limit).toBe(5);
    } else {
      throw new Error("expected query branch");
    }
    const byHash = headroomRetrieveParamsSchema.parse({
      namespace: ns,
      hash: SHA.slice("sha256:".length),
    });
    if ("hash" in byHash) {
      expect(byHash.hash).toBe(SHA.slice("sha256:".length));
    } else {
      throw new Error("expected hash branch");
    }
    // both keys present -> fails every branch
    expect(
      headroomRetrieveParamsSchema.safeParse({ namespace: ns, hash: SHA, query: "q" }).success,
    ).toBe(false);
    // neither key present -> fails every branch
    expect(headroomRetrieveParamsSchema.safeParse({ namespace: ns }).success).toBe(false);
  });

  test("health round-trip", () => {
    expect(healthParamsSchema.parse({})).toEqual({});
    expect(healthResultSchema.parse({ ok: true, pid: 7, uptimeMs: 12, sessions: 1 })).toEqual({
      ok: true,
      pid: 7,
      uptimeMs: 12,
      sessions: 1,
    });
    expect(
      healthResultSchema.safeParse({ ok: false, pid: 7, uptimeMs: 12, sessions: 1 }).success,
    ).toBe(false);
  });

  test("retrieveByHashAligned type guard is live", () => {
    void retrieveByHashAligned;
    expect(retrieveByHashAligned).toBe(true);
  });
});
