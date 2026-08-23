import { describe, expect, test } from "bun:test";
import { newRequestId } from "../src/ids";

describe("ids", () => {
  test("1000 generated ids are all unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(newRequestId());
    }
    expect(seen.size).toBe(1000);
  });

  test("format is <prefix>_<counter>_<random hex suffix>", () => {
    const id = newRequestId();
    expect(id).toMatch(/^r_\d+_[0-9a-f]{8}$/);
    const custom = newRequestId("req");
    expect(custom.startsWith("req_")).toBe(true);
  });

  test("monotonic counter guarantees uniqueness even with equal random draws", () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).not.toBe(b);
    const numA = Number(a.split("_")[1]);
    const numB = Number(b.split("_")[1]);
    expect(numB).toBe(numA + 1);
  });
});
