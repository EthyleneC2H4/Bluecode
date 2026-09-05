import { expect, test } from "bun:test"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createEngine } from "../src/engine"
import * as migration from "../src/migration"

test("legacy RTK migration verifies originals and remaps project ownership in a retained-source copy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rtk-migrate-"))
  const engine = createEngine({ dataDir: dir })
  const original = "canonical old tool output\n".repeat(100)
  const result = await engine.compress({ tool: "unknown", output: original, sessionId: "s" })
  engine.close()
  const before = await readFile(join(dir, "rtk-meta.db"))
  try {
    const copied = await (migration as any).migrateLegacyRtk({
      dataDir: dir,
      projectId: "p",
      offline: true,
    })
    expect(await readFile(join(dir, "rtk-meta.db"))).toEqual(before)
    expect(
      (await migration.migrateLegacyRtk({ dataDir: dir, projectId: "p", offline: true })).status
    ).toBe("already-migrated")
    await expect(
      migration.migrateLegacyRtk({ dataDir: dir, projectId: "other", offline: true })
    ).rejects.toThrow(/identity|mapping|source/i)
    await expect(
      migration.migrateLegacyRtk({
        dataDir: dir,
        legacyDataDir: join(dir, "other-source"),
        projectId: "p",
        offline: true,
      })
    ).rejects.toThrow(/identity|mapping|source/i)
    const reopened = createEngine({ dataDir: copied.dataDir })
    try {
      expect(
        (await reopened.fetch({ sessionId: JSON.stringify(["p", "s"]), hash: result.rawHash }))
          .found
      ).toBe(true)
      expect(
        (await reopened.fetch({ sessionId: JSON.stringify(["other", "s"]), hash: result.rawHash }))
          .found
      ).toBe(false)
    } finally {
      reopened.close()
    }
    const legacy = (migration as any).createLegacyRtkReader({ dataDir: dir, projectId: "p" })
    try {
      expect(
        (await legacy.fetch({ sessionId: JSON.stringify(["p", "s"]), hash: result.rawHash })).found
      ).toBe(true)
    } finally {
      legacy.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
