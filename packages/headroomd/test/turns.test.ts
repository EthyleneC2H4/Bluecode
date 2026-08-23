import { describe, expect, test } from "bun:test";
import {
  COMPACTION_MARKER,
  canonicalJSON,
  contentHash,
  historyHash,
  splitTurns,
  turnHashes,
} from "../src/turns";
import type { ChatMessage } from "@bluecode/contracts";

function user(id: string, text: string): ChatMessage {
  return { info: { id, role: "user" }, parts: [{ type: "text", text }] };
}
function assistant(id: string, text: string): ChatMessage {
  return { info: { id, role: "assistant" }, parts: [{ type: "text", text }] };
}
function replacement(id: string, summaryText: string): ChatMessage {
  return user(id, `${COMPACTION_MARKER}\n${summaryText}`);
}

describe("splitTurns", () => {
  test("alternating roles produce one turn per user message", () => {
    const turns = splitTurns([user("u1", "a"), assistant("a1", "b"), user("u2", "c")]);
    expect(turns.length).toBe(2);
    expect(turns[0]?.messageIds).toEqual(["u1", "a1"]);
    expect(turns[0]?.startMsgIndex).toBe(0);
    expect(turns[1]?.messageIds).toEqual(["u2"]);
    expect(turns[1]?.index).toBe(1);
  });

  test("consecutive user messages each start a new turn", () => {
    const turns = splitTurns([user("u1", "a"), user("u2", "b"), assistant("a1", "c")]);
    expect(turns.map((t) => t.messageIds)).toEqual([["u1"], ["u2", "a1"]]);
  });

  test("a compaction replacement message opens its own turn", () => {
    const turns = splitTurns([
      user("u1", "old question"),
      assistant("a1", "old answer"),
      replacement("r1", "summary of old turns"),
      assistant("a2", "continuation"),
    ]);
    // r1 is a user message: it closes the old turn and opens the next one,
    // with a2 appended to it.
    expect(turns.length).toBe(2);
    expect(turns[0]?.messageIds).toEqual(["u1", "a1"]);
    expect(turns[1]?.messageIds).toEqual(["r1", "a2"]);
  });

  test("leading assistant message still forms turn 0", () => {
    const turns = splitTurns([assistant("a1", "x"), user("u1", "y")]);
    expect(turns.length).toBe(2);
    expect(turns[0]?.messageIds).toEqual(["a1"]);
  });

  test("empty input -> no turns", () => {
    expect(splitTurns([])).toEqual([]);
  });
});

describe("hashes", () => {
  const msg = user("u1", "hello world");

  test("contentHash is stable across calls and inputs", async () => {
    const h1 = await contentHash(msg);
    const h2 = await contentHash({ ...msg });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  test("one character changes the hash (distinctness)", async () => {
    const other = await contentHash(user("u1", "hello worlds"));
    expect(other).not.toBe(await contentHash(msg));
  });

  test("tool output participates in the hash", async () => {
    const withTool: ChatMessage = {
      info: { id: "t1", role: "assistant" },
      parts: [{ type: "tool", tool: "bash", state: { status: "done", output: "line1\nline2" } }],
    };
    const changed: ChatMessage = {
      info: { id: "t1", role: "assistant" },
      parts: [{ type: "tool", tool: "bash", state: { status: "done", output: "line1\nXX" } }],
    };
    expect(await contentHash(withTool)).not.toBe(await contentHash(changed));
  });

  test("historyHash covers the nested per-turn structure and is order-sensitive", async () => {
    const turnsA = splitTurns([user("u1", "q1"), assistant("a1", "ans")]);
    const turnsB = splitTurns([user("u1", "q1"), assistant("a1", "different")]);
    expect(await historyHash(turnsA)).toBe(await historyHash(turnsA));
    expect(await historyHash(turnsA)).not.toBe(await historyHash(turnsB));

    const swapped = splitTurns([assistant("a1", "ans"), user("u1", "q1")]);
    expect(await historyHash(swapped)).not.toBe(await historyHash(turnsA));
  });

  test("turnHashes returns per-turn ordered hex lists", async () => {
    const turns = splitTurns([user("u1", "q"), assistant("a1", "a")]);
    const hashes = await turnHashes(turns);
    expect(hashes.length).toBe(1);
    expect(hashes[0]?.length).toBe(2);
    for (const hex of hashes.flat()) expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("canonicalJSON", () => {
  test("sorted keys, no whitespace, drops undefined", () => {
    expect(canonicalJSON({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJSON({ a: "x", c: undefined, b: [1, { z: 0, y: null }] })).toBe(
      '{"a":"x","b":[1,{"y":null,"z":0}]}',
    );
  });
});
