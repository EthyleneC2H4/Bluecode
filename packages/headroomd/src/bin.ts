process.stderr.on("error", () => {})
/**
 * Daemon entry point:
 *   bun run src/bin.ts --dataDir <dir> [--socketPath P] [--idleExitMs N]
 *                      [--version]
 *
 * Handwritten arg parsing (no dependency). Boot order: parse → start server
 * → print one handshake line to stdout ({"proto":3,"pid":N}) so a spawning
 * client can confirm the daemon came up → wire SIGTERM/SIGINT to a graceful
 * stop (socket + pid file removed). An already-running instance makes the
 * start yield `already-running`, which exits 0 quietly: spawn callers then
 * simply connect to the winner.
 */
import { HEADROOM_PROTOCOL_VERSION, summaryProviderSchema, type SummaryProviderConfig } from "@bluecode/contracts"
import { encodeFrame } from "@bluecode/shared"
import { startHeadroomServer } from "./server"
import { VERSION } from "./version"

interface CliArgs {
  dataDir?: string
  socketPath?: string
  maxStorageBytes?: number
  idleExitMs?: number
  version: boolean
  summarizer?: SummaryProviderConfig
}

/** Next argv item as the flag's value, or die with a usage error. */
function takeValue(argv: string[], i: number, flag: string): string {
  const value = argv[i + 1]
  if (value === undefined) {
    process.stderr.write(`[headroomd] ${flag} requires a value\n`)
    process.exit(2)
  }
  return value
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { version: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case "--dataDir":
        args.dataDir = takeValue(argv, i, arg)
        i += 1
        break
      case "--socketPath":
        args.socketPath = takeValue(argv, i, arg)
        i += 1
        break
      case "--maxStorageBytes": {
        const value = Number(takeValue(argv, i, arg))
        if (!Number.isSafeInteger(value) || value <= 0)
          throw new Error("--maxStorageBytes must be a positive integer")
        args.maxStorageBytes = value
        i++
        break
      }
      case "--idleExitMs": {
        const value = Number(takeValue(argv, i, arg))
        if (!Number.isFinite(value) || value < 0) {
          process.stderr.write(`[headroomd] --idleExitMs expects a non-negative number\n`)
          process.exit(2)
        }
        args.idleExitMs = value
        i += 1
        break
      }
      case "--summarizer":
        try { args.summarizer = summaryProviderSchema.parse(JSON.parse(takeValue(argv, i, arg))) }
        catch { throw new Error("Invalid summarizer config; use baseURL/model/apiKeyEnv, never a literal key") }
        i++
        break
      case "--version":
        args.version = true
        break
      default:
        process.stderr.write(`[headroomd] unknown or missing-value argument: ${arg ?? "(end)"}\n`)
        process.stderr.write(
          "usage: bun run src/bin.ts --dataDir <dir> [--socketPath P] [--idleExitMs N] [--version]\n"
        )
        process.exit(2)
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

if (args.version) {
  process.stdout.write(`${VERSION}\n`)
  process.exit(0)
}

// The plugin explicitly forwards --dataDir and socket/idle options. The
// environment remains a direct CLI compatibility fallback only.
const dataDir = args.dataDir ?? process.env.BLUECODE_DATA_DIR
if (dataDir === undefined || dataDir.length === 0) {
  process.stderr.write("[headroomd] --dataDir (or BLUECODE_DATA_DIR) is required\n")
  process.exit(2)
}

const started = await startHeadroomServer({
  dataDir,
  ...(args.summarizer ? { summarizer: args.summarizer } : {}),
  ...(args.maxStorageBytes !== undefined ? { maxStorageBytes: args.maxStorageBytes } : {}),
  // exactOptionalPropertyTypes: absent flags stay absent rather than undefined.
  ...(args.socketPath !== undefined ? { socketPath: args.socketPath } : {}),
  ...(args.idleExitMs !== undefined ? { idleExitMs: args.idleExitMs } : {}),
  testMode: process.env.BLUECODE_TEST === "1",
  responseDelayMs: process.env.BLUECODE_TEST_DELAY_MS
    ? Number(process.env.BLUECODE_TEST_DELAY_MS)
    : 0,
})

if (started.status === "already-running") {
  process.stdout.write(
    encodeFrame({
      proto: HEADROOM_PROTOCOL_VERSION,
      pid: process.pid,
      status: "already-running",
      socketPath: started.socketPath,
    })
  )
  process.exit(0)
}

// Spawn-side boot validation: exactly one handshake line, protocol frames
// never appear on stdout again.
process.stdout.write(encodeFrame({ proto: HEADROOM_PROTOCOL_VERSION, pid: started.pid }))

process.on("SIGTERM", () => started.stop())
process.on("SIGINT", () => started.stop())

process.stderr.write(`[headroomd] serving at ${started.socketPath} (pid ${started.pid})\n`)
await started.done
