/** Import-safe offline runner. Performance is opt-in and never a shared-CI gate. */
import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { runSecurityPerformance, runSecurityQuality, runSecurityTextGroup, securityEnvironment } from "./security-eval"

export function parseSecurityOptions(args: string[]) {
  const options = { performance: false, samples: 32, output: fileURLToPath(new URL("../security-results.json", import.meta.url)), phase: "reproduction" }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--performance") options.performance = true
    else if (["--output", "--phase", "--samples"].includes(arg)) {
      const value = args[++i]
      if (!value || value.startsWith("--")) throw new Error(`Missing ${arg} value`)
      if (arg === "--output") options.output = resolve(value)
      if (arg === "--phase") { if (!["first-pass", "retest", "reproduction"].includes(value)) throw new Error("Unknown phase"); options.phase = value }
      if (arg === "--samples") { options.samples = Number(value); if (!Number.isSafeInteger(options.samples) || options.samples < 20) throw new Error("Use at least 20 performance samples") }
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}
export async function main(args = process.argv.slice(2)) {
  const options = parseSecurityOptions(args)
  const previousFile = Bun.file(options.output)
  const previous = await previousFile.exists() ? await previousFile.json() as { schemaVersion?: number; runs?: unknown[] } : undefined
  if (previous && (previous.schemaVersion !== 1 || !Array.isArray(previous.runs))) throw new Error("Refusing to overwrite an unrelated result artifact")
  const meta = await securityEnvironment(["bun", "packages/eval/src/security-cli.ts", ...args])
  const quality = await runSecurityQuality()
  const textSecurityOn = await runSecurityTextGroup()
  const run = { phase: options.phase, meta, quality, textSecurityOn,
    performance: options.performance ? await runSecurityPerformance(options.samples) : null,
    qualityPassed: quality.development160.passed && quality.acceptance320.passed && textSecurityOn.healthy.passed && textSecurityOn.unavailable.passed }
  const finalEnvironment = await securityEnvironment(meta.command)
  const provenance = { sourceDigestsAtCompletion: finalEnvironment.sourceDigests, implementationStableDuringRun: JSON.stringify(meta.sourceDigests) === JSON.stringify(finalEnvironment.sourceDigests) }
  await mkdir(dirname(options.output), { recursive: true })
  await Bun.write(options.output, JSON.stringify({ schemaVersion: 1, methodology: "Synthetic offline syntax quality. Warning is not blocking. Fixed acceptance labels, no vulnerability-prevalence or whole-SAST estimate. Prior runs retained; retests after fixes are no longer untouched held-out evidence.", runs: [...(previous?.runs ?? []), { ...run, provenance }] }, null, 2) + "\n")
  console.log(JSON.stringify({ output: options.output, phase: run.phase, qualityPassed: run.qualityPassed,
    development160: quality.development160, acceptance320: quality.acceptance320, textSecurityOn, performance: run.performance ? { singleConcurrencyTargetsPassed: run.performance.singleConcurrencyTargetsPassed, groups: run.performance.groups.length } : "not requested" }, null, 2))
  return run.qualityPassed ? 0 : 1
}
if (import.meta.main) main().then(code => { process.exitCode = code }).catch(() => { console.error("Security evaluation could not complete; no partial result claimed."); process.exitCode = 2 })
