/**
 * Engine behavior: compress idempotency + tail retention, retrieve
 * round-trips and BM25 ordering, and the mandatory rebuild-consistency
 * contract (delete index.db -> auto rebuild -> identical answers).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatMessage } from "@bluecode/contracts";
import { createEngine, type Engine } from "../src/engine";

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
    messages.push(user(`u${i}`, `第 ${i} 轮：请分析模块 alpha 的行为`));
    messages.push(assistant(`a${i}`, `分析完成：模块 alpha 第 ${i} 轮结论。`));
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

  test("freedTokens = rawTokens - summaryTokens, never negative", async () => {
    const { engine } = await freshEngine();
    const long = history(6);
    const result = await engine.compress({ ...BASE_PARAMS, messages: long });
    expect(result.rawTokens).toBeGreaterThan(0);
    expect(result.summaryTokens).toBeGreaterThan(0);
    expect(result.freedTokens).toBe(Math.max(0, result.rawTokens - result.summaryTokens));
    expect(result.freedTokens).toBeGreaterThanOrEqual(0);
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
