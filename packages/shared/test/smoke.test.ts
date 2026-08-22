import { describe, expect, test } from "bun:test";
import { VERSION } from "../src/index";

describe("@bluecode/shared", () => {
  test("scaffold placeholder exposes its version", () => {
    expect(VERSION).toBe("0.0.1");
  });
});
