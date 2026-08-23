#!/usr/bin/env bun
/**
 * @bluecode/eval CLI — offline deterministic evaluation harness.
 *
 * Usage:
 *   bun run src/cli.ts              # full evaluation, write report
 *   bun run src/cli.ts --quick      # reduced fixture set
 *   bun run src/cli.ts --check      # regression gate against baseline.json
 *   bun run src/cli.ts --update-baseline  # write current report as baseline
 */
import path from "node:path";
import { runEvaluation, dispose as disposeRunner } from "./runner";
import { aggregateReport, dispose as disposeMetrics } from "./metrics";
import { writeReport, printSummary, dispose as disposeReport } from "./report";
import { checkBaseline } from "./check-baseline";

// HeadroomClient only spawns a daemon when given an explicit spawn recipe
// (connect-only by design — see headroomd/src/client.ts), and the CLI has no
// operator to start one. Default to the workspace bin so `bun run eval` works
// standalone; RtkClient needs no such wiring (it resolves its own sibling bin).
const DEFAULT_HEADROOM_ENTRY = path.resolve(import.meta.dir, "../../headroomd/src/bin.ts");

interface CliOptions {
  quick: boolean;
  check: boolean;
  updateBaseline: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    quick: false,
    check: false,
    updateBaseline: false,
    help: false,
  };

  for (const arg of argv) {
    switch (arg) {
      case "--quick":
        options.quick = true;
        break;
      case "--check":
        options.check = true;
        break;
      case "--update-baseline":
        options.updateBaseline = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        options.help = true;
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`
@bluecode/eval — Offline Deterministic Evaluation Harness

Usage:
  bun run src/cli.ts [options]

Options:
  --quick              Run with reduced fixture set (faster iteration)
  --check              Run regression gate against baseline.json (exit 0 on pass)
  --update-baseline    Write current eval-report.json as baseline.json
  --help, -h           Show this help

Examples:
  bun run eval                    # Full evaluation
  bun run eval --quick            # Quick smoke test
  bun run eval --check            # CI gate
  bun run eval --update-baseline  # Freeze new baseline
`);
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return 0;
  }

  if (options.check || options.updateBaseline) {
    const result = checkBaseline(options.updateBaseline);
    disposeReport();
    disposeMetrics();
    disposeRunner();
    return result.passed ? 0 : 1;
  }

  // Full evaluation run
  // The spawned headroomd reads its data dir from this env var (the client
  // passes no CLI args — see headroomd/src/client.ts). Default mirrors the
  // runner's own fallback so a plain `bun run eval` works standalone.
  process.env.BLUECODE_DATA_DIR ??= "/tmp/bluecode-eval-headroomd";
  console.error("[eval] Starting evaluation...");

  try {
    const runnerResult = await runEvaluation({
      quick: options.quick,
      // exactOptionalPropertyTypes: absent env stays absent, not undefined.
      headroomEntry: DEFAULT_HEADROOM_ENTRY,
      ...(process.env.BLUECODE_DATA_DIR !== undefined ? { dataDir: process.env.BLUECODE_DATA_DIR } : {}),
    });
    const report = aggregateReport(runnerResult.perFixture, runnerResult.latencies, runnerResult.recallResults);
    writeReport(report);
    printSummary(report);

    // Also run baseline check if baseline exists
    const baselineCheck = checkBaseline(false);
    if (!baselineCheck.passed) {
      console.error("[eval] WARNING: Current results violate baseline (run with --check to see details)");
    }

    return 0;
  } catch (err) {
    console.error(`[eval] ERROR: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    return 1;
  } finally {
    disposeReport();
    disposeMetrics();
    disposeRunner();
  }
}

main().then(code => process.exit(code)).catch(err => {
  console.error(`[eval] FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});