import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

test("the real factory cold-starts headroom in its configured root without global environment", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "blue-factory-live-"))
  const env = { ...process.env }
  delete env.BLUECODE_DATA_DIR
  delete env.BLUECODE_TEST
  delete env.BLUECODE_TEST_DELAY_MS
  const program = `
    import plugin from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).pathname)}
    import { HeadroomClient } from "@bluecode/headroomd/client"
    import { storageLayout } from "@bluecode/shared"
    const dataDir = ${JSON.stringify(dataDir)}
    const layout = storageLayout(dataDir)
    const hooks = await plugin({
      project: { id: "factory-project" }, directory: dataDir, worktree: dataDir,
      client: {}, serverUrl: new URL("http://localhost"), $: {}
    }, { dataDir, rtk: { mode: "off" }, headroom: { idleExitMs: 50 } })
    let client
    try {
      client = await HeadroomClient.connect({ dataDir, socketPath: layout.socket })
      const health = await client.health()
      if (!health.pid || !(await Bun.file(layout.headroom + "/meta.db").exists()))
        throw new Error("Factory did not start the configured durable store")
      if (process.env.BLUECODE_DATA_DIR !== undefined)
        throw new Error("Factory changed global environment")
    } finally {
      await client?.close()
      await hooks.dispose?.()
    }
  `
  const child = Bun.spawn([process.execPath, "-e", program], {
    cwd: new URL("..", import.meta.url).pathname,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect({ exitCode, error: exitCode ? stderr : "" }).toEqual({ exitCode: 0, error: "" })
  } finally {
    // Only this unique test root's daemon can be stopped; await actual exit,
    // because socket removal precedes DB shutdown.
    const pid = Number(await readFile(join(dataDir, "headroomd.pid"), "utf8").catch(() => ""))
    if (pid > 0) {
      try {
        process.kill(pid, "SIGTERM")
      } catch {}
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(pid, 0)
        } catch {
          break
        }
        await Bun.sleep(10)
      }
    }
    await rm(dataDir, { recursive: true, force: true })
  }
}, 10000)
