import { expect, test } from "bun:test"
import { RtkClient } from "../src/client"
import { createEngine } from "../src/engine"
import { makeDataDir, lsLaOutput } from "./helpers"
import { Database } from "bun:sqlite"
import { mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { objectPath, sha256Hex } from "@bluecode/shared"
import { openOwnershipStore } from "../src/ownership"

test("malformed replacement response cannot hold the transport forever", async () => {
  const client = new (RtkClient as any)({ timeoutMs: 20, minBytes: 0 })
  let killed = 0
  const proc = {
    stdin: { write: () => {} },
    kill: () => {
      killed++
    },
  }
  client.proc = proc
  client.ready = true
  const call = client.compress({ tool: "ls", output: lsLaOutput(30), sessionId: "s" })
  client.onFrame("malformed replacement")
  await call
  await Bun.sleep(1100)
  expect(killed).toBe(1)
  client.shuttingDown = true
})

test("independent engines share the same durable root quota", async () => {
  const dir = await makeDataDir("shared-quota")
  const text = lsLaOutput(70)
  const first = createEngine({ dataDir: dir, maxStorageBytes: Buffer.byteLength(text) + 20 })
  const second = createEngine({ dataDir: dir, maxStorageBytes: Buffer.byteLength(text) + 20 })
  try {
    const result = await first.compress({ tool: "ls", output: text, sessionId: "one" })
    expect(result.compressed).toBe(true)
    const blocked = await second.compress({
      tool: "ls",
      output: text.replace("total", "Total"),
      sessionId: "two",
    })
    expect(blocked.degraded?.reason).toBe("storage_capacity")
    expect((await second.fetch({ hash: result.rawHash, sessionId: "one" })).found).toBe(true)
  } finally {
    first.close()
    second.close()
  }
})

test("failed publication releases missing-object allowance before the next write", async () => {
  const dir = await makeDataDir("failed-reservation")
  const text = lsLaOutput(70)
  const engine = createEngine({ dataDir: dir, maxStorageBytes: Buffer.byteLength(text) + 20 })
  const hash = await sha256Hex(text)
  await mkdir(`${dir}/objects`, { recursive: true })
  await writeFile(`${dir}/objects/${hash.slice(0, 2)}`, "blocks bucket creation")
  try {
    const failed = await engine.compress({ tool: "ls", output: text, sessionId: "s" })
    expect(failed.degraded?.reason).toBe("storage_error")
    await rm(`${dir}/objects/${hash.slice(0, 2)}`)
    const next = await engine.compress({
      tool: "ls",
      output: text.replace("total", "Total"),
      sessionId: "s",
    })
    expect(next.compressed).toBe(true)
  } finally {
    engine.close()
  }
})

test("a crashed reservation is recovered while published objects still consume quota", async () => {
  const dir = await makeDataDir("crashed-reservation")
  const text = lsLaOutput(70)
  const size = Buffer.byteLength(text)
  const setup = createEngine({ dataDir: dir })
  setup.close()
  const ledger = new Database(`${dir}/rtk-meta.db`)
  ledger.query("INSERT INTO rtk_storage(hash,size) VALUES (?,?)").run("f".repeat(64), size)
  ledger.close()
  const engine = createEngine({ dataDir: dir, maxStorageBytes: size + 20 })
  try {
    const first = await engine.compress({ tool: "ls", output: text, sessionId: "s" })
    expect(first.compressed).toBe(true)
    expect(await Bun.file(objectPath(dir, first.rawHash.slice(7))).exists()).toBe(true)
    const blocked = await engine.compress({
      tool: "ls",
      output: text.replace("total", "Total"),
      sessionId: "s",
    })
    expect(blocked.degraded?.reason).toBe("storage_capacity")
  } finally {
    engine.close()
  }
})

test("recovery cannot reclaim another publisher's live reservation", async () => {
  const dir = await makeDataDir("live-reservation")
  const first = openOwnershipStore(dir),
    second = openOwnershipStore(dir)
  let release!: () => void
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const pending = first.publish(async () => {
    expect(first.reserve("a".repeat(64), 100, 100)).toBe(true)
    started()
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })
  try {
    await ready
    await expect(
      second.publish(async () => second.reserve("b".repeat(64), 100, 100))
    ).rejects.toThrow(/locked|busy/i)
    const db = new Database(`${dir}/rtk-meta.db`, { readonly: true })
    try {
      expect(
        (db.query("SELECT hash FROM rtk_storage").all() as any[]).map((row) => row.hash)
      ).toEqual(["a".repeat(64)])
    } finally {
      db.close()
    }
  } finally {
    release()
    await pending
    first.close()
    second.close()
  }
})

test("rejected initial create leaves no background restart owner", async () => {
  const dir = await makeDataDir("create-failure")
  const entry = `${dir}/fail.ts`,
    counter = `${dir}/spawns.txt`
  await writeFile(
    entry,
    `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(
      counter
    )}, "spawn\\n"); process.exit(1)`
  )
  try {
    await expect(
      RtkClient.create({ dataDir: dir, entry, maxRestartAttempts: 1, probeIntervalMs: 100 })
    ).rejects.toThrow()
    await Bun.sleep(700)
    expect((await readFile(counter, "utf8")).trim().split("\n")).toHaveLength(1)
  } finally {
    await rm(entry, { force: true })
  }
})

test("failed handshake terminates a child that ignores SIGTERM before rejecting create", async () => {
  const dir = await makeDataDir("stubborn-create")
  const entry = `${dir}/stubborn.ts`,
    pidFile = `${dir}/child.pid`
  await writeFile(
    entry,
    `import { writeFileSync } from "node:fs"; process.on("SIGTERM", () => {}); writeFileSync(${JSON.stringify(
      pidFile
    )}, String(process.pid)); process.stdout.write("invalid hello\\n"); setInterval(() => {}, 1000)`
  )
  let pid = 0
  try {
    await expect(RtkClient.create({ dataDir: dir, entry })).rejects.toThrow()
    pid = Number(await readFile(pidFile, "utf8"))
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
  } finally {
    if (pid > 0)
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    await rm(entry, { force: true })
  }
}, 10000)
