/**
 * Four-group evaluation runner (A/B/C/D) with real RtkClient and HeadroomClient.
 */
import { RtkClient, type CompressInput, type CompressOutcome } from "@bluecode/rtk";
import { HeadroomClient, type HeadroomClientOptions } from "@bluecode/headroomd";
import { allFixtures, quickFixtures, fixturesToHeadroomParams, type FixtureSample } from "./fixtures";
import { evaluateRecall, buildPerFixtureRecord, type LatencySample, type RecallResult, type PerFixtureRecord } from "./metrics";
import { createExactTokenCounter, defaultSidecarDataDir } from "@bluecode/shared";
import { randomUUID } from "node:crypto";
import type { RetrieveHit, RetrieveByHashResult, HeadroomCompressParams, HeadroomRetrieveParams } from "@bluecode/contracts";

const tokenCounter = createExactTokenCounter();

export interface RunnerOptions {
  quick?: boolean;
  dataDir?: string;
  rtkEntry?: string;
  headroomEntry?: string;
  rtkBudgetTokens?: number;
  rtkTimeoutMs?: number;
  rtkMinBytes?: number;
  headroomTimeoutMs?: number;
  contextWindowTokens?: number;
}

export interface RunnerResult {
  perFixture: PerFixtureRecord[];
  latencies: LatencySample[];
  recallResults: RecallResult[];
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractToolOutput(messages: FixtureSample["messages"]): string[] {
  const outputs: string[] = [];
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.state.output) {
        outputs.push(part.state.output);
      }
    }
  }
  return outputs;
}

function extractAllText(messages: FixtureSample["messages"]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "text") {
        parts.push(part.text);
      } else if (part.type === "tool" && part.state.output) {
        parts.push(part.state.output);
      }
    }
  }
  return parts.join("\n");
}

/**
 * Recall evidence gathering. Fetch EVERY ref's content and probe one query
 * per golden fact: "retrievable from headroomd" counts as "not lost" (that
 * is the component's contract — details move out of context but stay
 * reachable), so the probe must exercise the full retrieval surface rather
 * than a single ref/fact sample.
 *
 * Runs OFF the latency clock — this is measurement overhead, not product
 * latency.
 */
async function gatherRecallEvidence(
  headroom: HeadroomClient,
  sessionId: string,
  refs: Array<{ contentHash: string }>,
  facts: string[],
): Promise<{ retrieveHits: RetrieveHit[]; fetchContent: string | null }> {
  const chunks: string[] = [];
  for (const ref of refs) {
    try {
      const byHash = await headroom.retrieve({
        namespace: { projectId: "default", sessionId },
        hash: ref.contentHash,
      }) as RetrieveByHashResult;
      if (byHash.found === true) chunks.push(byHash.content);
    } catch {
      // Unreachable ref contributes nothing to recall.
    }
  }

  const retrieveHits: RetrieveHit[] = [];
  for (const fact of facts) {
    try {
      const byQuery = await headroom.retrieve({
        namespace: { projectId: "default", sessionId },
        query: fact,
        limit: 5,
      });
      if ("hits" in byQuery) retrieveHits.push(...byQuery.hits);
    } catch {
      // Query failure counts as a miss via absence of hits.
    }
  }

  return { retrieveHits, fetchContent: chunks.length > 0 ? chunks.join("\n") : null };
}

function goldenFactsOf(fixture: FixtureSample): string[] {
  return [...fixture.goldenFacts.mustHit, ...fixture.goldenFacts.niceToHave];
}

async function runGroupA(fixtures: FixtureSample[]): Promise<{
  perFixture: PerFixtureRecord[];
  latencies: LatencySample[];
}> {
  const perFixture: PerFixtureRecord[] = [];
  const latencies: LatencySample[] = [];

  for (const fixture of fixtures) {
    const rawText = extractAllText(fixture.messages);
    const rawTokens = tokenCounter.count(rawText);
    const outputText = rawText; // Passthrough
    const outTokens = rawTokens;

    const start = performance.now();
    // Simulate minimal processing
    await sleep(1);
    const latencyMs = performance.now() - start;

    perFixture.push(buildPerFixtureRecord(fixture, "A", rawText, outputText, latencyMs, [], [], null));
    latencies.push({ group: "A", fixture: fixture.name, latencyMs });
  }

  return { perFixture, latencies };
}

async function runGroupB(fixtures: FixtureSample[], options: RunnerOptions): Promise<{
  perFixture: PerFixtureRecord[];
  latencies: LatencySample[];
  recallResults: RecallResult[];
}> {
  const rtkOptions: { entry?: string; cwd?: string; budgetTokens?: number; timeoutMs?: number; minBytes?: number; dataDir?: string; testMode?: boolean } = {
    cwd: process.cwd(),
    testMode: true,
  };
  if (options.rtkEntry) rtkOptions.entry = options.rtkEntry;
  if (options.rtkBudgetTokens) rtkOptions.budgetTokens = options.rtkBudgetTokens;
  if (options.rtkTimeoutMs) rtkOptions.timeoutMs = options.rtkTimeoutMs;
  if (options.rtkMinBytes) rtkOptions.minBytes = options.rtkMinBytes;
  if (options.dataDir) rtkOptions.dataDir = options.dataDir;
  const rtk = await RtkClient.create(rtkOptions);

  const perFixture: PerFixtureRecord[] = [];
  const latencies: LatencySample[] = [];
  const recallResults: RecallResult[] = [];

  try {
    for (const fixture of fixtures) {
      const toolOutputs = extractToolOutput(fixture.messages);
      const rawText = extractAllText(fixture.messages);
      const rawTokens = tokenCounter.count(rawText);

      let outputText = rawText;
      let degradedReason: "spawn_failed" | "timeout" | "crash" | "protocol" | "no_gain" | null = null;
      let totalOutTokens = 0;

      const start = performance.now();

      for (let i = 0; i < toolOutputs.length; i++) {
        const toolOutput = toolOutputs[i] as string;
        const toolName = fixture.messages.find((m) => m.parts.some((p) => p.type === "tool" && p.state.output === toolOutput))?.parts
          .find((p) => p.type === "tool")?.tool ?? "unknown";

        const input: CompressInput = {
          tool: toolName,
          output: toolOutput,
          sessionId: `eval-${fixture.name}`,
          callId: `call-${i}`,
        };

        const outcome: CompressOutcome = await rtk.compress(input);

        if (outcome.kind === "compressed") {
          if (toolOutput !== undefined) {
            outputText = outputText.replace(toolOutput, outcome.result.output);
          }
          totalOutTokens += outcome.result.outTokensEst;
          if (outcome.result.degraded) {
            degradedReason = outcome.result.degraded.reason;
          }
        } else {
          if (toolOutput !== undefined) {
            totalOutTokens += tokenCounter.count(toolOutput);
          }
          if (outcome.degraded) {
            degradedReason = outcome.degraded;
          }
        }
      }

      const latencyMs = performance.now() - start;
      const outTokens = totalOutTokens || rawTokens;

      // Recall is judged on the FULL post-compression context (every tool
      // output replaced) — facts living in untouched message text must count
      // as retained.
      const recall = evaluateRecall(fixture, "B", outputText, [], null);

      perFixture.push(buildPerFixtureRecord(fixture, "B", rawText, outputText, latencyMs, recall.hits, recall.misses, degradedReason));
      latencies.push({ group: "B", fixture: fixture.name, latencyMs });
      recallResults.push(recall);
    }
  } finally {
    await rtk.shutdown();
  }

  return { perFixture, latencies, recallResults };
}

async function runGroupC(fixtures: FixtureSample[], options: RunnerOptions): Promise<{
  perFixture: PerFixtureRecord[];
  latencies: LatencySample[];
  recallResults: RecallResult[];
}> {
  const dataDir = options.dataDir ?? defaultSidecarDataDir("bluecode-eval-headroomd");
  // exactOptionalPropertyTypes: absent options stay absent, not undefined.
  const headroomOptions: HeadroomClientOptions = {
    dataDir,
    ...(options.headroomTimeoutMs !== undefined ? { timeoutMs: options.headroomTimeoutMs } : {}),
    ...(options.headroomEntry !== undefined
      ? { spawn: { entry: options.headroomEntry, cwd: process.cwd() } }
      : {}),
  };
  const headroom = await HeadroomClient.connect(headroomOptions);

  const perFixture: PerFixtureRecord[] = [];
  const latencies: LatencySample[] = [];
  const recallResults: RecallResult[] = [];

  try {
    for (const fixture of fixtures) {
      const rawText = extractAllText(fixture.messages);
      const rawTokens = tokenCounter.count(rawText);

      const params = fixturesToHeadroomParams(fixture, options.contextWindowTokens);
      // Namespace per group: C runs before D against the same daemon and
      // data dir; a shared session id would have D re-compress an already
      // stored session instead of its own history.
      params.sessionId = `${params.sessionId}-c`;
      const start = performance.now();

      let compressedOutput: string = "";
      let compactedRefs: Array<{ contentHash: string }> | null = null;
      let degradedReason: "spawn_failed" | "timeout" | "crash" | "protocol" | "no_gain" | null = null;

      try {
        const result = await headroom.compress(params);
        if (result.compacted) {
          compressedOutput = result.summary ?? "";
          compactedRefs = result.refs;
        } else {
          compressedOutput = rawText;
        }
      } catch (err) {
        degradedReason = "crash";
        compressedOutput = rawText;
      }

      const latencyMs = performance.now() - start;

      // Recall probing runs off the clock — see gatherRecallEvidence.
      const evidence = compactedRefs !== null
        ? await gatherRecallEvidence(headroom, params.sessionId, compactedRefs, goldenFactsOf(fixture))
        : { retrieveHits: [] as RetrieveHit[], fetchContent: null };

      const outTokens = tokenCounter.count(compressedOutput || rawText);

      const recall = evaluateRecall(fixture, "C", compressedOutput || rawText, evidence.retrieveHits, evidence.fetchContent);

      perFixture.push(buildPerFixtureRecord(fixture, "C", rawText, compressedOutput || rawText, latencyMs, recall.hits, recall.misses, degradedReason));
      latencies.push({ group: "C", fixture: fixture.name, latencyMs });
      recallResults.push(recall);
    }
  } finally {
    await headroom.close();
  }

  return { perFixture, latencies, recallResults };
}

async function runGroupD(fixtures: FixtureSample[], options: RunnerOptions): Promise<{
  perFixture: PerFixtureRecord[];
  latencies: LatencySample[];
  recallResults: RecallResult[];
}> {
  const dataDir = options.dataDir ?? defaultSidecarDataDir("bluecode-eval-headroomd");
  // exactOptionalPropertyTypes: absent options stay absent, not undefined.
  const rtk = await RtkClient.create({
    cwd: process.cwd(),
    dataDir,
    testMode: true,
    ...(options.rtkEntry !== undefined ? { entry: options.rtkEntry } : {}),
    ...(options.rtkBudgetTokens !== undefined ? { budgetTokens: options.rtkBudgetTokens } : {}),
    ...(options.rtkTimeoutMs !== undefined ? { timeoutMs: options.rtkTimeoutMs } : {}),
    ...(options.rtkMinBytes !== undefined ? { minBytes: options.rtkMinBytes } : {}),
  });

  const headroomOptions: HeadroomClientOptions = {
    dataDir,
    ...(options.headroomTimeoutMs !== undefined ? { timeoutMs: options.headroomTimeoutMs } : {}),
    ...(options.headroomEntry !== undefined
      ? { spawn: { entry: options.headroomEntry, cwd: process.cwd() } }
      : {}),
  };
  const headroom = await HeadroomClient.connect(headroomOptions);

  const perFixture: PerFixtureRecord[] = [];
  const latencies: LatencySample[] = [];
  const recallResults: RecallResult[] = [];

  try {
    for (const fixture of fixtures) {
      const toolOutputs = extractToolOutput(fixture.messages);
      const rawText = extractAllText(fixture.messages);
      const rawTokens = tokenCounter.count(rawText);

      let outputText = rawText;
      let degradedReason: "spawn_failed" | "timeout" | "crash" | "protocol" | "no_gain" | null = null;
      let totalOutTokens = 0;

      // Stage 1: Rtk compression on tool outputs
      const rtkStart = performance.now();
      for (let i = 0; i < toolOutputs.length; i++) {
        const toolOutput = toolOutputs[i] as string;
        const toolName = fixture.messages.find((m) => m.parts.some((p) => p.type === "tool" && p.state.output === toolOutput))?.parts
          .find((p) => p.type === "tool")?.tool ?? "unknown";

        const input: CompressInput = {
          tool: toolName,
          output: toolOutput,
          sessionId: `eval-${fixture.name}`,
          callId: `call-${i}`,
        };

        const outcome: CompressOutcome = await rtk.compress(input);
        if (outcome.kind === "compressed") {
          if (toolOutput !== undefined) {
            outputText = outputText.replace(toolOutput, outcome.result.output);
          }
          totalOutTokens += outcome.result.outTokensEst;
          if (outcome.result.degraded) {
            degradedReason = outcome.result.degraded.reason;
          }
        } else {
          if (toolOutput !== undefined) {
            totalOutTokens += tokenCounter.count(toolOutput);
          }
          if (outcome.degraded) {
            degradedReason = outcome.degraded;
          }
        }
      }
      const rtkLatencyMs = performance.now() - rtkStart;

      // Stage 2: Headroom compression on full message history
      const hrStart = performance.now();
      const params = fixturesToHeadroomParams(fixture, options.contextWindowTokens);
      // Per-group namespace — see the matching note in runGroupC.
      params.sessionId = `${params.sessionId}-d`;

      // Without compaction the final context is the full rtk-processed text;
      // with compaction the summary replaces it below.
      let compressedOutput: string = outputText;
      let compactedRefs: Array<{ contentHash: string }> | null = null;

      try {
        const result = await headroom.compress(params);
        if (result.compacted) {
          compressedOutput = result.summary ?? compressedOutput;
          compactedRefs = result.refs;
        }
      } catch (err) {
        if (!degradedReason) degradedReason = "crash";
      }
      const hrLatencyMs = performance.now() - hrStart;

      // Recall probing runs off the clock — see gatherRecallEvidence.
      const evidence = compactedRefs !== null
        ? await gatherRecallEvidence(headroom, params.sessionId, compactedRefs, goldenFactsOf(fixture))
        : { retrieveHits: [] as RetrieveHit[], fetchContent: null };

      const latencyMs = rtkLatencyMs + hrLatencyMs;
      const outTokens = totalOutTokens || tokenCounter.count(compressedOutput);

      const recall = evaluateRecall(fixture, "D", compressedOutput, evidence.retrieveHits, evidence.fetchContent);

      perFixture.push(buildPerFixtureRecord(fixture, "D", rawText, compressedOutput, latencyMs, recall.hits, recall.misses, degradedReason));
      latencies.push({ group: "D", fixture: fixture.name, latencyMs });
      recallResults.push(recall);
    }
  } finally {
    await rtk.shutdown();
    await headroom.close();
  }

  return { perFixture, latencies, recallResults };
}

export async function runEvaluation(options: RunnerOptions = {}): Promise<RunnerResult> {
  const fixtures = options.quick ? quickFixtures() : allFixtures();

  console.error(`[eval] Running ${fixtures.length} fixtures in ${options.quick ? "quick" : "full"} mode`);
  console.error(`[eval] Groups: A (baseline), B (rtk), C (headroomd), D (combined)`);

  // Group A: Baseline
  console.error("[eval] Group A: baseline (passthrough)...");
  const resultA = await runGroupA(fixtures);

  // Group B: Rtk only
  console.error("[eval] Group B: rtk only...");
  const resultB = await runGroupB(fixtures, options);

  // Group C: Headroom only
  console.error("[eval] Group C: headroomd only...");
  const resultC = await runGroupC(fixtures, options);

  // Group D: Combined
  console.error("[eval] Group D: combined (rtk + headroomd)...");
  const resultD = await runGroupD(fixtures, options);

  return {
    perFixture: [...resultA.perFixture, ...resultB.perFixture, ...resultC.perFixture, ...resultD.perFixture],
    latencies: [...resultA.latencies, ...resultB.latencies, ...resultC.latencies, ...resultD.latencies],
    recallResults: [...resultB.recallResults, ...resultC.recallResults, ...resultD.recallResults],
  };
}

export function dispose(): void {
  tokenCounter.dispose();
}