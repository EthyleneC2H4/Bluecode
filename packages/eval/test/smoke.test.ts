import { describe, expect, test } from "bun:test";
import { VERSION } from "../src/index";

describe("@bluecode/eval", () => {
  test("scaffold placeholder exposes its version", () => {
    expect(VERSION).toBe("0.0.1");
  });
});
