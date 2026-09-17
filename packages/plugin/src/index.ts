/** OpenCode loads every runtime export as a factory: keep only the default export. */
import type { PluginInput, PluginOptions, Hooks } from "@opencode-ai/plugin"
import { mkdir, chmod } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { RtkClient } from "@bluecode/rtk/client"
import { HeadroomClient } from "@bluecode/headroomd/client"
import { VsecClient } from "@bluecode/vsecagent/client"
import { storageLayout, redactLocalPaths } from "@bluecode/shared"
import { parseOptions } from "./config"
import { resolveHeadroomEntry, resolveRtkEntry } from "./sidecar"
import { createPluginRuntime, type RuntimeInput } from "./runtime"
import { createRetrieveTool } from "./retrieval"
import { securityDataDir } from "./security"

export default async function bluecodePlugin(
  input: PluginInput,
  rawOptions?: PluginOptions,
  diagnostics?: Pick<RuntimeInput, "trace">
): Promise<Hooks> {
  const options = parseOptions(rawOptions ?? {})
  if (!options.enabled || options.mode === "off" && options.security.mode === "off") return { dispose: async () => {}, tool: {} }
  const layout = storageLayout(securityDataDir(options))
  const projectId =
    input.project?.id ||
    createHash("sha256")
      .update(path.resolve(input.worktree || input.directory))
      .digest("hex")
  const ports: RuntimeInput = {
    projectId,
    directory: input.directory,
    worktree: input.worktree || input.directory,
    options,
    sdk: input.client,
    rtk: null,
    headroom: null,
    security: null,
    ...diagnostics,
  }
  let closed = false,
    lastConnect = 0
  let connecting: Promise<void> | null = null
  const reconnect = () => {
    if (closed || connecting || Date.now() - lastConnect < 30_000)
      return connecting ?? Promise.resolve()
    lastConnect = Date.now()
    connecting = (async () => {
      // Divide the configured archive payload allowance between the two stores.
      const quota = Math.floor(options.maxStorageBytes / 2)
      const startRtk = async () => {
        if (ports.rtk || options.mode === "off" || options.rtk.mode === "off") return
        const entry = resolveRtkEntry(options)
        ports.rtk = await RtkClient.create({
          dataDir: layout.rtk,
          budgetTokens: options.rtk.budgetTokens,
          timeoutMs: options.rtk.timeoutMs,
          minBytes: options.rtk.minBytes,
          maxStorageBytes: quota,
          ...(entry !== undefined ? { entry } : {}),
        })
      }
      const startHeadroom = async () => {
        if (ports.headroom || options.mode === "off" || options.headroom.mode === "off") return
        // A legacy custom socket cannot prove that its daemon enforces this policy.
        const socketPath = options.security.mode === "off" ? options.headroom.socketPath ?? layout.socket : layout.socket
        await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 })
        if (socketPath === layout.socket) await chmod(layout.runtime, 0o700)
        const args = [
          "--dataDir",
          layout.root,
          "--socketPath",
          socketPath,
          "--maxStorageBytes",
          String(options.maxStorageBytes - quota),
        ]
        if (options.security.mode !== "off") args.push("--securityPolicy", JSON.stringify(options.security.policy))
        if (options.headroom.summarizer.enabled)
          args.push("--summarizer", JSON.stringify(options.headroom.summarizer))
        if (options.headroom.idleExitMs !== undefined)
          args.push("--idleExitMs", String(options.headroom.idleExitMs))
        const client = await HeadroomClient.connect({
          dataDir: layout.root,
          socketPath,
          spawn: { entry: resolveHeadroomEntry(options), cwd: process.cwd(), args },
          timeoutMs: 5000,
        })
        const call = async <T>(run: () => Promise<T>): Promise<T> => {
          try {
            return await run()
          } catch (error) {
            if (/closed|connection|socket|EPIPE|ECONN|timed out|wire schema/i.test(String(error))) {
              if (ports.headroom === adapter) ports.headroom = null
              await client.close()
            }
            throw error
          }
        }
        const adapter: NonNullable<RuntimeInput["headroom"]> = {
          compress: (params) => call(() => client.compress(params)),
          retrieve: (params) => call(() => client.retrieve(params)),
          getView: (ns) => call(() => client.getView(ns)),
          getCandidate: (params) => call(() => client.getCandidate(params)),
          setView: (ns, plan) => call(() => client.setView(ns, plan)),
          clearView: (ns) => call(() => client.clearView(ns)),
          close: () => client.close(),
        }
        ports.headroom = adapter
      }
      const startSecurity = async () => {
        if (ports.security || options.security.mode === "off") return
        ports.security = await VsecClient.create({ dataDir: path.join(layout.root, "audit"),
          timeoutMs: options.security.timeoutMs,
          ...(options.security.entry ? { entry: options.security.entry } : {}) })
      }
      const results = await Promise.allSettled([startRtk(), startHeadroom(), startSecurity()])
      for (const result of results)
        if (result.status === "rejected")
          console.warn(options.security.mode !== "off" ? "[bluecode] sidecar connection failed" : `[bluecode] sidecar connection: ${redactLocalPaths(String(result.reason))}`)
    })().finally(() => {
      connecting = null
    })
    return connecting
  }
  await reconnect()
  const runtime = createPluginRuntime(ports)
  const hooks: Hooks = {
    dispose: async () => {
      closed = true
      await connecting
      await runtime.dispose()
    },
    event: async ({ event }) => {
      void reconnect()
      await runtime.event(event as any)
    },
    "chat.message": async (event) => {
      if (event.model) runtime.observeModel(event.sessionID, event.model)
    },
    "chat.params": async (event, output) => {
      runtime.observeModel(event.sessionID, event.model, output.maxOutputTokens)
    },
    "experimental.chat.system.transform": async (event, output) => {
      await runtime.systemTransform(event.sessionID ?? "unscoped", output)
      if (event.sessionID) runtime.observeSystem(event.sessionID, event.model, output.system)
    },
    "experimental.chat.messages.transform": async (_event, output) => runtime.transform(output),
    "experimental.session.compacting": async (event, output) =>
      runtime.compacting(event.sessionID, output),
    "tool.execute.before": async (event, output) => runtime.toolBefore(event, output),
    "tool.execute.after": async (event, output) => runtime.toolAfter(event, output),
    tool: { headroom_retrieve: createRetrieveTool(runtime) },
  }
  return hooks
}
