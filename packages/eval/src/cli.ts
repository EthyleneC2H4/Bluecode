#!/usr/bin/env bun
/** CLI for full/quick evaluation, baseline refresh and regression checking. */
import path from "node:path"
import { runEvaluation, dispose as disposeRunner } from "./runner"
import { aggregateReport, dispose as disposeMetrics } from "./metrics"
import { writeReport, printSummary } from "./report"
import { checkBaseline } from "./check-baseline"

const DEFAULT_HEADROOM_ENTRY = path.resolve(import.meta.dir, "../../headroomd/src/bin.ts")

export interface CliOptions {
  quick: boolean
  check: boolean
  updateBaseline: boolean
  skipLatency: boolean
  help: boolean
}

export interface EvaluationExecution {
  quick: boolean
  action: "report" | "check" | "update-baseline"
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    quick: false,
    check: false,
    updateBaseline: false,
    skipLatency: false,
    help: false,
  }
  for (const arg of argv) {
    switch (arg) {
      case "--quick":
        options.quick = true
        break
      case "--check":
        options.check = true
        break
      case "--update-baseline":
        options.updateBaseline = true
        break
      case "--skip-latency":
        options.skipLatency = true
        break
      case "--help":
      case "-h":
        options.help = true
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}

/** Baseline operations always evaluate now; quick mode may never freeze a baseline. */
export function resolveExecution(options: CliOptions): EvaluationExecution {
  if (options.check && options.updateBaseline) {
    throw new Error("--check cannot be combined with --update-baseline")
  }
  if (options.updateBaseline && options.quick) {
    throw new Error("--quick cannot be combined with --update-baseline")
  }
  if (options.updateBaseline) return { quick: false, action: "update-baseline" }
  if (options.check) return { quick: false, action: "check" }
  return { quick: options.quick, action: "report" }
}

function printHelp(): void {
  console.log(`
@bluecode/eval — Offline Deterministic Evaluation Harness

Usage:
  bun run src/cli.ts [options]

Options:
  --quick              Run with reduced fixture set (faster iteration)
  --check              Run a fresh full evaluation, then compare to baseline
  --update-baseline    Run a fresh full evaluation, then update baseline
  --skip-latency       Skip only the p95 latency gate
  --help, -h           Show this help
`)
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let options: CliOptions
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`[eval] ERROR: ${(error as Error).message}`)
    return 1
  }
  if (options.help) {
    printHelp()
    return 0
  }

  let execution: EvaluationExecution
  try {
    execution = resolveExecution(options)
  } catch (error) {
    console.error(`[eval] ERROR: ${(error as Error).message}`)
    return 1
  }

  console.error("[eval] Starting evaluation...")
  try {
    const runnerResult = await runEvaluation({
      quick: execution.quick,
      headroomEntry: DEFAULT_HEADROOM_ENTRY,
    })
    const report = aggregateReport(
      runnerResult.perFixture,
      runnerResult.latencies,
      runnerResult.recallResults,
    )
    writeReport(report)
    printSummary(report)

    if (execution.action === "update-baseline") {
      return checkBaseline(true, { skipLatency: options.skipLatency }).passed ? 0 : 1
    }
    if (execution.action === "check") {
      return checkBaseline(false, { skipLatency: options.skipLatency }).passed ? 0 : 1
    }

    const baselineCheck = checkBaseline(false, { skipLatency: options.skipLatency })
    if (!baselineCheck.passed) {
      console.error("[eval] WARNING: Current results violate baseline (run with --check for a gate)")
    }
    return 0
  } catch (error) {
    console.error(`[eval] ERROR: ${error instanceof Error ? error.message : String(error)}`)
    if (error instanceof Error && error.stack) console.error(error.stack)
    return 1
  } finally {
    disposeMetrics()
    disposeRunner()
  }
}

if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`[eval] FATAL: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
