import { describe, expect, test } from "bun:test";
import {
  collapseBackspaces,
  collapseCarriageReturns,
  sanitize,
  stripAnsi,
} from "../src/ansi";

describe("ansi sanitization", () => {
  test("stripAnsi removes SGR color codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m plain")).toBe("red plain");
    expect(stripAnsi("\x1b[1;32;40mbold green on black\x1b[m")).toBe("bold green on black");
  });

  test("stripAnsi removes cursor movement and clear-screen sequences", () => {
    expect(stripAnsi("\x1b[2J\x1b[Hhello")).toBe("hello");
    expect(stripAnsi("a\x1b[10;20Hb")).toBe("ab");
    expect(stripAnsi("\x1b[?25lhidden\x1b[?25hshown")).toBe("hiddenshown");
  });

  test("stripAnsi removes OSC sequences (BEL- and ST-terminated)", () => {
    expect(stripAnsi("\x1b]0;window title\x07body")).toBe("body");
    expect(stripAnsi("\x1b]8;;http://example.com\x1b\\link\x1b]8;;\x1b\\after"))
      .toBe("linkafter");
  });

  test("stripAnsi removes single-char and charset escapes", () => {
    expect(stripAnsi("\x1bcreset")).toBe("reset");
    expect(stripAnsi("\x1b7saved\x1b8restored")).toBe("savedrestored");
    expect(stripAnsi("\x1b(Bcharset")).toBe("charset");
  });

  test("collapseCarriageReturns models progress-bar overwrite", () => {
    expect(collapseCarriageReturns("50%\r100%\n")).toBe("100%\n");
    expect(collapseCarriageReturns("step 1 done\r\n50%\r75%\r100%\nend"))
      .toBe("step 1 done\n100%\nend");
    expect(collapseCarriageReturns("no returns here")).toBe("no returns here");
    // trailing CR with empty continuation falls back to the last non-empty segment
    expect(collapseCarriageReturns("keep me\r")).toBe("keep me");
  });

  test("collapseBackspaces deletes the preceding code point", () => {
    expect(collapseBackspaces("abc\b\bX")).toBe("aX");
    expect(collapseBackspaces("abcdef\b\b\b\b\b\b")).toBe("");
    expect(collapseBackspaces("\b\ba")).toBe("a"); // BS with empty stack is dropped
    expect(collapseBackspaces("👍\b!")).toBe("!"); // astral char erased whole
  });

  test("Chinese text is not damaged", () => {
    expect(sanitize("\x1b[31m错误：文件未找到\x1b[0m")).toBe("错误：文件未找到");
    expect(sanitize("下载中...\r完成！\n")).toBe("完成！\n");
    // two BS delete 度 then 进
    expect(sanitize("进度\b\b100%")).toBe("100%");
    const pure = "純中文輸入，不含任何控制序列。";
    expect(sanitize(pure)).toBe(pure);
  });

  test("sanitize composes all three passes in order", () => {
    // stripAnsi -> "ok 50%\r100%\b\b\n"; CR model replaces the whole line
    // with its last non-empty segment "100%\b\b"; BS pass leaves "10".
    expect(sanitize("\x1b[32mok\x1b[0m 50%\r100%\b\b\n")).toBe("10\n");
  });
});
