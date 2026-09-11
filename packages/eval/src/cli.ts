#!/usr/bin/env bun
import { validateReliability } from "./reliability"
/** CLI for full/quick evaluation, baseline refresh and regression checking. */
import path from "node:path"
import { runEvaluation, runConcurrencyBenchmarks, dispose as disposeRunner } from "./runner"
import { aggregateReport, dispose as disposeMetrics } from "./metrics"
import { writeReport, printSummary } from "./report"
import { checkBaseline } from "./check-baseline"

const DEFAULT_HEADROOM_ENTRY = path.resolve(import.meta.dir, "../../headroomd/src/bin.ts")

export interface CliOptions {
  quick: boolean
  check: boolean
  updateBaseline: boolean
  skipLatency: boolean
  benchmarks: boolean
  invariants: boolean
  help: boolean
  retrievalStrategy?: "query-only" | "eager-recovery"
  headroomStrategy?: "legacy" | "layered"
  reportPath?: string
  baselinePath?: string
}

export interface EvaluationExecution {
  quick: boolean
  action: "report" | "check" | "update-baseline" | "invariants"
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    benchmarks: false,
    invariants: false,
    quick: false,
    check: false,
    updateBaseline: false,
    skipLatency: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case "--headroom-strategy": {
        const strategy = argv[++i]
        if (strategy !== "legacy" && strategy !== "layered")
          throw new Error("--headroom-strategy requires legacy or layered")
        options.headroomStrategy = strategy
        break
      }
      case "--retrieval-strategy": {
        const strategy = argv[++i]
        if (strategy !== "query-only" && strategy !== "eager-recovery")
          throw new Error("--retrieval-strategy requires query-only or eager-recovery")
        options.retrievalStrategy = strategy
        break
      }
      case "--report-path":
      case "--baseline-path": {
        const value = argv[++i]
        if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`)
        options[arg === "--report-path" ? "reportPath" : "baselinePath"] = value
        break
      }
      case "--benchmarks":
        options.benchmarks = true
        break
      case "--invariants":
        options.invariants = true
        break
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
  if (options.invariants) return { quick: false, action: "invariants" }
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
  --retrieval-strategy  query-only (default) or eager-recovery stress scenario
  --headroom-strategy   legacy (frozen baseline default) or layered
  --benchmarks         Include real-client 1/8/32 concurrency observations
  --invariants         Run fresh full evaluation and absolute reliability targets
  --report-path PATH   Report destination (or EVAL_REPORT_PATH)
  --baseline-path PATH Baseline destination (or EVAL_BASELINE_PATH)
  --skip-latency       Skip only the relative p95 latency gate
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
      ...(options.retrievalStrategy ? { retrievalStrategy: options.retrievalStrategy } : {}),
      ...(options.headroomStrategy ? { headroomStrategy: options.headroomStrategy } : {}),
      headroomEntry: DEFAULT_HEADROOM_ENTRY,
    })
    const report = aggregateReport(
      runnerResult.perFixture,
      runnerResult.latencies,
      runnerResult.recallResults
    )
    if (options.benchmarks) report.concurrency = await runConcurrencyBenchmarks(options.headroomStrategy)
    writeReport(report, options.reportPath)
    printSummary(report)

    const reliability = validateReliability(report)
    for (const violation of reliability)
      console.error(
        `[eval] ABSOLUTE TARGET FAILED ${violation.metric} [${violation.group}]: ${violation.current} (target ${violation.target})`
      )
    if (execution.action === "invariants") return reliability.length ? 1 : 0
    if (execution.action === "check" && reliability.length) return 1

    if (execution.action === "update-baseline") {
      return checkBaseline(true, {
        skipLatency: options.skipLatency,
        ...(options.baselinePath ? { baselinePath: options.baselinePath } : {}),
        ...(options.reportPath ? { reportPath: options.reportPath } : {}),
      }).passed
        ? 0
        : 1
    }
    if (execution.action === "check") {
      return checkBaseline(false, {
        skipLatency: options.skipLatency,
        ...(options.baselinePath ? { baselinePath: options.baselinePath } : {}),
        ...(options.reportPath ? { reportPath: options.reportPath } : {}),
      }).passed
        ? 0
        : 1
    }

    const baselineCheck = checkBaseline(false, {
      skipLatency: options.skipLatency,
      ...(options.baselinePath ? { baselinePath: options.baselinePath } : {}),
      ...(options.reportPath ? { reportPath: options.reportPath } : {}),
    })
    if (!baselineCheck.passed) {
      console.error(
        "[eval] WARNING: Current results violate baseline (run with --check for a gate)"
      )
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
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[eval] FATAL: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    })
}
