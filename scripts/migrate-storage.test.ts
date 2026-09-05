import { expect, test } from "bun:test"
import { parseMigrationArgs } from "./migrate-storage"

test("migration requires explicit offline ownership and validates payload allowance", () => {
  expect(() => parseMigrationArgs(["--projectId", "p"])).toThrow(/offline/)
  expect(() => parseMigrationArgs(["--offline"])).toThrow(/projectId/)
  expect(() =>
    parseMigrationArgs(["--offline", "--projectId", "p", "--maxStorageBytes", "NaN"])
  ).toThrow(/Invalid/)
  expect(
    parseMigrationArgs([
      "--offline",
      "--projectId",
      "p",
      "--legacyDataDir",
      "/old",
      "--dataDir",
      "/new",
    ]).legacyDataDir
  ).toBe("/old")
})
