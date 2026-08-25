/**
 * Store layer: CAS message objects, FTS search (including the CJK
 * pre-segmentation contract from the spike), namespace isolation, and index
 * rebuild determinism.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { contentHash } from "../src/turns";
import {
  countChunks,
  ftsHealthy,
  indexLooksLost,
  openIndexDb,
  openMetaDb,
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

interface FreshStore {
  dir: string;
  meta: HeadroomDb;
  index: HeadroomDb;
}

async function freshDb(label: string): Promise<FreshStore> {
  const dir = await mkdtemp(path.join(tmpdir(), `bluecode-hd-${label}-`));
  dirs.push(dir);
  const meta = openMetaDb(path.join(dir, "meta.db"));
  const index = openIndexDb(path.join(dir, "index.db"));
  dbs.push(meta, index);
  return { dir, meta, index };
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
    // The address is the LOGICAL contentHash (canonical projection), not a
    // digest of the gzip bytes — refs/cas_meta/retrieve share the namespace.
    const hash = await contentHash(message);
    const first = await writeMessageObject(dir, message, hash);
    expect(first.hash).toBe(hash);
    const second = await writeMessageObject(dir, message, hash);
    expect(second.existed).toBe(true);

    const loaded = await readMessageObject(dir, hash);
    expect(loaded).toEqual({ info: message.info, parts: message.parts });

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
    const { index: handle } = await freshDb("cjk");
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
    const { index: handle } = await freshDb("leak");
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
    const { index: handle } = await freshDb("rank");
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
    const { index: handle } = await freshDb("life");
    expect(schemaMismatch(handle)).toBe(false);
    expect(ftsHealthy(handle)).toBe(true);
  });

  test("rebuild reconstructs identical searchable index from objects+cas_meta", async () => {
    const { dir, meta, index: handle } = await freshDb("rebuild");
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
      const hash = await contentHash(message);
      await writeMessageObject(dir, message, hash);
      insertCasMeta(meta, {
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

    const first = await rebuildFromObjects(dir, meta, handle);
    expect(first.chunks).toBe(3);
    expect(first.histories).toBe(1);
    // Review fix: rebuilt summaries keep the archive's original created_at
    // (carried from cas_meta), not a reset-to-0 placeholder.
    const stamped = handle.db.prepare(`SELECT created_at AS t FROM histories`).get() as {
      t: number;
    };
    expect(stamped.t).toBe(1000);

    const beforeZh = searchChunks(handle.db, { projectId: "proj", sessionId: "sess" }, buildMatchQuery("部署")!, 5);
    const beforeEn = searchChunks(handle.db, { projectId: "proj", sessionId: "sess" }, buildMatchQuery("retry")!, 5);
    expect(beforeZh.length).toBeGreaterThan(0);
    expect(beforeEn.length).toBeGreaterThan(0);

    // Rebuild twice: results byte-identical (deterministic summaries).
    const second = await rebuildFromObjects(dir, meta, handle);
    expect(second).toEqual(first);
    const afterZh = searchChunks(handle.db, { projectId: "proj", sessionId: "sess" }, buildMatchQuery("部署")!, 5);
    expect(afterZh).toEqual(beforeZh);
  });

  test("cas_meta rows without objects are skipped by rebuild (objects are truth)", async () => {
    const { dir, meta, index: handle } = await freshDb("orphan");
    insertCasMeta(meta, {
      hash: "e".repeat(64), projectId: "p", sessionId: "s", role: "user",
      turnIndex: 0, msgSeq: 0, historyHash: "h", createdAt: 1,
    });
    const result = await rebuildFromObjects(dir, meta, handle);
    expect(result.chunks).toBe(0);
    expect(result.histories).toBe(0);
  });

  test("one corrupt object among good ones is skipped and counted, rebuild still succeeds", async () => {
    const { dir, meta, index: handle } = await freshDb("corrupt");
    const good: ChatMessage[] = [
      user("u1", "survives the corruption"),
      user("u2", "also survives"),
    ];
    let seq = 0;
    for (const [index, message] of good.entries()) {
      const hash = await contentHash(message);
      await writeMessageObject(dir, message, hash);
      insertCasMeta(meta, {
        hash,
        projectId: "p",
        sessionId: "s",
        role: message.info.role,
        turnIndex: index,
        msgSeq: seq++,
        historyHash: "hh",
        createdAt: 10,
      });
    }

    // Plant a PRESENT but corrupt object (valid-shaped hash, garbage body —
    // readMessageObject throws inside gunzip/JSON.parse; a bare await used to
    // abort the whole heal and crash-loop startup).
    const badHash = "de" + "0".repeat(62);
    const badDir = path.join(dir, "objects", "de");
    await mkdir(badDir, { recursive: true });
    await writeFile(path.join(badDir, badHash), Buffer.from("definitely-not-gzip"));
    insertCasMeta(meta, {
      hash: badHash,
      projectId: "p",
      sessionId: "s",
      role: "assistant",
      turnIndex: 9,
      msgSeq: seq++,
      historyHash: "hh",
      createdAt: 11,
    });

    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...parts: unknown[]) => warns.push(parts.map(String).join(" "));
    let result: Awaited<ReturnType<typeof rebuildFromObjects>>;
    try {
      result = await rebuildFromObjects(dir, meta, handle);
    } finally {
      console.warn = originalWarn;
    }
    // Exactly the corrupt one skipped; goods fully rebuilt; warn names the hash.
    expect(result.skipped).toBe(1);
    expect(result.chunks).toBe(good.length);
    expect(warns.some((line) => line.includes("skipping corrupt object") && line.includes(badHash)))
      .toBe(true);
  });

  test("rebuild records skipped alongside expectation (single-row bookkeeping)", async () => {
    // One corrupt object among three: recorded state must capture BOTH the
    // written-chunk count AND the permanent gap it leaves vs cas_meta.
    const { dir, meta, index: handle } = await freshDb("record");
    const good = user("u1", "recorded correctly");
    const hash = await contentHash(good);
    await writeMessageObject(dir, good, hash);
    const badHash = "ca" + "0".repeat(62);
    await mkdir(path.join(dir, "objects", "ca"), { recursive: true });
    await writeFile(path.join(path.join(dir, "objects", "ca"), badHash), Buffer.from("junk"));
    for (const [seq, h] of [hash, badHash].entries()) {
      insertCasMeta(meta, {
        hash: h, projectId: "p", sessionId: "s",
        role: seq === 0 ? "user" : "assistant",
        turnIndex: seq, msgSeq: seq, historyHash: "hh", createdAt: 5,
      });
    }

    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...parts: unknown[]) => warns.push(parts.map(String).join(" "));
    let result: Awaited<ReturnType<typeof rebuildFromObjects>>;
    try {
      result = await rebuildFromObjects(dir, meta, handle);
    } finally {
      console.warn = originalWarn;
    }
    expect(result.skipped).toBe(1);

    const row = handle.db
      .prepare(`SELECT expected_chunks AS expectedChunks, skipped FROM rebuild_state`)
      .get() as { expectedChunks: number; skipped: number };
    expect(row.expectedChunks).toBe(1);
    expect(row.skipped).toBe(1);
    // Convergence: the legitimate gap no longer reads as a lost index.
    expect(indexLooksLost(handle, meta)).toBe(false);
  });
});

describe("indexLooksLost failure shapes", () => {
  let nextChunk = 0;
  let nextMeta = 0;
  function addChunks(handle: HeadroomDb, n: number): void {
    for (let i = 0; i < n; i++) {
      insertChunk(handle.db, {
        contentHash: `${(nextChunk++).toString().padStart(2, "0")}`.padEnd(64, "a"),
        projectId: "p", sessionId: "s", role: "user", turnIndex: i,
        historyHash: "hh", summaryText: "t", rawExcerpt: "e", keywords: "t",
      });
    }
  }
  function addCasMeta(meta: HeadroomDb, n: number): void {
    for (let i = 0; i < n; i++) {
      // INSERT OR IGNORE dedups on hash PK — the counter keeps every row live.
      insertCasMeta(meta, {
        hash: `m${nextMeta++}`.padEnd(64, "b"),
        projectId: "p", sessionId: "s", role: "user",
        turnIndex: i, msgSeq: nextMeta, historyHash: "hh", createdAt: 1,
      });
    }
  }
  function record(index: HeadroomDb, expectedChunks: number, skipped: number): void {
    index.db.exec(`DELETE FROM rebuild_state`);
    index.db.prepare(`INSERT INTO rebuild_state(expected_chunks, skipped) VALUES (?, ?)`).run(
      expectedChunks,
      skipped,
    );
  }

  test("no row: legacy comparison still guards a fresh/deleted index.db", async () => {
    const { meta, index: handle } = await freshDb("lost-legacy");
    expect(indexLooksLost(handle, meta)).toBe(false); // nothing archived yet
    addCasMeta(meta, 3);
    expect(indexLooksLost(handle, meta)).toBe(true); // attribution without chunks
  });

  test("row present: chunks below expectation fires (rows genuinely lost)", async () => {
    const { meta, index: handle } = await freshDb("lost-below");
    addCasMeta(meta, 5);
    addChunks(handle, 5);
    record(handle, 5, 0);
    expect(indexLooksLost(handle, meta)).toBe(false);
    // Five committed chunk rows vanish (rollback / manual tampering).
    handle.db.exec(`DELETE FROM chunks WHERE content_hash LIKE '00%'`);
    expect(indexLooksLost(handle, meta)).toBe(true);
  });

  test("row present: meta ahead of index fires even with both sides above baseline", async () => {
    // Audit round 2 finding: WAL checkpoint divergence rolls meta.db back LESS
    // far than index.db. Baseline expected=3/skipped=1 survives on both sides,
    // but two stranded cas_meta rows never got their chunk writes.
    const { meta, index: handle } = await freshDb("lost-ahead");
    addCasMeta(meta, 6);
    addChunks(handle, 4);
    record(handle, 3, 1); // invariant at rebuild time: 3 chunks == 4 meta - 1 skip
    // Old probe (chunks < expected): 4 >= 3 → silent. New disjunct: 4+1 < 6.
    expect(indexLooksLost(handle, meta)).toBe(true);
  });

  test("row present: normal growth above the baseline never false-fires", async () => {
    const { meta, index: handle } = await freshDb("lost-growth");
    addCasMeta(meta, 8);
    addChunks(handle, 7); // 7 == 8 - 1 skipped
    record(handle, 3, 1);
    expect(indexLooksLost(handle, meta)).toBe(false);
  });

  test("legacy single-column rebuild_state is migrated away on reopen", async () => {
    const { dir } = await freshDb("migrate");
    const indexPath = path.join(dir, "index.db");
    // Hand-craft the pre-skipped shape, then close both handles so reopening
    // exercises openIndexDb's migration, not IF NOT EXISTS.
    dbs.at(-1)?.close();
    dbs.at(-2)?.close();
    dbs.length -= 2;
    const legacy = openIndexDb(indexPath);
    legacy.db.exec(`DROP TABLE rebuild_state`);
    legacy.db.exec(`CREATE TABLE rebuild_state(expected_chunks INTEGER NOT NULL)`);
    legacy.close();

    const reopened = openIndexDb(indexPath);
    dbs.push(reopened);
    const columns = reopened.db.prepare(`PRAGMA table_info(rebuild_state)`).all() as Array<{
      name: string;
    }>;
    expect(columns.map((c) => c.name)).toContain("skipped");
    // The migrated table accepts the full two-column bookkeeping row.
    reopened.db.prepare(`INSERT INTO rebuild_state(expected_chunks, skipped) VALUES (?, ?)`).run(
      3,
      1,
    );
    const row = reopened.db
      .prepare(`SELECT expected_chunks AS e, skipped FROM rebuild_state`)
      .get() as { e: number; skipped: number };
    expect(row.e).toBe(3);
    expect(row.skipped).toBe(1);
  });
});
