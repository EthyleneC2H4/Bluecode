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
  setSharedHeadroomClient,
  fetchCompleteSessionMessages,
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
  // SDK list items wrap the message as { info, parts } with tokens and the
  // serving model on info — mocks must match that wire shape exactly.
  const defaultMessages = [
    { info: { id: "msg-1", role: "user" }, parts: [{ type: "text", text: "Hello" }] },
    {
      info: { id: "msg-2", role: "assistant", tokens: { total: 150000 }, providerID: "anthropic", modelID: "claude-3" },
      parts: [{ type: "text", text: "Hi!" }],
    },
  ];

  return {
    session: {
      // hey-api client: list requests take { path: {id}, query }.
      messages: async ({ path, query }: { path: { id: string }; query?: { limit?: number } }) => {
        return { data: overrides.messages ?? defaultMessages };
      },
    },
    config: {
      providers: async () => {
        return {
          data: overrides.modelGet ?? {
            providers: [
              {
                id: "anthropic",
                models: { "claude-3": { id: "claude-3", limit: { context: 200000, output: 8192 } } },
              },
            ],
            default: {},
          },
        };
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
  sourceTokensEst: 0,
  evictedTokensEst: 0,
  retainedTokensEst: 0,
  replacementTokensEst: 0,
  finalTokensEst: 0,
  freedTokens: 0,
});

import * as headroomModule from "@bluecode/headroomd";
const originalHeadroomConnect = headroomModule.HeadroomClient.connect;

beforeEach(() => {
  compressCallCount = 0;
  resetHeadroomState();
  // Set up shared mock client for getSharedHeadroomClient()
  setSharedHeadroomClient({
    compress: mockHeadroomCompress,
    close: async () => {},
    retrieve: async () => ({ found: false }),
    health: async () => ({ ok: true, pid: 123, uptimeMs: 1000, sessions: 0 }),
  } as any);
});

afterEach(async () => {
  (headroomModule.HeadroomClient as any).connect = originalHeadroomConnect;
  setSharedHeadroomClient(null);
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

// Helper to create SDK-format messages ({ info, parts } wire shape).
// Tokens use the real SDK component shape (no total field).
function makeSdkMsg(id: string, role: "user" | "assistant", text: string, tokens?: number): any {
  const msg: any = {
    info: {
      id,
      role,
      ...(role === "assistant" ? { providerID: "anthropic", modelID: "claude-3" } : {}),
    },
    parts: [{ type: "text", text }],
  };
  if (tokens !== undefined) {
    const rest = tokens - 1000;
    msg.info.tokens = { input: rest, output: 500, reasoning: 500, cache: { read: 0, write: 0 } };
  }
  return msg;
}

describe("headroom: waterlevel detection", () => {
  test("fetchCompleteSessionMessages omits limit and preserves oldest-to-newest order", async () => {
    for (const count of [101, 201, 1000]) {
      const source = Array.from({ length: count }, (_, index) =>
        makeSdkMsg(`m-${index}`, index % 2 === 0 ? "user" : "assistant", `message ${index}`),
      );
      let request: unknown;
      const sdkClient = {
        session: {
          messages: async (input: unknown) => {
            request = input;
            return { data: source };
          },
        },
      } as any;

      const fetched = await fetchCompleteSessionMessages(sdkClient, `session-${count}`);
      expect(request).toEqual({ path: { id: `session-${count}` } });
      expect(fetched).toHaveLength(count);
      expect(fetched[0]?.info.id).toBe("m-0");
      expect(fetched[Math.floor(count / 2)]?.info.id).toBe(`m-${Math.floor(count / 2)}`);
      expect(fetched.at(-1)?.info.id).toBe(`m-${count - 1}`);
      expect(new Set(fetched.map((message: any) => message.info.id)).size).toBe(count);
    }
  });

  test("idle sends every message exactly once for 101, 201 and 1000-message sessions", async () => {
    for (const count of [101, 201, 1000]) {
      const source = Array.from({ length: count }, (_, index) =>
        makeSdkMsg(
          `long-${count}-${index}`,
          index % 2 === 0 ? "user" : "assistant",
          `message ${index}`,
          index === count - 2 || index === count - 1 ? 150000 : undefined,
        ),
      );
      const sdkClient = createMockSdkClient({ messages: source });
      let captured: ChatMessage[] = [];
      mockHeadroomCompressImpl = async (params) => {
        captured = params.messages;
        return {
          compacted: false,
          historyHash: null,
          summary: null,
          refs: [],
          replacedMessageIds: [],
          rawTokens: 150000,
          summaryTokens: 0,
          sourceTokensEst: 150000,
          evictedTokensEst: 0,
          retainedTokensEst: 150000,
          replacementTokensEst: 0,
          finalTokensEst: 150000,
          freedTokens: 0,
        };
      };

      await handleSessionIdle({ sessionID: `long-${count}` }, sdkClient, defaultOptions);
      const ids = captured.map((message) => message.info.id);
      expect(ids).toHaveLength(count);
      expect(ids[0]).toBe(`long-${count}-0`);
      expect(ids[Math.floor(count / 2)]).toBe(`long-${count}-${Math.floor(count / 2)}`);
      expect(ids.at(-1)).toBe(`long-${count}-${count - 1}`);
      expect(new Set(ids).size).toBe(count);
    }
  });

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

  test("invalid partial plan changes nothing and remains pending", async () => {
    const output = {
      messages: [makeMsg("msg-1", "user", "Hello"), makeMsg("msg-2", "assistant", "Hi")],
    };
    const before = structuredClone(output.messages);
    setPendingPlan("sess-1", {
      refs: [],
      summary: "Summary",
      replacedMessageIds: ["msg-1", "missing"],
      historyHash: "hist-invalid",
    });

    await handleMessagesTransform(output, "sess-1");

    expect(output.messages).toEqual(before);
    expect(getPendingPlan("sess-1")).toBeDefined();
  });

  test("already-compacted replay changes nothing and remains pending", async () => {
    const output = {
      messages: [
        makeMsg("compaction-hist-replay", "user", `${COMPACTION_MARKER} already done`),
        makeMsg("tail", "assistant", "tail"),
      ],
    };
    const before = structuredClone(output.messages);
    setPendingPlan("sess-1", {
      refs: [],
      summary: "Summary",
      replacedMessageIds: ["old-1", "old-2"],
      historyHash: "hist-replay",
    });

    await handleMessagesTransform(output, "sess-1");

    expect(output.messages).toEqual(before);
    expect(getPendingPlan("sess-1")).toBeDefined();
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

  test("cross-session safety: a foreign session's transform retains this plan (no unconditional delete)", async () => {
    // The transform hook receives no sessionID upstream, so the factory
    // iterates every pending plan. Session B's transform must apply B's plan
    // (ids match) while RETAINING session A's plan (no ids match), which A's
    // own transform applies later.
    const outputB = {
      messages: [makeMsg("b-msg-1", "user", "B question"), makeMsg("b-msg-2", "assistant", "B answer")],
    };
    setPendingPlan("sess-a", {
      refs: [],
      summary: "A summary",
      replacedMessageIds: ["a-msg-1", "a-msg-2"],
      historyHash: "hash-a",
    });
    setPendingPlan("sess-b", {
      refs: [],
      summary: "B summary",
      replacedMessageIds: ["b-msg-1", "b-msg-2"],
      historyHash: "hash-b",
    });

    await handleMessagesTransform(outputB, "sess-b");

    // B applied...
    expect(outputB.messages.length).toBe(1);
    // ...A retained (would have been destroyed by an unconditional delete).
    const pendingA = getPendingPlan("sess-a");
    if (pendingA === undefined || pendingA instanceof Map) {
      throw new Error("sess-a plan was wrongly consumed by sess-b's transform");
    }
    expect(pendingA.plan.historyHash).toBe("hash-a");

    // A's own transform still applies it.
    const outputA = {
      messages: [makeMsg("a-msg-1", "user", "A question"), makeMsg("a-msg-2", "assistant", "A answer")],
    };
    await handleMessagesTransform(outputA, "sess-a");
    expect(outputA.messages.length).toBe(1);
  });

  test("waterlevel triggers even when a user message merely mentions 'compaction'", async () => {
    // Regression for over-broad free-text matching in isCompactionInProgress:
    // prose containing the word must not suppress compression.
    const sdkClient = createMockSdkClient({
      messages: [
        makeSdkMsg("msg-1", "user", "Let's discuss compaction strategies for databases"),
        makeSdkMsg("msg-2", "assistant", "Sure!", 150000), // >= 140k usable
      ],
      modelGet: { limit: { context: 200000 }, id: "claude-3", providerID: "anthropic" },
    });

    let compressCalled = false;
    mockHeadroomCompressImpl = async () => {
      compressCalled = true;
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

    await handleSessionIdle({ sessionID: "sess-free-text" }, sdkClient, defaultOptions);

    expect(compressCalled).toBe(true);
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
    expect(output.context[0]).toContain("historyHash");
    expect(output.context[0]).not.toContain("pass it as `hash`");
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
