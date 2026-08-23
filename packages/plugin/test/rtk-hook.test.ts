import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  handleToolExecuteAfter,
  shutdownRtk,
  resetRtkState,
} from "../src/rtk-hook";
import { parseOptions } from "../src/config";

// Mock RtkClient
const mockCompress = async (input: any) => {
  // This will be replaced per test
  return mockCompressImpl(input);
};

let mockCompressImpl: (input: any) => Promise<any> = async (input: any) => ({
  kind: "passthrough",
  output: input.output,
  degraded: null,
});

// Mock the RtkClient module
import * as rtkModule from "@bluecode/rtk";
const originalCreate = rtkModule.RtkClient.create;

beforeEach(() => {
  resetRtkState();
  // Mock RtkClient.create to return our mock
  (rtkModule.RtkClient as any).create = async () => ({
    compress: mockCompress,
    shutdown: async () => {},
  });
});

afterEach(async () => {
  (rtkModule.RtkClient as any).create = originalCreate;
  await shutdownRtk();
});

const defaultOptions = parseOptions({});

describe("rtk-hook: handleToolExecuteAfter", () => {
  test("compressed path: mutates output.output and writes metadata.bluecode", async () => {
    mockCompressImpl = async () => ({
      kind: "compressed",
      result: {
        output: "compressed output",
        rawHash: "sha256:abc123",
        strategy: "ls",
        compressed: true,
        truncated: false,
        rawTokensEst: 1000,
        outTokensEst: 200,
        degraded: null,
      },
    });

    const input = { tool: "ls", sessionID: "sess-1", callID: "call-1", args: {} };
    const output: { title: string; output: unknown; metadata: Record<string, unknown> | undefined } = { title: "List", output: "original output", metadata: undefined };

    await handleToolExecuteAfter(input, output, defaultOptions);

    expect(output.output).toBe("compressed output");
    expect(output.metadata).toBeDefined();
    expect(output.metadata!.bluecode).toEqual({
      rawHash: "sha256:abc123",
      strategy: "ls",
      compressed: true,
      outTokensEst: 200,
      rawTokensEst: 1000,
    });
  });

  test("passthrough with degraded: writes metadata.bluecode.degraded", async () => {
    mockCompressImpl = async () => ({
      kind: "passthrough",
      output: "original output",
      degraded: "timeout",
    });

    const input = { tool: "grep", sessionID: "sess-1", callID: "call-1", args: {} };
    const output: { title: string; output: unknown; metadata: Record<string, unknown> | undefined } = { title: "Grep", output: "original output", metadata: undefined };

    await handleToolExecuteAfter(input, output, defaultOptions);

    expect(output.output).toBe("original output"); // Unchanged
    expect(output.metadata).toBeDefined();
    expect(output.metadata!.bluecode).toEqual({ degraded: "timeout" });
  });

  test("fast path (passthrough, degraded=null): leaves output untouched, no metadata", async () => {
    mockCompressImpl = async () => ({
      kind: "passthrough",
      output: "tiny output",
      degraded: null,
    });

    const input = { tool: "read", sessionID: "sess-1", callID: "call-1", args: {} };
    const output: { title: string; output: unknown; metadata: Record<string, unknown> | undefined } = { title: "Read", output: "tiny output", metadata: undefined };

    await handleToolExecuteAfter(input, output, defaultOptions);

    expect(output.output).toBe("tiny output");
    expect(output.metadata).toBeUndefined();
  });

  test("non-string output: returns early without processing", async () => {
    mockCompressImpl = async () => {
      throw new Error("should not be called");
    };

    const input = { tool: "ls", sessionID: "sess-1", callID: "call-1", args: {} };
    const output: { title: string; output: unknown; metadata: Record<string, unknown> | undefined } = { title: "List", output: { some: "object" }, metadata: undefined };

    await handleToolExecuteAfter(input, output, defaultOptions);

    expect(output.output).toEqual({ some: "object" });
    expect(output.metadata).toBeUndefined();
  });

  test("disabled plugin: returns early without processing", async () => {
    mockCompressImpl = async () => {
      throw new Error("should not be called");
    };

    const input = { tool: "ls", sessionID: "sess-1", callID: "call-1", args: {} };
    const output: { title: string; output: unknown; metadata: Record<string, unknown> | undefined } = { title: "List", output: "output", metadata: undefined };
    const disabledOptions = parseOptions({ enabled: false });

    await handleToolExecuteAfter(input, output, disabledOptions);

    expect(output.output).toBe("output");
    expect(output.metadata).toBeUndefined();
  });

  test("client creation failure: degrades gracefully, no throw", async () => {
    (rtkModule.RtkClient as any).create = async () => {
      throw new Error("spawn failed");
    };
    resetRtkState(); // Reset so it tries to create again

    const input = { tool: "ls", sessionID: "sess-1", callID: "call-1", args: {} };
    const output: { title: string; output: unknown; metadata: Record<string, unknown> | undefined } = { title: "List", output: "output", metadata: undefined };

    // Should not throw
    await handleToolExecuteAfter(input, output, defaultOptions);

    expect(output.output).toBe("output"); // Passthrough
    expect(output.metadata).toBeUndefined();
  });

  test("compress throws: error is swallowed, output unchanged", async () => {
    mockCompressImpl = async () => {
      throw new Error("compress failed");
    };

    const input = { tool: "ls", sessionID: "sess-1", callID: "call-1", args: {} };
    const output: { title: string; output: unknown; metadata: Record<string, unknown> | undefined } = { title: "List", output: "output", metadata: undefined };

    // Should not throw
    await handleToolExecuteAfter(input, output, defaultOptions);

    expect(output.output).toBe("output");
    expect(output.metadata).toBeUndefined();
  });

  test("metadata already exists: extends it with bluecode", async () => {
    mockCompressImpl = async () => ({
      kind: "compressed",
      result: {
        output: "compressed",
        rawHash: "sha256:hash",
        strategy: "unknown",
        compressed: true,
        truncated: false,
        rawTokensEst: 500,
        outTokensEst: 100,
        degraded: null,
      },
    });

    const input = { tool: "test", sessionID: "sess-1", callID: "call-1", args: {} };
    const output: { title: string; output: unknown; metadata: Record<string, unknown> | undefined } = { title: "Test", output: "output", metadata: { existing: "value" } };

    await handleToolExecuteAfter(input, output, defaultOptions);

    expect(output.metadata).toEqual({
      existing: "value",
      bluecode: {
        rawHash: "sha256:hash",
        strategy: "unknown",
        compressed: true,
        outTokensEst: 100,
        rawTokensEst: 500,
      },
    });
  });
});