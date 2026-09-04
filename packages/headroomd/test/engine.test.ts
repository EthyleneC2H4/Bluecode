/**
 * Engine behavior: compress idempotency + tail retention, retrieve
 * round-trips and BM25 ordering, and the mandatory rebuild-consistency
 * contract (delete index.db -> auto rebuild -> identical answers).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, unlink, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatMessage } from "@bluecode/contracts";
import { createEngine, type Engine } from "../src/engine";
import { buildReplacementText } from "../src/compaction";

const dirs: string[] = [];
const engines: Engine[] = [];

afterAll(async () => {
  for (const engine of engines) engine.close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

let seq = 0;
async function freshEngine(): Promise<{ dir: string; engine: Engine }> {
  const dir = await mkdtemp(path.join(tmpdir(), `bluecode-hd-eng-${seq++}-`));
  dirs.push(dir);
  const engine = await createEngine({ dataDir: dir });
  engines.push(engine);
  return { dir, engine };
}

function user(id: string, text: string): ChatMessage {
  return { info: { id, role: "user" }, parts: [{ type: "text", text }] };
}
function assistant(id: string, text: string): ChatMessage {
  return { info: { id, role: "assistant" }, parts: [{ type: "text", text }] };
}

function history(turnCount: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < turnCount; i++) {
    messages.push(
      user(
        `u${i}`,
        `第 ${i} 轮：请分析模块 alpha 的行为。${"需要逐项核对输入、状态转换和异常边界。".repeat(12)}`,
      ),
    );
    messages.push(
      assistant(
        `a${i}`,
        `分析完成：模块 alpha 第 ${i} 轮结论。${"已核对输入、状态转换、恢复路径和异常边界。".repeat(12)}`,
      ),
    );
  }
  return messages;
}

const BASE_PARAMS = {
  sessionId: "s1",
  projectId: "p1",
  contextWindowTokens: 100_000,
  triggerRatio: 0.7,
  retainRecentTurns: 2,
};

describe("engine compress", () => {
  test("replacement exposes only the bounded summary and history paging hint", () => {
    const refHash = "a".repeat(64);
    const text = buildReplacementText({
      historyHash: "b".repeat(64),
      summary: "bounded summary",
      refs: [{ contentHash: refHash, role: "user", turnIndex: 0 }],
      replacedMessageIds: ["u0"],
    });
    expect(text).toContain("bounded summary");
    expect(text).toContain(`headroom_retrieve(historyHash="${"b".repeat(64)}")`);
    expect(text).not.toContain(refHash);
  });

  test("inert when turns fit within retainRecentTurns", async () => {
    const { engine } = await freshEngine();
    const result = await engine.compress({
      ...BASE_PARAMS,
      messages: history(2),
      retainRecentTurns: 4,
    });
    expect(result.compacted).toBe(false);
    expect(result.historyHash).toBeNull();
    expect(result.summary).toBeNull();
    expect(result.refs).toEqual([]);
    expect(result.replacedMessageIds).toEqual([]);
    expect(result.freedTokens).toBe(0);
  });

  test("keeps the tail N turns and evicts exactly the older ones", async () => {
    const { engine } = await freshEngine();
    const messages = history(5); // turns T0..T4
    const result = await engine.compress({ ...BASE_PARAMS, messages });

    // T0..T2 evicted (5 - retain 2), each contributing user+assistant.
    expect(result.replacedMessageIds).toEqual(["u0", "a0", "u1", "a1", "u2", "a2"]);
    expect(result.refs.map((ref) => ref.contentHash.length)).toEqual(
      Array.from({ length: 6 }, () => 64),
    );
    expect(new Set(result.refs.map((ref) => ref.turnIndex))).toEqual(new Set([0, 1, 2]));
    expect(result.compacted).toBe(true);

    // The summary covers only evicted turns: no T3/T4 content leaks in.
    expect(result.summary).not.toContain("T3");
    expect(result.summary).toContain("[T0]");
  });

  test("idempotent replay: same historyHash, summary reused, objects not rewritten", async () => {
    const { dir, engine } = await freshEngine();
    const params = { ...BASE_PARAMS, messages: history(4) };

    const first = await engine.compress(params);

    const objectDir = path.join(dir, "objects");
    const firstHash = first.historyHash as string;

    // Snapshot mtimes of every archived object.
    async function mtimes(): Promise<Map<string, number>> {
      const out = new Map<string, number>();
      const entries = await readdir(objectDir, { recursive: true });
      for (const entry of entries) {
        const full = path.join(objectDir, entry);
        out.set(entry, (await stat(full)).mtimeMs);
      }
      return out;
    }

    await new Promise((r) => setTimeout(r, 10)); // mtime resolution guard
    const before = await mtimes();
    const second = await engine.compress(params);
    const after = await mtimes();

    expect(second.historyHash).toBe(firstHash);
    expect(second.summary).toBe(first.summary);
    expect(second.freedTokens).toBe(first.freedTokens);
    expect(after).toEqual(before); // CAS dedup: zero rewrites on replay
  });

  test("reports source, evicted, retained, replacement and final token estimates", async () => {
    const { engine } = await freshEngine();
    const long = history(6);
    const result = await engine.compress({ ...BASE_PARAMS, messages: long });
    expect(result.rawTokens).toBeGreaterThan(0);
    expect(result.summaryTokens).toBeGreaterThan(0);
    expect(result.rawTokens).toBe(result.sourceTokensEst);
    expect(result.sourceTokensEst).toBe(result.evictedTokensEst + result.retainedTokensEst);
    expect(result.finalTokensEst).toBe(
      result.retainedTokensEst + result.replacementTokensEst,
    );
    expect(result.freedTokens).toBe(result.sourceTokensEst - result.finalTokensEst);
    expect(result.replacementTokensEst).toBeGreaterThan(result.summaryTokens);
  });

  test("does not archive when the replacement would not save tokens", async () => {
    const { dir, engine } = await freshEngine();
    const result = await engine.compress({
      ...BASE_PARAMS,
      messages: [user("u", "x")],
      retainRecentTurns: 0,
    });
    expect(result).toMatchObject({
      compacted: false,
      historyHash: null,
      refs: [],
      replacedMessageIds: [],
      evictedTokensEst: 0,
      retainedTokensEst: result.sourceTokensEst,
      replacementTokensEst: 0,
      finalTokensEst: result.sourceTokensEst,
      freedTokens: 0,
    });
    expect(await readdir(dir)).not.toContain("objects");
  });
});

describe("engine retrieve", () => {
  test("by-hash round-trip renders original text verbatim", async () => {
    const { engine } = await freshEngine();
    const messages = history(4); // T0..T3, retain 2 → T0..T1 evicted
    const compressed = await engine.compress({ ...BASE_PARAMS, messages });

    const targetId = "a1"; // assistant of evicted turn T1
    const refIndex = compressed.replacedMessageIds.indexOf(targetId);
    expect(refIndex).toBeGreaterThanOrEqual(0);
    const hash = compressed.refs[refIndex]!.contentHash;

    const hit = await engine.retrieve({
      namespace: { projectId: "p1", sessionId: "s1" },
      hash,
    });
    expect(hit).toEqual({ found: true, content: expect.any(String) });
    if (!("content" in hit)) throw new Error("by-hash hit must carry content");
    expect(hit.content).toContain("分析完成：模块 alpha 第 1 轮结论。");
    expect(hit.content).toContain("[assistant]");

    const miss = await engine.retrieve({
      namespace: { projectId: "p1", sessionId: "s1" },
      hash: "f".repeat(64),
    });
    expect(miss).toEqual({ found: false });

    const crossSession = await engine.retrieve({
      namespace: { projectId: "p1", sessionId: "other" },
      hash,
    });
    expect(crossSession).toEqual({ found: false });
  });

  test("by-history pages in message order and enforces namespace", async () => {
    const { engine } = await freshEngine();
    const compressed = await engine.compress({ ...BASE_PARAMS, messages: history(8) });
    const historyHash = compressed.historyHash!;

    const first = await engine.retrieve({
      namespace: { projectId: "p1", sessionId: "s1" },
      historyHash,
      limit: 3,
    });
    if (!("found" in first) || !first.found || !("items" in first)) {
      throw new Error("expected history page");
    }
    expect(first.items.map((item) => item.contentHash)).toEqual(
      compressed.refs.slice(0, 3).map((ref) => ref.contentHash),
    );
    expect(first.items.map((item) => item.role)).toEqual(["user", "assistant", "user"]);
    expect(first.nextOffset).toBe(3);
    expect(first.partial).toBe(false);

    const second = await engine.retrieve({
      namespace: { projectId: "p1", sessionId: "s1" },
      historyHash,
      offset: first.nextOffset!,
      limit: 50,
    });
    if (!("found" in second) || !second.found || !("items" in second)) {
      throw new Error("expected second history page");
    }
    expect(second.items.map((item) => item.contentHash)).toEqual(
      compressed.refs.slice(3).map((ref) => ref.contentHash),
    );
    expect(second.nextOffset).toBeNull();

    expect(
      await engine.retrieve({
        namespace: { projectId: "p1", sessionId: "other" },
        historyHash,
      }),
    ).toEqual({ found: false });
    expect(
      await engine.retrieve({
        namespace: { projectId: "other", sessionId: "s1" },
        historyHash,
      }),
    ).toEqual({ found: false });
  });

  test("by-history reports missing and corrupt objects as a partial page", async () => {
    const { dir, engine } = await freshEngine();
    const compressed = await engine.compress({ ...BASE_PARAMS, messages: history(6) });
    const missingHash = compressed.refs[1]!.contentHash;
    const corruptHash = compressed.refs[3]!.contentHash;
    await rm(path.join(dir, "objects", missingHash.slice(0, 2), missingHash));
    await writeFile(
      path.join(dir, "objects", corruptHash.slice(0, 2), corruptHash),
      Buffer.from("not-gzip"),
    );

    const result = await engine.retrieve({
      namespace: { projectId: "p1", sessionId: "s1" },
      historyHash: compressed.historyHash!,
      offset: 0,
      limit: 50,
    });
    if (!("found" in result) || !result.found || !("items" in result)) {
      throw new Error("expected partial history page");
    }
    expect(result.partial).toBe(true);
    expect(result.missingHashes).toEqual([missingHash, corruptHash]);
    expect(result.items.map((item) => item.contentHash)).not.toContain(missingHash);
    expect(result.items.map((item) => item.contentHash)).not.toContain(corruptHash);
  });

  test("by-history handles an offset at and beyond the end", async () => {
    const { engine } = await freshEngine();
    const compressed = await engine.compress({ ...BASE_PARAMS, messages: history(5) });
    for (const offset of [compressed.refs.length, compressed.refs.length + 100]) {
      const result = await engine.retrieve({
        namespace: { projectId: "p1", sessionId: "s1" },
        historyHash: compressed.historyHash!,
        offset,
        limit: 50,
      });
      expect(result).toEqual({
        found: true,
        items: [],
        nextOffset: null,
        partial: false,
        missingHashes: [],
      });
    }
  });

  test("by-history accepts the maximum page size of 50", async () => {
    const { engine } = await freshEngine();
    const compressed = await engine.compress({ ...BASE_PARAMS, messages: history(32) });
    const result = await engine.retrieve({
      namespace: { projectId: "p1", sessionId: "s1" },
      historyHash: compressed.historyHash!,
      limit: 50,
    });
    if (!("found" in result) || !result.found || !("items" in result)) {
      throw new Error("expected maximum-size history page");
    }
    expect(result.items).toHaveLength(50);
    expect(result.nextOffset).toBe(50);
  });

  test("by-query returns namespace-scoped bm25-ordered hits", async () => {
    const { engine } = await freshEngine();
    const compressed = await engine.compress({
      ...BASE_PARAMS,
      messages: [
        ...history(4),
        user("uX", "完全不同的主题：数据库迁移策略 beta"),
        assistant("aX", "迁移计划已生成。"),
      ],
      retainRecentTurns: 2,
    });
    expect(compressed.compacted).toBe(true);

    const hits = await engine.retrieve({
      namespace: { projectId: "p1", sessionId: "s1" },
      query: "alpha",
    });
    if (!("hits" in hits)) throw new Error("by-query result must carry hits");
    expect(hits.hits.length).toBeGreaterThan(0);
    for (let i = 1; i < hits.hits.length; i++) {
      expect(hits.hits[i]!.score).toBeGreaterThanOrEqual(hits.hits[i - 1]!.score);
    }
    expect(hits.hits[0]!.projectId).toBe("p1");
    expect(hits.hits[0]!.sessionId).toBe("s1");

    const otherSession = await engine.retrieve({
      namespace: { projectId: "p1", sessionId: "other" },
      query: "alpha",
    });
    expect(otherSession).toEqual({ hits: [] });
  });

  test("garbage query yields no hits rather than an error", async () => {
    const { engine } = await freshEngine();
    const garbage = await engine.retrieve({
      namespace: { projectId: "p1", sessionId: "s1" },
      query: "!!! ***",
    });
    expect(garbage).toEqual({ hits: [] });
  });
});

describe("rebuild consistency (mandatory)", () => {
  test("deleting index.db then reopening serves identical answers", async () => {
    const { dir, engine } = await freshEngine();
    const compressed = await engine.compress({ ...BASE_PARAMS, messages: history(4) });
    const beforeHits = await engine.retrieve({
      namespace: { projectId: "p1", sessionId: "s1" },
      query: "alpha",
    });

    engine.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      await unlink(path.join(dir, `index.db${suffix}`)).catch(() => {});
    }

    const revived = await createEngine({ dataDir: dir }); // startup self-heal
    engines.push(revived);

    const afterHits = await revived.retrieve({
      namespace: { projectId: "p1", sessionId: "s1" },
      query: "alpha",
    });
    expect(afterHits).toEqual(beforeHits);

    // Hash retrieval survives the index wipe (objects untouched).
    const refIndex = compressed.replacedMessageIds.indexOf("u0");
    expect(refIndex).toBeGreaterThanOrEqual(0);
    const byHash = await revived.retrieve({
      namespace: { projectId: "p1", sessionId: "s1" },
      hash: compressed.refs[refIndex]!.contentHash,
    });
    expect(byHash).toEqual({ found: true, content: expect.any(String) });
  });
});

describe("heal convergence (rebuild-state)", () => {
  /** Capture console.warn around one createEngine boot; restore in finally. */
  function captureWarns(): { lines: string[]; restore(): void } {
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => lines.push(parts.map(String).join(" "));
    return { lines, restore: () => (console.warn = original) };
  }

  test("deleted index.db heals exactly once — the next boot does not rebuild", async () => {
    const { dir, engine } = await freshEngine();
    await engine.compress({ ...BASE_PARAMS, messages: history(4) });
    engine.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      await unlink(path.join(dir, `index.db${suffix}`)).catch(() => {});
    }

    // Boot #1: fresh index.db → legacy fallback fires → rebuild + expectation recorded.
    const boot1 = captureWarns();
    let healed: Engine;
    try {
      healed = await createEngine({ dataDir: dir });
      expect(boot1.lines.filter((l) => l.includes("rebuilt derived index")).length).toBe(1);
    } finally {
      boot1.restore();
    }
    engines.push(healed);
    healed.close();

    // Boot #2: expectation present and met → converged, no second rebuild.
    const boot2 = captureWarns();
    try {
      const again = await createEngine({ dataDir: dir });
      engines.push(again);
      expect(boot2.lines.some((l) => l.includes("rebuilt derived index"))).toBe(false);
      const hits = await again.retrieve({
        namespace: { projectId: "p1", sessionId: "s1" },
        query: "alpha",
      });
      if (!("hits" in hits)) throw new Error("expected by-query result");
      expect(hits.hits.length).toBeGreaterThan(0);
    } finally {
      boot2.restore();
    }
  }, 15000);

  test("a missing object converges instead of looping the healer", async () => {
    const { dir, engine } = await freshEngine();
    await engine.compress({ ...BASE_PARAMS, messages: history(4) });

    // Remove ONE stored object, then force a heal (index.db wipe): the
    // rebuild legitimately produces fewer chunks than cas_meta rows now —
    // exactly the PERMANENT chunks<cas_meta state that made the old probe
    // re-rebuild on every single boot.
    const objectDir = path.join(dir, "objects");
    const bucket = (await readdir(objectDir))[0]!;
    const victim = (await readdir(path.join(objectDir, bucket)))[0]!;
    await rm(path.join(objectDir, bucket, victim));
    engine.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      await unlink(path.join(dir, `index.db${suffix}`)).catch(() => {});
    }

    // Boot #1: heals (legacy fallback on the fresh index), one chunk short.
    const boot1 = captureWarns();
    let healed: Engine;
    try {
      healed = await createEngine({ dataDir: dir });
      expect(boot1.lines.filter((l) => l.includes("rebuilt derived index")).length).toBe(1);
    } finally {
      boot1.restore();
    }
    engines.push(healed);
    healed.close();

    // Boot #2 must NOT heal again: the recorded expectation (original count
    // minus the missing object) is met — divergence is recorded, not thrashed.
    const boot2 = captureWarns();
    try {
      const again = await createEngine({ dataDir: dir });
      engines.push(again);
      expect(boot2.lines.some((l) => l.includes("rebuilt derived index"))).toBe(false);
    } finally {
      boot2.restore();
    }
  }, 15000);

  test("dataDir is forced to 0700 whatever created it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bluecode-hd-perm-"));
    dirs.push(dir);
    // Loosen first: proves the chmod overrides an inherited permissive mode.
    await chmod(dir, 0o755);
    const engine = await createEngine({ dataDir: dir });
    engines.push(engine);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });
});
