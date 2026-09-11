/** Each command owns a POSIX process group; never signal another evaluation's group. */
import { spawn, spawnSync } from "node:child_process"
export interface CommandResult { code: number; stdout: string; stderr: string; timedOut: boolean; aborted: boolean; outputTruncated: boolean }
export async function command(argv: string[], cwd: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
  if (process.platform === "win32") throw new Error("Live evaluation requires POSIX process groups")
  if (signal?.aborted) return { code: -1, stdout: "", stderr: "", timedOut: false, aborted: true, outputTruncated: false }
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  const group = child.pid
  let cleanupError: Error | undefined
  const kill = (kind: NodeJS.Signals) => {
    if (!group) return
    // Bun on macOS can report EPERM for a vanished negative PID; use the
    // native group signal command and distinguish a disappeared group.
    const result = spawnSync("/bin/kill", ["-" + kind.replace(/^SIG/, ""), "--", String(-group)], { encoding: "utf8", timeout: 1000, env: { ...process.env, LC_ALL: "C" } })
    if (result.status !== 0 && !/No such process/i.test(result.stderr ?? "")) {
      const members = spawnSync("/bin/ps", ["-axo", "pgid=,stat="], { encoding: "utf8", timeout: 1000 })
      const live = members.stdout?.split("\n").some(line => { const [pgid, state] = line.trim().split(/\s+/); return Number(pgid) === group && !state?.startsWith("Z") })
      if (members.status !== 0 || live) cleanupError = new Error("Unable to terminate owned command group")
    }
  }
  let stdout = "", stderr = "", timedOut = false, aborted = false, outputTruncated = false
  const cap = 8 * 1024 * 1024
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8")
  child.stdout.on("data", (text: string) => { outputTruncated ||= stdout.length + text.length > cap; stdout = (stdout + text).slice(0, cap) })
  child.stderr.on("data", (text: string) => { outputTruncated ||= stderr.length + text.length > cap; stderr = (stderr + text).slice(0, cap) })
  let settle!: (code: number) => void
  const exited = new Promise<number>(resolve => { settle = resolve; child.once("exit", code => resolve(code ?? -1)); child.once("error", () => resolve(-1)) })
  const stop = () => { aborted = true; kill("SIGTERM"); settle(-1) }
  signal?.addEventListener("abort", stop, { once: true })
  const deadline = setTimeout(() => { timedOut = true; kill("SIGTERM"); settle(-1) }, timeoutMs)
  // Exit and stream lifetimes differ: descendants can inherit pipes after the
  // leader exits. Always close the entire owned group, then bound pipe drainage.
  try {
    const code = await exited
    clearTimeout(deadline)
    kill("SIGTERM")
    await new Promise(resolve => setTimeout(resolve, 60))
    kill("SIGKILL")
    await Promise.race([
      Promise.all([child.stdout, child.stderr].map(stream => stream.readableEnded || stream.destroyed ? Promise.resolve() : new Promise<void>(resolve => { stream.once("end", resolve); stream.once("close", resolve) }))),
      new Promise(resolve => setTimeout(resolve, 100)),
    ])
    return { code, stdout, stderr, timedOut, aborted, outputTruncated }
  } finally {
    clearTimeout(deadline); signal?.removeEventListener("abort", stop)
    kill("SIGKILL"); child.stdout.destroy(); child.stderr.destroy()
    if (cleanupError) throw cleanupError
  }
}
export function createCommandScope() {
  const controller = new AbortController(), pending = new Set<Promise<CommandResult>>()
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    command(argv: string[], cwd: string, env: Record<string, string>, timeoutMs: number) {
      const result = command(argv, cwd, env, timeoutMs, controller.signal)
      pending.add(result); void result.then(() => pending.delete(result), () => pending.delete(result))
      return result
    },
    async close() { controller.abort(); await Promise.allSettled([...pending]) },
  }
}
export type Command = typeof command
