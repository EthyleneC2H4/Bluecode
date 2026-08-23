import { describe, expect, test } from "bun:test";
import type { StrategyName } from "@bluecode/contracts";
import { classify, parseGrepLine } from "../src/classify";
import {
  DIFF_OUT,
  GO_TEST_OUT,
  GREP_OUT,
  JEST_OUT,
  LS_LA,
  NOISE,
  PATH_LIST,
  READ_OUT,
} from "./fixtures";

describe("classify — explicit tool mapping (confidence 1.0)", () => {
  test("read/grep/glob/ls map directly regardless of content", () => {
    for (const [tool, strategy] of [
      ["read", "read"],
      ["grep", "grep"],
      ["glob", "ls"],
      ["ls", "ls"],
    ] as const) {
      const c = classify(tool, NOISE);
      expect(c.strategy).toBe(strategy);
      expect(c.confidence).toBe(1);
    }
  });
});

describe("classify — feature scoring on bash output", () => {
  const cases: Array<[string, string, StrategyName]> = [
    ["git diff", DIFF_OUT, "diff"],
    ["grep hits", GREP_OUT, "grep"],
    ["ls -la", LS_LA, "ls"],
    ["path list", PATH_LIST, "ls"],
    ["jest run", JEST_OUT, "test"],
    ["go test run", GO_TEST_OUT, "test"],
    ["numbered file", READ_OUT, "read"],
  ];

  for (const [name, text, expected] of cases) {
    test(`${name} -> ${expected}`, () => {
      const c = classify("bash", text);
      expect(c.strategy).toBe(expected);
      expect(c.confidence).toBeGreaterThanOrEqual(0.6);
      expect(c.signals.length).toBeGreaterThan(0);
    });
    // Unknown tool ids take the same feature path.
    test(`${name} via unknown tool id -> ${expected}`, () => {
      expect(classify("webfetch", text).strategy).toBe(expected);
    });
  }

  test("plain prose stays unknown below the 0.6 threshold", () => {
    const c = classify("bash", NOISE);
    expect(c.strategy).toBe("unknown");
    expect(c.confidence).toBeLessThan(0.6);
  });

  test("empty output falls back to unknown", () => {
    expect(classify("bash", "").strategy).toBe("unknown");
  });

  test("second positive per family", () => {
    const diff2 = `diff --git a/x.py b/x.py
--- a/x.py
+++ b/x.py
@@ -1,1 +1,2 @@
-print("a")
+print("b")
+print("c")`;
    expect(classify("bash", diff2).strategy).toBe("diff");

    const grep2 = `lib/a.js:1:alpha
lib/a.js:2:beta
lib/b.js:7:gamma`;
    expect(classify("bash", grep2).strategy).toBe("grep");

    const read2 = `   10\tfirst
   11\tsecond
   12\tthird`;
    expect(classify("bash", read2).strategy).toBe("read");

    const test2 = `✓ parses json
✓ rejects bad json
Tests: 2 passed, 2 total`;
    expect(classify("bash", test2).strategy).toBe("test");
  });
});

describe("parseGrepLine tolerance", () => {
  test("colon and dash separators, optional content", () => {
    expect(parseGrepLine("src/a.ts:12:x")).toEqual({ path: "src/a.ts", lineNo: 12, text: "x" });
    expect(parseGrepLine("src/a.ts-12-x")).toEqual({ path: "src/a.ts", lineNo: 12, text: "x" });
    expect(parseGrepLine("src/a.ts:12")).toEqual({ path: "src/a.ts", lineNo: 12, text: "" });
  });

  test("rejects non-path shapes", () => {
    expect(parseGrepLine("just some words here")).toBeNull();
    expect(parseGrepLine("https://example.com:8080/x")).toBeNull();
    expect(parseGrepLine("no digits after colon: x")).toBeNull();
  });
});
