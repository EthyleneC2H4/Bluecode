import { describe, expect, test } from "bun:test";
import { composeRedactors, noopRedactor } from "../src/redact";

describe("redact", () => {
  test("noopRedactor is identity", () => {
    for (const text of ["", "plain", "\x1b[31mansi\x1b[0m 中文 \n\t"]) {
      expect(noopRedactor(text)).toBe(text);
    }
  });

  test("compose applies redactors left to right", () => {
    const f = (t: string) => `${t}[F]`;
    const g = (t: string) => `${t}[G]`;
    expect(composeRedactors(f, g)("x")).toBe("x[F][G]");
    expect(composeRedactors(g, f)("x")).toBe("x[G][F]");
  });

  test("compose with zero or one function behaves sanely", () => {
    expect(composeRedactors()("unchanged")).toBe("unchanged");
    const f = (t: string) => t.toUpperCase();
    expect(composeRedactors(f)("abc")).toBe("ABC");
  });

  test("compose chains real redaction semantics in order", () => {
    const dropSecrets = (t: string) => t.replaceAll("hunter2", "[REDACTED]");
    const trimTail = (t: string) => t.replace(/\s+$/, "");
    expect(composeRedactors(dropSecrets, trimTail)("pw=hunter2   \n")).toBe("pw=[REDACTED]");
  });
});
