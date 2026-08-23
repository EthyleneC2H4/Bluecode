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

    expect(result).toBe(true);
    expect(messages).toBe(originalRef); // Same array reference
    expect(messages.length).toBe(3); // 5 - 3 + 1 = 3
    expect(messages[0]?.info.id).toContain("compaction-");
    const firstPart = messages[0]?.parts[0];
    expect(firstPart?.type).toBe("text");
    if (firstPart?.type === "text") {
      expect(firstPart.text).toContain(COMPACTION_MARKER);
      expect(firstPart.text).toContain("User greeted");
      expect(firstPart.text).toContain("abc123");
      expect(firstPart.text).toContain("history-hash-123");
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

    expect(first).toBe(true);
    expect(second).toBe(false); // No-op
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

    expect(result).toBe(false); // No-op because marker detected
    expect(messages.length).toBe(2);
    const firstPart = messages[0]?.parts[0];
    expect(firstPart?.type).toBe("text");
    if (firstPart?.type === "text") {
      expect(firstPart.text).toBe(`${COMPACTION_MARKER} Already compacted`);
    }
  });

  test("missing message IDs are skipped safely", () => {
    const plan = {
      refs: [],
      summary: "Summary",
      replacedMessageIds: ["msg-1", "nonexistent", "msg-3"],
      historyHash: "history-hash-123",
    };

    const result = applyPlanInPlace(messages, plan);

    expect(result).toBe(true);
    expect(messages.length).toBe(4); // 5 - 2 + 1 = 4 (msg-1 and msg-3 removed, replacement added)
    expect(messages[0]?.info.id).toContain("compaction-");
    expect(messages[1]?.info.id).toBe("msg-2"); // msg-2 preserved
    expect(messages[2]?.info.id).toBe("msg-4"); // msg-4 preserved
    expect(messages[3]?.info.id).toBe("msg-5"); // msg-5 preserved
  });

  test("empty replacedMessageIds is no-op", () => {
    const plan = {
      refs: [],
      summary: "Summary",
      replacedMessageIds: [],
      historyHash: "history-hash-123",
    };

    const result = applyPlanInPlace(messages, plan);

    expect(result).toBe(false);
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

    expect(result).toBe(true);
    const firstPart = messages[0]?.parts[0];
    expect(firstPart?.type).toBe("text");
    if (firstPart?.type === "text") {
      expect(firstPart.text).toContain(COMPACTION_MARKER);
      expect(firstPart.text).not.toContain("**Summary:**");
      expect(firstPart.text).not.toContain("**Original turns");
      expect(firstPart.text).not.toContain("**Retrieve full history");
    }
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
});