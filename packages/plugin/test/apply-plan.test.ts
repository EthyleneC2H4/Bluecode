import { describe, expect, test, beforeEach } from "bun:test";
import { applyPlanInPlace } from "../src/apply-plan";
import type { ChatMessage } from "@bluecode/contracts";
import { COMPACTION_MARKER } from "@bluecode/headroomd";

function makeMessage(id: string, role: "user" | "assistant", text: string): ChatMessage {
  return {
    info: { id, role },
    parts: [{ type: "text", text }],
  };
}

describe("applyPlanInPlace", () => {
  let messages: ChatMessage[];

  beforeEach(() => {
    messages = [
      makeMessage("msg-1", "user", "Hello"),
      makeMessage("msg-2", "assistant", "Hi there"),
      makeMessage("msg-3", "user", "How are you?"),
      makeMessage("msg-4", "assistant", "I'm good"),
      makeMessage("msg-5", "user", "Nice"),
    ];
  });

  test("normal replacement mutates the array in place", () => {
    const originalRef = messages;
    const plan = {
      refs: [
        { contentHash: "abc123", role: "user" as const, turnIndex: 0 },
        { contentHash: "def456", role: "assistant" as const, turnIndex: 0 },
        { contentHash: "ghi789", role: "user" as const, turnIndex: 1 },
      ],
      summary: "User greeted, assistant responded, user asked how are you",
      replacedMessageIds: ["msg-1", "msg-2", "msg-3"],
      historyHash: "history-hash-123",
    };

    const result = applyPlanInPlace(messages, plan);

    expect(result).toBe("applied");
    expect(messages).toBe(originalRef); // Same array reference
    expect(messages.length).toBe(3); // 5 - 3 + 1 = 3
    expect(messages[0]?.info.id).toContain("compaction-");
    const firstPart = messages[0]?.parts[0];
    expect(firstPart?.type).toBe("text");
    if (firstPart?.type === "text") {
      expect(firstPart.text).toContain(COMPACTION_MARKER);
      expect(firstPart.text).toContain("User greeted");
      expect(firstPart.text).not.toContain("abc123");
      expect(firstPart.text).toContain("history-hash-123");
      expect(firstPart.text).toContain('headroom_retrieve(historyHash="history-hash-123")');
    }
    expect(messages[1]?.info.id).toBe("msg-4");
    expect(messages[2]?.info.id).toBe("msg-5");
  });

  test("idempotent: second application with same plan is no-op", () => {
    const plan = {
      refs: [{ contentHash: "abc123", role: "user" as const, turnIndex: 0 }],
      summary: "Summary",
      replacedMessageIds: ["msg-1", "msg-2"],
      historyHash: "history-hash-123",
    };

    const first = applyPlanInPlace(messages, plan);
    const lenAfterFirst = messages.length;
    const firstMsgId = messages[0]?.info.id;

    const second = applyPlanInPlace(messages, plan);

    expect(first).toBe("applied");
    expect(second).toBe("already-compacted");
    expect(messages.length).toBe(lenAfterFirst);
    expect(messages[0]?.info.id).toBe(firstMsgId); // Same replacement message
  });

  test("idempotent: re-applying when already replaced (marker detected)", () => {
    // Manually insert a compaction replacement message
    messages = [
      makeMessage("compaction-abc", "user", `${COMPACTION_MARKER} Already compacted`),
      makeMessage("msg-3", "user", "How are you?"),
    ];

    const plan = {
      refs: [],
      summary: "Summary",
      replacedMessageIds: ["compaction-abc"], // Try to replace the compaction message itself
      historyHash: "history-hash-123",
    };

    const result = applyPlanInPlace(messages, plan);

    expect(result).toBe("already-compacted");
    expect(messages.length).toBe(2);
    const firstPart = messages[0]?.parts[0];
    expect(firstPart?.type).toBe("text");
    if (firstPart?.type === "text") {
      expect(firstPart.text).toBe(`${COMPACTION_MARKER} Already compacted`);
    }
  });

  test("a partially missing plan is invalid and leaves the array byte-for-byte unchanged", () => {
    const before = structuredClone(messages);
    const plan = {
      refs: [],
      summary: "Summary",
      replacedMessageIds: ["msg-1", "nonexistent", "msg-3"],
      historyHash: "history-hash-123",
    };

    const result = applyPlanInPlace(messages, plan);

    expect(result).toBe("invalid");
    expect(messages).toEqual(before);
  });

  test("empty replacedMessageIds is no-op", () => {
    const plan = {
      refs: [],
      summary: "Summary",
      replacedMessageIds: [],
      historyHash: "history-hash-123",
    };

    const result = applyPlanInPlace(messages, plan);

    expect(result).toBe("invalid");
    expect(messages.length).toBe(5);
  });

  test("plan with no refs and no summary still produces valid marker", () => {
    const plan = {
      refs: [],
      summary: null,
      replacedMessageIds: ["msg-1", "msg-2"],
      historyHash: null,
    };

    const result = applyPlanInPlace(messages, plan);

    expect(result).toBe("applied");
    const firstPart = messages[0]?.parts[0];
    expect(firstPart?.type).toBe("text");
    if (firstPart?.type === "text") {
      expect(firstPart.text).toContain(COMPACTION_MARKER);
      expect(firstPart.text).not.toContain("**Summary:**");
      expect(firstPart.text).not.toContain("**Original turns");
      expect(firstPart.text).not.toContain("**Retrieve full history");
    }
  });

  test("second compaction merges the prior replacement into the new one (devlog #43)", () => {
    // Regression for the over-broad idempotency guard: headroomd splitTurns
    // hashes a prior replacement like any other user message, so a SECOND
    // compaction plan leads with the old replacement's id. The guard must
    // refuse only when EVERY located message is a replacement — here msg-4 is
    // not, so the plan applies and both ranges merge into one new marker.
    const plan1 = {
      refs: [{ contentHash: "abc123", role: "user" as const, turnIndex: 0 }],
      summary: "First summary",
      replacedMessageIds: ["msg-1", "msg-2"],
      historyHash: "hash-1",
    };
    expect(applyPlanInPlace(messages, plan1)).toBe("applied");
    const firstReplacementId = messages[0]?.info.id;
    expect(firstReplacementId).toContain("compaction-");

    // Plan 2 covers turn 0 (now the applied replacement) plus every remaining
    // old turn msg-3/msg-4/msg-5.
    const plan2 = {
      refs: [{ contentHash: "def456", role: "user" as const, turnIndex: 1 }],
      summary: "Second summary",
      replacedMessageIds: [firstReplacementId!, "msg-3", "msg-4", "msg-5"].filter((id) =>
        messages.some((m) => m.info.id === id),
      ),
      historyHash: "hash-2",
    };

    const result = applyPlanInPlace(messages, plan2);

    expect(result).toBe("applied");
    expect(messages.length).toBe(1); // merged into a single replacement
    const part = messages[0]?.parts[0];
    expect(part?.type).toBe("text");
    if (part?.type === "text") {
      expect(part.text).toContain(COMPACTION_MARKER);
      expect(part.text).toContain("Second summary");
      expect(part.text).toContain("hash-2");
      // The stale first summary must not survive the merge.
      expect(part.text).not.toContain("First summary");
    }
  });

  test("plan whose ONLY located message is a replacement still refuses (single-id replay)", () => {
    // Companion to the devlog #43 fix: same-plan replay matches zero ids and
    // exits at indices.length === 0; a single-replacement-id hit remains a
    // no-op because every located message is a replacement.
    const plan = {
      refs: [],
      summary: "Summary",
      replacedMessageIds: ["msg-1", "msg-2"],
      historyHash: "history-hash-123",
    };
    expect(applyPlanInPlace(messages, plan)).toBe("applied");
    const replacementId = messages[0]?.info.id;
    const lenAfterFirst = messages.length;

    const replay = applyPlanInPlace(messages, { ...plan, replacedMessageIds: [replacementId!] });

    expect(replay).toBe("already-compacted");
    expect(messages.length).toBe(lenAfterFirst);
  });

  test("replacement message has correct structure", () => {
    const plan = {
      refs: [{ contentHash: "hash1", role: "user" as const, turnIndex: 0 }],
      summary: "Test summary",
      replacedMessageIds: ["msg-1"],
      historyHash: "hist-hash",
    };

    applyPlanInPlace(messages, plan);

    const replacement = messages[0];
    expect(replacement?.info.role).toBe("user");
    expect(replacement?.info.id).toContain("compaction-");
    expect(replacement?.parts.length).toBe(1);
    expect(replacement?.parts[0]?.type).toBe("text");
    const part0 = replacement?.parts[0];
    expect(part0?.type).toBe("text");
    if (part0?.type === "text") {
      expect(part0.text).toContain(COMPACTION_MARKER);
    }
  });

  test("duplicate plan IDs are invalid and preserve the original array", () => {
    const originalRef = messages;
    const before = structuredClone(messages);
    const result = applyPlanInPlace(messages, {
      refs: [],
      summary: "Summary",
      replacedMessageIds: ["msg-1", "msg-1"],
      historyHash: "duplicate",
    });
    expect(result).toBe("invalid");
    expect(messages).toBe(originalRef);
    expect(messages).toEqual(before);
  });

  test("non-contiguous or out-of-order plans are invalid and atomic", () => {
    for (const replacedMessageIds of [
      ["msg-1", "msg-3"],
      ["msg-2", "msg-1"],
    ]) {
      const candidate = structuredClone(messages);
      const before = structuredClone(candidate);
      const result = applyPlanInPlace(candidate, {
        refs: [],
        summary: "Summary",
        replacedMessageIds,
        historyHash: "invalid-order",
      });
      expect(result).toBe("invalid");
      expect(candidate).toEqual(before);
    }
  });

  test("a plan from another session is no-match and preserves every message", () => {
    const before = structuredClone(messages);
    const result = applyPlanInPlace(messages, {
      refs: [],
      summary: "Other session",
      replacedMessageIds: ["other-1", "other-2"],
      historyHash: "other-history",
    });
    expect(result).toBe("no-match");
    expect(messages).toEqual(before);
  });
});
