import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { headroomRetrieveTool } from "../src/retrieve-tool";
import { setSharedHeadroomClient } from "../src/headroom";
import { parseOptions } from "../src/config";
import type { ToolContext } from "../src/tool";
import { z } from "zod";

// Mock HeadroomClient
const mockRetrieve = async (params: any) => {
  return mockRetrieveImpl(params);
};

let mockRetrieveImpl: (params: any) => Promise<any> = async () => ({ found: false });

import * as headroomModule from "@bluecode/headroomd";
const originalHeadroomConnect = headroomModule.HeadroomClient.connect;

// Mock tool context (shape per src/tool.ts ToolContext)
const mockContext: ToolContext = {
  sessionID: "sess-1",
  messageID: "msg-1",
  agent: "test-agent",
  directory: "/test",
  worktree: "/test",
  abort: new AbortController().signal,
  metadata: (_input) => {},
  ask: async (_input) => {},
};

beforeEach(() => {
  setSharedHeadroomClient({
    retrieve: mockRetrieve,
    close: async () => {},
    compress: async () => ({ compacted: false }),
    health: async () => ({ ok: true, pid: 123, uptimeMs: 1000, sessions: 0 }),
  } as any);
});

afterEach(() => {
  setSharedHeadroomClient(null);
});

describe("headroom_retrieve tool", () => {
  test("hash retrieval: found returns full content", async () => {
    mockRetrieveImpl = async () => ({
      found: true,
      content: "This is the original conversation content",
    });

    const result = await headroomRetrieveTool.execute({
      hash: "a".repeat(64),
      limit: 5,
    }, mockContext);

    expect(result).toContain("Historical content retrieved");
    expect(result).toContain("This is the original conversation content");
    expect(result).toContain("a".repeat(64));
  });

  test("hash retrieval: not found returns friendly message", async () => {
    // Contract-faithful miss shape: {found:false} carries NO content field
    // (discriminated union). The old mock added content:"", masking a guard
    // bug where misses fell through to "Unexpected result format".
    mockRetrieveImpl = async () => ({ found: false });

    const result = await headroomRetrieveTool.execute({
      hash: "b".repeat(64),
    }, mockContext);

    expect(result).toContain("No content found");
    expect(result).toContain("b".repeat(64));
  });

  test("query retrieval: returns formatted hits", async () => {
    mockRetrieveImpl = async () => ({
      hits: [
        { score: 0.95, hash: "c".repeat(64), projectId: "default", sessionId: "sess-1", turnIndex: 2, role: "user", snippet: "Hello world" },
        { score: 0.87, hash: "d".repeat(64), projectId: "default", sessionId: "sess-1", turnIndex: 3, role: "assistant", snippet: "Hi there" },
      ],
    });

    const result = await headroomRetrieveTool.execute({
      query: "hello",
      limit: 5,
    }, mockContext);

    expect(result).toContain('Search results for "hello"');
    expect(result).toContain("0.950");
    expect(result).toContain("c".repeat(64));
    expect(result).toContain("Hello world");
    expect(result).toContain("0.870");
    expect(result).toContain("Hi there");
  });

  test("query retrieval: no hits returns friendly message", async () => {
    mockRetrieveImpl = async () => ({ hits: [] });

    const result = await headroomRetrieveTool.execute({
      query: "nonexistent",
    }, mockContext);

    expect(result).toContain("No matches found");
    expect(result).toContain("nonexistent");
  });

  test("client unavailable: returns error message", async () => {
    setSharedHeadroomClient(null);

    const result = await headroomRetrieveTool.execute({
      hash: "a".repeat(64),
    }, mockContext);

    expect(result).toContain("Error: headroomd client not available");
  });

  test("client error: returns error message", async () => {
    mockRetrieveImpl = async () => {
      throw new Error("connection refused");
    };

    const result = await headroomRetrieveTool.execute({
      hash: "a".repeat(64),
    }, mockContext);

    expect(result).toContain("Error retrieving history");
    expect(result).toContain("connection refused");
  });

  test("validation: hash or query required throws ZodError", async () => {
    try {
      await headroomRetrieveTool.execute({ limit: 5 }, mockContext);
      expect(false).toBe(true); // Should not reach
    } catch (err: any) {
      expect(err).toBeInstanceOf(z.ZodError);
      expect(err.errors[0].message).toContain("Either 'hash' or 'query' must be provided");
    }
  });

  test("validation: hash must be 64 hex chars throws ZodError", async () => {
    try {
      await headroomRetrieveTool.execute({ hash: "invalid" }, mockContext);
      expect(false).toBe(true);
    } catch (err: any) {
      expect(err).toBeInstanceOf(z.ZodError);
      expect(err.errors[0].message).toContain("hash must be 64 lowercase hex chars");
    }
  });

  test("default limit is 5 applied after validation", async () => {
    let capturedParams: any = null;
    mockRetrieveImpl = async (params) => {
      capturedParams = params;
      return { hits: [] };
    };

    await headroomRetrieveTool.execute({ query: "test" }, mockContext);

    expect(capturedParams).toBeDefined();
    expect(capturedParams.limit).toBe(5);
  });

  test("stringified numeric limit from LLM clients is coerced (M7 smoke)", async () => {
    let capturedParams: any = null;
    mockRetrieveImpl = async (params) => {
      capturedParams = params;
      return { hits: [] };
    };

    await headroomRetrieveTool.execute({ query: "test", limit: "2" as unknown as number }, mockContext);

    expect(capturedParams.limit).toBe(2);
  });
});