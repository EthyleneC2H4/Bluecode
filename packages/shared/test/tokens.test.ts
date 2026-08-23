import { describe, expect, test } from "bun:test";
import { createExactTokenCounter, estimateTokens } from "../src/tokens";

describe("tokens", () => {
  test("estimateTokens is length/4 rounded up", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcde")).toBe(2); // ceil(5/4)
    expect(estimateTokens("x".repeat(4001))).toBe(1001);
  });

  test("exact counter counts o200k_base tokens deterministically", () => {
    const counter = createExactTokenCounter();
    // Measured with js-tiktoken o200k_base: "hello world" encodes to
    // ["hello", " world"] -> exactly 2 tokens.
    const first = counter.count("hello world");
    const second = counter.count("hello world");
    expect(first).toBe(2);
    expect(second).toBe(first);
    expect(counter.count("")).toBe(0);
    // non-ASCII text yields a positive count and stays deterministic
    const zh = counter.count("中文压缩测试");
    expect(zh).toBeGreaterThan(2);
    expect(counter.count("中文压缩测试")).toBe(zh);
    counter.dispose();
  });

  test("dispose invalidates the counter", () => {
    const counter = createExactTokenCounter();
    expect(counter.count("ok")).toBeGreaterThan(0);
    counter.dispose();
    expect(() => counter.count("after dispose")).toThrow(/disposed/);
  });
});
