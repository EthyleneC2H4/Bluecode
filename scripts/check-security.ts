/** Isolated functional gate; no tracked artifact mutation or external model. */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../packages/eval/src/security-cli"
const directory = await mkdtemp(join(tmpdir(), "bluecode-security-gate-"))
try {
  process.exitCode = await main(["--output", process.env.SECURITY_REPORT_PATH ?? join(directory, "report.json")])
} finally { await rm(directory, { recursive: true, force: true }) }
