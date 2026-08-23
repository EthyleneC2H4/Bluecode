import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  handleSessionIdle,
  handleMessagesTransform,
  handleCompacting,
  shutdownHeadroom,
  resetHeadroomState,
  setPendingPlan,
  getPendingPlan,
  clearPendingPlan,
} from "../src/headroom";
import { parseOptions } from "../src/config";
import type { ChatMessage } from "@bluecode/contracts";
import { COMPACTION_MARKER } from "@bluecode/headroomd";

// Mock SDK client - mimics opencode SDK message format
function createMockSdkClient(overrides: Partial<{
  messages: any[];
  sessionGet: any;
  modelGet: any;
}> = {}) {
  // SDK messages have tokens on the message object itself, not in info
  const defaultMessages = [
    { id: "msg-1", role: "user", parts: [{ type: "text", text: "Hello" }] },
    { id: "msg-2", role: "assistant", tokens: { total: 150000 }, parts: [{ type: "text", text: "Hi!" }] },
  ];

  return {
    session: {
      // Real opencode SDK wraps every response in { data }: handleSessionIdle
      // and fetchModelContextWindow both read .data — mocks must match.
      messages: async ({ sessionID, limit }: { sessionID: string; limit?: number }) => {
        return { data: overrides.messages ?? defaultMessages };
      },
      get: async ({ id }: { id: string }) => {
        return { data: overrides.sessionGet ?? { id, model: { providerID: "anthropic", modelID: "claude-3" } } };
      },
    },
    model: {
      get: async ({ providerID, modelID }: { providerID: string; modelID: string }) => {
        return { data: overrides.modelGet ?? { limit: { context: 200000, input: 150000 }, id: modelID, providerID } };
      },
    },
  } as any;
}

// Mock HeadroomClient
let compressCallCount = 0;
const mockHeadroomCompress = async (params: any) => {
  compressCallCount++;
  return mockHeadroomCompressImpl(params);
};

let mockHeadroomCompressImpl: (params: any) => Promise<any> = async () => ({
  compacted: false,
  historyHash: null,
  summary: null,
  refs: [],
  replacedMessageIds: [],
  rawTokens: 0,
  summaryTokens: 0,
  freedTokens: 0,
});

import * as headroomModule from "@bluecode/headroomd";
const originalHeadroomConnect = headroomModule.HeadroomClient.connect;

beforeEach(() => {
  compressCallCount = 0;
  resetHeadroomState();
  (headroomModule.HeadroomClient as any).connect = async () => {
    console.error("[TEST] Mock HeadroomClient.connect called");
    return {
      compress: mockHeadroomCompress,
      close: async () => {},
      retrieve: async () => ({ found: false }),
      health: async () => ({ ok: true, pid: 123, uptimeMs: 1000, sessions: 0 }),
    };
  };
});

afterEach(async () => {
  (headroomModule.HeadroomClient as any).connect = originalHeadroomConnect;
  await shutdownHeadroom();
});

const defaultOptions = parseOptions({});

function makeMsg(id: string, role: "user" | "assistant", text: string, tokens?: number): ChatMessage {
  const msg: ChatMessage = {
    info: { id, role },
    parts: [{ type: "text", text }],
  };
  if (tokens !== undefined) {
    (msg.info as any).tokens = { total: tokens };
  }
  return msg;
}

// Helper to create SDK-format messages (tokens at top level)
function makeSdkMsg(id: string, role: "user" | "assistant", text: string, tokens?: number): any {
  const msg: any = { id, role, parts: [{ type: "text", text }] };
  if (tokens !== undefined) {
    msg.tokens = { total: tokens };
  }
  return msg;
}

describe("headroom: waterlevel detection", () => {
  test("triggers compress when tokens >= contextWindow * triggerRatio", async () => {
    const sdkClient = createMockSdkClient({
      messages: [
        makeSdkMsg("msg-1", "user", "Hello"),
        makeSdkMsg("msg-2", "assistant", "Hi!", 150000), // 150k tokens
      ],
      modelGet: { limit: { context: 200000 }, id: "claude-3", providerID: "anthropic" },
    });

    mockHeadroomCompressImpl = async () => {
      console.error("[TEST] mockHeadroomCompressImpl called with compacted=true");
      return {
        compacted: true,
        historyHash: "hist-hash",
        summary: "Summary",
        refs: [{ contentHash: "abc", role: "user", turnIndex: 0 }],
        replacedMessageIds: ["msg-1", "msg-2"],
        rawTokens: 150000,
        summaryTokens: 1000,
        freedTokens: 149000,
      };
    };

    // triggerRatio = 0.7, contextWindow = 200000, usable = 140000
    // tokens = 150000 >= 140000 -> should trigger
    console.error("[TEST] Calling handleSessionIdle");
    await handleSessionIdle({ sessionID: "sess-1" }, sdkClient, defaultOptions);
    console.error("[TEST] handleSessionIdle returned");

    const pending = getPendingPlan("sess-1");
    // getPendingPlan(id) returns the plan directly (never a Map); narrowing
    // here keeps the runtime check AND satisfies TS.
    if (pending === undefined || pending instanceof Map) {
      throw new Error("pending plan was not stored for sess-1");
    }
    expect(pending.plan.historyHash).toBe("hist-hash");
    expect(pending.plan.replacedMessageIds).toEqual(["msg-1", "msg-2"]);
  });

  test("does NOT trigger when tokens < contextWindow * triggerRatio", async () => {
    const sdkClient = createMockSdkClient({
      messages: [
        makeSdkMsg("msg-1", "user", "Hello"),
        makeSdkMsg("msg-2", "assistant", "Hi!", 50000), // 50k tokens
      ],
      modelGet: { limit: { context: 200000 }, id: "claude-3", providerID: "anthropic" },
    });

    mockHeadroomCompressImpl = async () => {
      throw new Error("should not be called");
    };

    // triggerRatio = 0.7, usable = 140000
    // tokens = 50000 < 140000 -> should NOT trigger
    await handleSessionIdle({ sessionID: "sess-1" }, sdkClient, defaultOptions);

    const pendingMap = getPendingPlan("sess-1");
    if (pendingMap instanceof Map) {
      expect(pendingMap.get("sess-1")).toBeUndefined();
    } else {
      expect(pendingMap).toBeUndefined();
    }
  });

  test("in-flight guard prevents concurrent compress for same session", async () => {
    const sdkClient = createMockSdkClient({
      messages: [
        makeSdkMsg("msg-1", "user", "Hello"),
        makeSdkMsg("msg-2", "assistant", "Hi!", 150000),
      ],
    });

    // Use outer compressCallCount, reset it
    compressCallCount = 0;
    mockHeadroomCompressImpl = async () => {
      // Simulate slow compress
      await new Promise(r => setTimeout(r, 50));
      return {
        compacted: true,
        historyHash: "hist-hash",
        summary: "Summary",
        refs: [],
        replacedMessageIds: ["msg-1", "msg-2"],
        rawTokens: 150000,
        summaryTokens: 1000,
        freedTokens: 149000,
      };
    };

    // Fire two idle events concurrently
    await Promise.all([
      handleSessionIdle({ sessionID: "sess-1" }, sdkClient, defaultOptions),
      handleSessionIdle({ sessionID: "sess-1" }, sdkClient, defaultOptions),
    ]);

    // Only one compress should have executed
    expect(compressCallCount).toBe(1);
  });
});

describe("headroom: messages.transform consumes plan", () => {
  test("applies pending plan and clears it", async () => {
    const output = {
      messages: [
        makeMsg("msg-1", "user", "Hello"),
        makeMsg("msg-2", "assistant", "Hi!"),
        makeMsg("msg-3", "user", "How are you?"),
      ],
    };

    setPendingPlan("sess-1", {
      refs: [{ contentHash: "abc", role: "user", turnIndex: 0 }],
      summary: "User greeted",
      replacedMessageIds: ["msg-1", "msg-2"],
      historyHash: "hist-hash",
    });

    await handleMessagesTransform(output, "sess-1");

    expect(output.messages.length).toBe(2); // 3 - 2 + 1
    const firstPart = output.messages[0]?.parts[0];
    expect(firstPart?.type).toBe("text");
    if (firstPart?.type === "text") {
      expect(firstPart.text).toContain(COMPACTION_MARKER);
      expect(firstPart.text).toContain("User greeted");
    }
    expect(output.messages[1]?.info.id).toBe("msg-3");

    // Plan should be cleared
    const pendingAfter = getPendingPlan("sess-1");
    if (pendingAfter instanceof Map) {
      expect(pendingAfter.get("sess-1")).toBeUndefined();
    } else {
      expect(pendingAfter).toBeUndefined();
    }
  });

  test("no pending plan: no-op", async () => {
    const output = {
      messages: [makeMsg("msg-1", "user", "Hello")],
    };

    await handleMessagesTransform(output, "sess-1");

    expect(output.messages.length).toBe(1);
    expect(output.messages[0]?.info.id).toBe("msg-1");
  });

  test("second call (simulating compaction second trigger point) is no-op after plan consumed", async () => {
    const output = {
      messages: [
        makeMsg("msg-1", "user", "Hello"),
        makeMsg("msg-2", "assistant", "Hi!"),
      ],
    };

    setPendingPlan("sess-1", {
      refs: [],
      summary: "Summary",
      replacedMessageIds: ["msg-1", "msg-2"],
      historyHash: "hist-hash",
    });

    // First call - applies plan
    await handleMessagesTransform(output, "sess-1");
    const lenAfterFirst = output.messages.length;

    // Second call - no plan, should be no-op
    await handleMessagesTransform(output, "sess-1");

    expect(output.messages.length).toBe(lenAfterFirst);
  });
});

describe("headroom: compacting hook", () => {
  test("fallback=upstream: injects context with retrieve hint", async () => {
    const output = { context: [] as string[] };
    const upstreamOptions = parseOptions({ headroom: { fallback: "upstream" } });

    await handleCompacting({ sessionID: "sess-1" }, output, upstreamOptions);

    expect(output.context.length).toBe(1);
    expect(output.context[0]).toContain("headroom_retrieve");
    expect(output.context[0]).toContain("compacted");
  });

  test("fallback=passthrough: no-op", async () => {
    const output = { context: [] as string[] };
    const passthroughOptions = parseOptions({ headroom: { fallback: "passthrough" } });

    await handleCompacting({ sessionID: "sess-1" }, output, passthroughOptions);

    expect(output.context.length).toBe(0);
  });

  test("disabled plugin: no-op", async () => {
    const output = { context: [] as string[] };
    const disabledOptions = parseOptions({ enabled: false });

    await handleCompacting({ sessionID: "sess-1" }, output, disabledOptions);

    expect(output.context.length).toBe(0);
  });
});