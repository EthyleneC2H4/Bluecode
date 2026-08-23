/**
 * Store layer: CAS message objects, FTS search (including the CJK
 * pre-segmentation contract from the spike), namespace isolation, and index
 * rebuild determinism.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatMessage } from "@bluecode/contracts";
import {
  buildMatchQuery,
  desegment,
  insertChunk,
  searchChunks,
  segmentForIndex,
} from "../src/store/fts";
import {
  readMessageObject,
  renderProjection,
  writeMessageObject,
} from "../src/store/objects";
import {
  ftsHealthy,
  openDb,
  rebuildFromObjects,
  schemaMismatch,
  type HeadroomDb,
} from "../src/store/db";
import { insertCasMeta } from "../src/store/db";

const dirs: string[] = [];
const dbs: HeadroomDb[] = [];

afterAll(async () => {
  for (const handle of dbs) handle.close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function freshDb(label: string): Promise<{ dir: string; handle: HeadroomDb }> {
  const dir = await mkdtemp(path.join(tmpdir(), `bluecode-hd-${label}-`));
  dirs.push(dir);
  const handle = openDb(path.join(dir, "index.db"));
  dbs.push(handle);
  return { dir, handle };
}

function user(id: string, text: string): ChatMessage {
  return { info: { id, role: "user" }, parts: [{ type: "text", text }] };
}

describe("objects", () => {
  test("write/read round-trips the projection verbatim; dedup on rewrite", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bluecode-hd-obj-"));
    dirs.push(dir);
    const message: ChatMessage = {
      info: { id: "m1", role: "assistant" },
      parts: [
        { type: "text", text: "回答正文" },
        { type: "tool", tool: "bash", state: { status: "ok", output: "out\nlines" } },
      ],
    };
    const first = await writeMessageObject(dir, message);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    const second = await writeMessageObject(dir, message);
    expect(second.existed).toBe(true);

    const loaded = await readMessageObject(dir, first.hash);
    expect(loaded).toEqual({ info: message.info, parts: message.parts });

    // content hash is of the GZIP BYTES? No — of the stored bytes themselves:
    // readObject returns what writeObject hashed, so the chain is consistent.
    const rendered = renderProjection(loaded!);
    expect(rendered).toContain("[assistant]");
    expect(rendered).toContain("回答正文");
    expect(rendered).toContain("[tool:bash] ok");
    expect(rendered).toContain("out\nlines");

    expect(await readMessageObject(dir, "f".repeat(64))).toBeNull();
  });
});

describe("fts text preparation", () => {
  test("segmentForIndex spaces out CJK runs only", () => {
    expect(segmentForIndex("历史压缩")).toBe("历 史 压 缩");
    expect(segmentForIndex("use 压缩 tool")).toBe("use 压 缩 tool");
    expect(segmentForIndex("plain ascii")).toBe("plain ascii");
  });

  test("desegment reverses injected single spaces", () => {
    expect(desegment("历 史 压 缩")).toBe("历史压缩");
    expect(desegment("word 历 史 end")).toBe("word 历史 end");
    expect(desegment("a  b")).toBe("a  b"); // real double spaces untouched
  });

  test("buildMatchQuery quotes tokens and segments CJK (injection-safe)", () => {
    expect(buildMatchQuery("error 压缩")).toBe('"error" "压 缩"');
    expect(buildMatchQuery("NOT NEAR \"evil\"")).toBe('"not" "near" "evil"');
    expect(buildMatchQuery("!!! ***")).toBeNull();
  });
});

describe("searchChunks", () => {
  test("CJK substring query hits pre-segmented chunks (spike contract)", async () => {
    const { handle } = await freshDb("cjk");
    insertChunk(handle.db, {
      contentHash: "a".repeat(64),
      projectId: "p",
      sessionId: "s1",
      role: "user",
      turnIndex: 0,
      historyHash: "h1",
      summaryText: "user: 用户要求实现历史压缩功能",
      rawExcerpt: "错误：找不到模块 bluecode，请实现历史压缩",
      keywords: "历史 压缩 实现",
    });
    insertChunk(handle.db, {
      contentHash: "b".repeat(64),
      projectId: "p",
      sessionId: "s1",
      role: "assistant",
      turnIndex: 1,
      historyHash: "h1",
      summaryText: "assistant: added grep strategy",
      rawExcerpt: "implemented the folding logic with anchor preservation",
      keywords: "grep folding anchor",
    });

    // THE spike regression: substring of an indexed CJK run must match.
    const zhHits = searchChunks(handle.db, { projectId: "p", sessionId: "s1" }, buildMatchQuery("压缩")!, 5);
    expect(zhHits.length).toBe(1);
    expect(zhHits[0]?.hash).toBe("a".repeat(64));
    // snippet highlight brackets can split a rejoined run; strip then compare
    const plainSnippet = desegment((zhHits[0]?.snippet ?? "").replace(/[[\]]/g, ""));
    expect(plainSnippet).toContain("历史压缩");

    const enHits = searchChunks(
      handle.db,
      { projectId: "p", sessionId: "s1" },
      buildMatchQuery("anchor")!,
      5,
    );
    expect(enHits.length).toBe(1);
    expect(enHits[0]?.hash).toBe("b".repeat(64));
  });

  test("namespace filter is same-statement: no cross-session leakage", async () => {
    const { handle } = await freshDb("leak");
    const secret = "VSecAgent-internal-secret";
    insertChunk(handle.db, {
      contentHash: "c".repeat(64),
      projectId: "proj",
      sessionId: "session-A",
      role: "user",
      turnIndex: 0,
      historyHash: "hx",
      summaryText: `secret ${secret}`,
      rawExcerpt: `payload ${secret}`,
      keywords: secret.toLowerCase(),
    });
    // Session B must see NOTHING; session A must hit.
    expect(
      searchChunks(handle.db, { projectId: "proj", sessionId: "session-B" }, `"${secret.toLowerCase()}"`, 5).length,
    ).toBe(0);
    expect(searchChunks(handle.db, { projectId: "other-proj", sessionId: "session-A" }, `"${secret.toLowerCase()}"`, 5).length)
      .toBe(0);
    expect(searchChunks(handle.db, { projectId: "proj", sessionId: "session-A" }, `"${secret.toLowerCase()}"`, 5).length)
      .toBe(1);
  });

  test("bm25 ordering puts richer matches first", async () => {
    const { handle } = await freshDb("rank");
    insertChunk(handle.db, {
      contentHash: "1".repeat(64), projectId: "p", sessionId: "s", role: "user", turnIndex: 0,
      historyHash: "h", summaryText: "auth flow", rawExcerpt: "auth flow once", keywords: "",
    });
    insertChunk(handle.db, {
      contentHash: "2".repeat(64), projectId: "p", sessionId: "s", role: "assistant", turnIndex: 1,
      historyHash: "h", summaryText: "auth auth flow details", rawExcerpt: "auth flow auth again", keywords: "auth",
    });
    const hits = searchChunks(handle.db, { projectId: "p", sessionId: "s" }, '"auth"', 5);
    expect(hits.length).toBe(2);
    expect(hits[0]?.score).toBeLessThan(hits[1]!.score); // more negative first
  });
});

describe("db lifecycle + rebuild", () => {
  test("fresh db has matching schema version and healthy fts", async () => {
    const { handle } = await freshDb("life");
    expect(schemaMismatch(handle)).toBe(false);
    expect(ftsHealthy(handle)).toBe(true);
  });

  test("rebuild reconstructs identical searchable index from objects+cas_meta", async () => {
    const { dir, handle } = await freshDb("rebuild");
    const messages: ChatMessage[] = [
      user("u1", "查询部署状态并检查日志"),
      {
        info: { id: "t1", role: "assistant" },
        parts: [{ type: "tool", tool: "bash", state: { status: "ok", output: "deploy ok at step 3" } }],
      },
      user("u2", "why did the retry fail"),
    ];
    let seq = 0;
    for (const [index, message] of messages.entries()) {
      const { hash } = await writeMessageObject(dir, message);
      insertCasMeta(handle, {
        hash,
        projectId: "proj",
        sessionId: "sess",
        role: message.info.role,
        turnIndex: index,
        msgSeq: seq++,
        historyHash: "hh1",
        createdAt: 1000,
      });
    }

    const first = await rebuildFromObjects(dir, handle);
    expect(first.chunks).toBe(3);
    expect(first.histories).toBe(1);

    const beforeZh = searchChunks(handle.db, { projectId: "proj", sessionId: "sess" }, buildMatchQuery("部署")!, 5);
    const beforeEn = searchChunks(handle.db, { projectId: "proj", sessionId: "sess" }, buildMatchQuery("retry")!, 5);
    expect(beforeZh.length).toBeGreaterThan(0);
    expect(beforeEn.length).toBeGreaterThan(0);

    // Rebuild twice: results byte-identical (deterministic summaries).
    const second = await rebuildFromObjects(dir, handle);
    expect(second).toEqual(first);
    const afterZh = searchChunks(handle.db, { projectId: "proj", sessionId: "sess" }, buildMatchQuery("部署")!, 5);
    expect(afterZh).toEqual(beforeZh);
  });

  test("cas_meta rows without objects are skipped by rebuild (objects are truth)", async () => {
    const { dir, handle } = await freshDb("orphan");
    insertCasMeta(handle, {
      hash: "e".repeat(64), projectId: "p", sessionId: "s", role: "user",
      turnIndex: 0, msgSeq: 0, historyHash: "h", createdAt: 1,
    });
    const result = await rebuildFromObjects(dir, handle);
    expect(result.chunks).toBe(0);
    expect(result.histories).toBe(0);
  });
});
