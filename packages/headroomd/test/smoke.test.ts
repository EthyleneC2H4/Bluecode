import { describe, expect, test } from "bun:test";
import { VERSION } from "../src/index";

describe("@bluecode/headroomd", () => {
  test("scaffold placeholder exposes its version", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
