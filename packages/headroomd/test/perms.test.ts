/**
 * hardenPath: real chmod on a fresh dir succeeds; an injected throwing chmod
 * degrades to warn-and-continue (audit round 2: a bare chmodSync turned a
 * permission failure into full daemon-startup failure).
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hardenPath } from "../src/perms";

describe("hardenPath", () => {
  test("real chmod 0700 succeeds and sticks", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bluecode-hd-perms-"));
    try {
      expect(hardenPath(dir, 0o700)).toBe(true);
      const mode = (await stat(dir)).mode & 0o777;
      expect(mode).toBe(0o700);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("chmod failure warns with the errno code instead of throwing", () => {
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...parts: unknown[]) => warns.push(parts.map(String).join(" "));
    try {
      const boom = () => {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      };
      expect(hardenPath("/unwritable/target", 0o600, boom)).toBe(false);
      expect(warns.some((line) => line.includes("EACCES") && line.includes("continuing"))).toBe(
        true,
      );
    } finally {
      console.warn = originalWarn;
    }
  });
});
