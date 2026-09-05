import { describe, expect, test, afterEach } from "bun:test"
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { objectPath, readObject, sha256Hex, writeObject } from "../src/cas"

const dirs: string[] = []

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bluecode-cas-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

/** Recursively list all regular files under dir (relative paths). */
async function walkFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(join(dir, entry.name), rel)))
    } else if (entry.isFile()) {
      out.push(rel)
    }
  }
  return out
}

describe("cas", () => {
  test("sha256Hex matches an independent implementation", async () => {
    const hex = await sha256Hex("hello 世界")
    const expected = new Bun.CryptoHasher("sha256").update("hello 世界").digest("hex")
    expect(hex).toBe(expected)
    expect(hex).toMatch(/^[0-9a-f]{64}$/)
    const bytes = new Uint8Array([0, 1, 2, 254, 255])
    expect(await sha256Hex(bytes)).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"))
  })

  test("string and Uint8Array round-trip", async () => {
    const dataDir = await makeDataDir()
    const content = "工具输出 compression test\nwith lines\n"
    const res = await writeObject(dataDir, content)
    expect(res.existed).toBe(false)
    expect(res.size).toBe(new TextEncoder().encode(content).byteLength)
    expect(res.hash).toBe(await sha256Hex(content))

    const back = await readObject(dataDir, res.hash)
    expect(back).not.toBeNull()
    expect(new TextDecoder().decode(back ?? new Uint8Array())).toBe(content)

    // binary round-trip
    const bin = new Uint8Array([0, 1, 2, 250, 251, 255])
    const binRes = await writeObject(dataDir, bin)
    expect(await readObject(dataDir, binRes.hash)).toEqual(bin)
  })

  test("objectPath buckets by first two hex chars", () => {
    const hash = `${"ab".repeat(32)}`
    expect(objectPath("/data", hash)).toBe(`/data/objects/${hash.slice(0, 2)}/${hash}`)
  })

  test("invalid hash format is rejected", async () => {
    const dataDir = await makeDataDir()
    expect(() => objectPath(dataDir, "NOTAHASH")).toThrow()
    expect(() => objectPath(dataDir, `${"A".repeat(64)}`)).toThrow() // uppercase
    expect(() => objectPath(dataDir, `${"a".repeat(63)}`)).toThrow() // too short
    await expect(readObject(dataDir, "deadbeef")).rejects.toThrow()
  })

  test("readObject returns null for a well-formed but absent hash", async () => {
    const dataDir = await makeDataDir()
    expect(await readObject(dataDir, "a".repeat(64))).toBeNull()
  })

  test("dedup: second write reports existed=true and stores one copy", async () => {
    const dataDir = await makeDataDir()
    const first = await writeObject(dataDir, "same content")
    const second = await writeObject(dataDir, "same content")
    expect(first.existed).toBe(false)
    expect(second.existed).toBe(true)
    expect(second.hash).toBe(first.hash)
    expect(second.size).toBe(first.size)
    expect(await walkFiles(dataDir)).toEqual([`objects/${first.hash.slice(0, 2)}/${first.hash}`])
  })

  test("concurrency: 20 writers of identical content all resolve, exactly one existed=false", async () => {
    const dataDir = await makeDataDir()
    const content = "concurrent dedup payload — 并发去重".repeat(50)
    const results = await Promise.all(
      Array.from({ length: 20 }, () => writeObject(dataDir, content))
    )
    const hashes = new Set(results.map((r) => r.hash))
    expect(hashes.size).toBe(1)
    expect(results.filter((r) => !r.existed)).toHaveLength(1)
    expect(results.filter((r) => r.existed)).toHaveLength(19)
    for (const r of results) expect(r.size).toBe(new TextEncoder().encode(content).byteLength)
    // exactly one object on disk, no temp leftovers
    const files = await walkFiles(dataDir)
    expect(files).toHaveLength(1)
    const hash = results[0]?.hash ?? ""
    expect(files[0]).toBe(`objects/${hash.slice(0, 2)}/${hash}`)
    expect(new TextDecoder().decode((await readObject(dataDir, hash)) ?? new Uint8Array())).toBe(
      content
    )
  })

  test("corruption: tampered object is detected on read", async () => {
    const dataDir = await makeDataDir()
    const res = await writeObject(dataDir, "original content")
    const path = objectPath(dataDir, res.hash)
    await writeFile(path, "tampered!!")
    await expect(readObject(dataDir, res.hash)).rejects.toThrow(/corruption/)
  })

  test("corruption: dedup write over a tampered object throws on size mismatch", async () => {
    const dataDir = await makeDataDir()
    const res = await writeObject(dataDir, "original")
    const path = objectPath(dataDir, res.hash)
    await writeFile(path, "xx") // different length
    expect((await stat(path)).size).toBe(2)
    await expect(writeObject(dataDir, "original")).rejects.toThrow(/corruption/)
  })
})

test("dedup rejects same-size corrupt canonical and logical objects", async () => {
  const { writeObjectAs } = await import("../src/cas")
  const dir = await makeDataDir()
  const stored = await writeObject(dir, "original")
  await writeFile(objectPath(dir, stored.hash), "tampered")
  await expect(writeObject(dir, "original")).rejects.toThrow(/corruption/)
  await expect(writeObjectAs(dir, stored.hash, "original")).rejects.toThrow(/corruption/)
})

test("verified warm dedup does not modify object-directory timestamps", async () => {
  const { writeObjectAs } = await import("../src/cas")
  const dir = await makeDataDir()
  const first = await writeObject(dir, "stable replay")
  const bucket = objectPath(dir, first.hash).slice(0, -65)
  const before = (await stat(bucket)).mtimeMs
  await Bun.sleep(10)
  await writeObject(dir, "stable replay")
  await writeObjectAs(dir, first.hash, "stable replay")
  expect((await stat(bucket)).mtimeMs).toBe(before)
})
