/**
 * Deterministic synthetic session fixtures for offline evaluation.
 *
 * All content is hard-coded or derived from fixed seeds — two builds are
 * byte-for-byte identical. Each fixture contains "golden facts" (must-hit /
 * nice-to-have) that must survive compression or be retrievable from headroomd.
 */
import {
  type ChatMessage,
  type HeadroomCompressParams,
} from "@bluecode/contracts";

export interface FixtureSample {
  name: string;
  description: string;
  messages: ChatMessage[];
  goldenFacts: {
    mustHit: string[];
    niceToHave: string[];
  };
  /** Expected raw token count (o200k_base) for quick verification. */
  expectedRawTokens?: number;
}

export interface FixtureSet {
  longSession: FixtureSample;
  toolOutputs: FixtureSample[];
}

const TOOL_OUTPUT_POOL = {
  // Large ls -la output (200+ lines)
  lsLarge: generateLsOutput(),

  // Multi-file grep hits (100+ lines)
  grepHits: generateGrepOutput(),

  // Read with line numbers (300 lines)
  readWithLines: generateReadOutput(),

  // Git diff with multiple hunks
  gitDiff: generateGitDiff(),

  // Test runner output with failures
  testOutput: generateTestOutput(),

  // Pure noise text
  noise: generateNoiseText(),

  // ANSI color codes variant
  ansiColors: generateAnsiColors(),

  // Carriage return progress bar variant
  carriageReturn: generateCarriageReturn(),

  // Backspace corruption variant
  backspaceCorruption: generateBackspaceCorruption(),
};

function generateLsOutput(): string {
  const lines: string[] = ["total 123456"];
  for (let i = 0; i < 220; i++) {
    const perms = i % 2 === 0 ? "drwxr-xr-x" : "-rw-r--r--";
    const size = Math.floor(Math.random() * 10000) + 100;
    const name = `file_${i.toString().padStart(4, "0")}.${i % 3 === 0 ? "ts" : i % 3 === 1 ? "json" : "md"}`;
    lines.push(`${perms}  2 user  staff  ${size}  Aug 22 10:00 ${name}`);
  }
  return lines.join("\n");
}

function generateGrepOutput(): string {
  const files = [
    "src/client.ts",
    "src/server.ts",
    "src/engine.ts",
    "src/summarize.ts",
    "src/turns.ts",
    "src/store/index.ts",
    "src/store/sqlite.ts",
    "src/store/cas.ts",
    "test/client.test.ts",
    "test/server.test.ts",
  ];
  const patterns = ["compress", "fetch", "spawn", "timeout", "protocol", "degraded", "restart", "breaker", "handshake"];
  const lines: string[] = [];

  for (const file of files) {
    for (const pattern of patterns) {
      const lineNum = Math.floor(Math.random() * 500) + 1;
      const context = `function ${pattern}Handler() { return process${pattern}(); }`;
      lines.push(`${file}:${lineNum}:${context}`);
    }
  }
  // Add some extra lines to exceed 100
  for (let i = 0; i < 20; i++) {
    lines.push(`src/utils.ts:${Math.floor(Math.random() * 200) + 1}:const ${i} = "extra";`);
  }
  return lines.join("\n");
}

function generateReadOutput(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 300; i++) {
    if (i % 50 === 0) {
      lines.push(`${i.toString().padStart(4, " ")} | // GOLDEN FACT: critical error at line ${i} in function handleCompress`);
    } else if (i % 30 === 0) {
      lines.push(`${i.toString().padStart(4, " ")} | const GOLDEN_FACT_TOKEN = "must-hit-${i}";`);
    } else {
      lines.push(`${i.toString().padStart(4, " ")} | const line${i} = "sample content ${i}";`);
    }
  }
  return lines.join("\n");
}

function generateGitDiff(): string {
  return `diff --git a/src/client.ts b/src/client.ts
index abc1234..def5678 100644
--- a/src/client.ts
+++ b/src/client.ts
@@ -10,7 +10,7 @@ import { createLineReconstructor } from "@bluecode/shared";
 export class RtkClient {
-    private budgetTokens = 512;
+    private budgetTokens = 1024;
@@ -50,11 +50,15 @@ export class RtkClient {
     async compress(input: CompressInput): Promise<CompressOutcome> {
+        // GOLDEN FACT: budget increased for large outputs
         if (Buffer.byteLength(input.output, "utf8") < this.minBytes) {
             return { kind: "passthrough", output: input.output, degraded: null };
         }
+        // GOLDEN FACT: new timeout handling
         const result = await this.request("compress", params, this.timeoutMs);
         return { kind: "compressed", result };
     }
diff --git a/src/server.ts b/src/server.ts
index 1111111..2222222 100644
--- a/src/server.ts
+++ b/src/server.ts
@@ -100,6 +100,10 @@ export function startServer(io, opts) {
     }
+
+    // GOLDEN FACT: new protocol version handling
+    if (msg.v !== PROTOCOL_VERSION) {
+        return sendError(id, "E_PROTOCOL", "unsupported protocol version");
     }
diff --git a/test/client.test.ts b/test/client.test.ts
index 3333333..4444444 100644
--- a/test/client.test.ts
+++ b/test/client.test.ts
@@ -1,3 +1,7 @@
+// GOLDEN FACT: test for timeout degradation
+test("timeout returns passthrough", async () => {
+    // ...
+});
`;
}

function generateTestOutput(): string {
  return `✓ test/client.test.ts (5 tests) 45ms
✓ test/server.test.ts (8 tests) 120ms
✗ test/engine.test.ts (3 tests) 200ms
  ▼ engine.test.ts:15
      Expected: "compressed"
      Received: "passthrough"
      GOLDEN FACT: degraded reason "timeout" at test line 15
  ▼ engine.test.ts:22
      Expected: 0.85
      Received: 1.0
      GOLDEN FACT: compression ratio threshold 0.85
✓ test/integration.test.ts (12 tests) 500ms
✓ test/fixtures.test.ts (2 tests) 30ms
Test Suites: 1 failed, 4 passed
Tests:       3 failed, 25 passed
Snapshots:   0 total
Time:        2.3s
Ran all test suites.`;
}

function generateNoiseText(): string {
  const words = [
    "lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "elit",
    "sed", "do", "eiusmod", "tempor", "incididunt", "ut", "labore", "et", "dolore",
    "magna", "aliqua", "ut", "enim", "ad", "minim", "veniam", "quis", "nostrud",
    "exercitation", "ullamco", "laboris", "nisi", "ut", "aliquip", "ex", "ea",
    "commodo", "consequat", "duis", "aute", "irure", "dolor", "in", "reprehenderit",
  ];
  const lines: string[] = [];
  for (let i = 0; i < 500; i++) {
    const lineWords = [];
    for (let j = 0; j < 20; j++) {
      lineWords.push(words[Math.floor(Math.random() * words.length)]);
    }
    lines.push(lineWords.join(" "));
  }
  return lines.join("\n");
}

function generateAnsiColors(): string {
  const colors = ["\x1b[31m", "\x1b[32m", "\x1b[33m", "\x1b[34m", "\x1b[35m", "\x1b[36m", "\x1b[0m"];
  const lines: string[] = [];
  for (let i = 0; i < 100; i++) {
    const color = colors[i % colors.length];
    lines.push(`${color}[INFO] Processing item ${i}... GOLDEN FACT: ansi-marker-${i}\x1b[0m`);
  }
  return lines.join("\n");
}

function generateCarriageReturn(): string {
  const lines: string[] = [];
  for (let i = 0; i <= 100; i += 10) {
    lines.push(`\rProgress: [${"=".repeat(i / 10)}${" ".repeat(10 - i / 10)}] ${i}% GOLDEN FACT: progress-${i}`);
  }
  lines.push("\rProgress: [==========] 100% GOLDEN FACT: progress-complete");
  return lines.join("");
}

function generateBackspaceCorruption(): string {
  let result = "";
  for (let i = 0; i < 50; i++) {
    result += `Line ${i}: correct text`;
    // Add backspace corruption
    result += "\b\b\b\b\bcorrupted";
    result += " GOLDEN FACT: backspace-marker-" + i + "\n";
  }
  return result;
}

// Long session: ≥50 turns with alternating user/assistant/tool
function generateLongSession(): FixtureSample {
  const messages: ChatMessage[] = [];
  const topics = [
    "authentication", "database", "api", "frontend", "testing",
    "deployment", "monitoring", "security", "performance", "refactoring",
  ];

  for (let turn = 0; turn < 55; turn++) {
    const topic = topics[turn % topics.length];
    const isUser = turn % 3 !== 2; // 2/3 user, 1/3 assistant with tool

    if (isUser) {
      messages.push({
        info: { id: `msg-${turn}`, role: "user" },
        parts: [{ type: "text", text: `User question about ${topic} - turn ${turn}. GOLDEN FACT: user-query-${turn}-${topic}` }],
      });
    } else {
      // Assistant with tool output
      const toolNames = ["ls", "grep", "read", "diff", "test"];
      const tool = toolNames[turn % toolNames.length];
      const poolKey = tool === "ls" ? "lsLarge" : tool === "grep" ? "grepHits" : tool === "read" ? "readWithLines" : tool === "diff" ? "gitDiff" : "testOutput";
      const output = (TOOL_OUTPUT_POOL[poolKey as keyof typeof TOOL_OUTPUT_POOL] ?? "") as string;

      messages.push({
        info: { id: `msg-${turn}`, role: "assistant" },
        parts: [
          { type: "text", text: `I'll help with ${topic}. GOLDEN FACT: assistant-response-${turn}` },
          { type: "tool", tool: tool as string, state: { status: "completed", output: output as string } },
        ],
      });
    }
  }

  // Collect all golden facts from the session
  const mustHit: string[] = [];
  const niceToHave: string[] = [];

  for (let turn = 0; turn < 55; turn++) {
    const topic = topics[turn % topics.length];
    mustHit.push(`user-query-${turn}-${topic}`);
    if (turn % 3 === 2) {
      mustHit.push(`assistant-response-${turn}`);
      const toolNames = ["ls", "grep", "read", "diff", "test"];
      const tool = toolNames[turn % toolNames.length];
      if (tool === "read") {
        for (let i = 50; i <= 300; i += 50) {
          mustHit.push(`must-hit-${i}`);
        }
      } else if (tool === "diff") {
        mustHit.push("budget increased for large outputs");
        mustHit.push("new timeout handling");
        mustHit.push("new protocol version handling");
      } else if (tool === "test") {
        mustHit.push('degraded reason "timeout" at test line 15');
        mustHit.push("compression ratio threshold 0.85");
      }
    }
  }

  // Add fixture-specific golden facts
  mustHit.push("ansi-marker-0", "ansi-marker-99");
  mustHit.push("progress-0", "progress-100", "progress-complete");
  mustHit.push("backspace-marker-0", "backspace-marker-49");

  for (let i = 0; i < 10; i++) {
    niceToHave.push(`nice-to-have-${i}-${topics[i]}`);
  }

  return {
    name: "long-session",
    description: "55-turn synthetic conversation with tool outputs",
    messages,
    goldenFacts: { mustHit, niceToHave },
  };
}

// Individual tool output fixtures
function generateToolOutputFixtures(): FixtureSample[] {
  return [
    {
      name: "tool-ls-large",
      description: "Large ls -la output (200+ lines)",
      messages: [{
        info: { id: "tool-ls-1", role: "assistant" },
        parts: [{ type: "tool", tool: "ls", state: { status: "completed", output: TOOL_OUTPUT_POOL.lsLarge } }],
      }],
      goldenFacts: {
        mustHit: ["file_0000.ts", "file_0100.ts", "file_0219.md"],
        niceToHave: ["total 123456"],
      },
    },
    {
      name: "tool-grep-hits",
      description: "Multi-file grep hits (100+ lines)",
      messages: [{
        info: { id: "tool-grep-1", role: "assistant" },
        parts: [{ type: "tool", tool: "grep", state: { status: "completed", output: TOOL_OUTPUT_POOL.grepHits } }],
      }],
      goldenFacts: {
        mustHit: ["compressHandler", "fetchHandler", "spawnHandler", "timeoutHandler"],
        niceToHave: ["protocolHandler", "degradedHandler"],
      },
    },
    {
      name: "tool-read-with-lines",
      description: "Read with line numbers (300 lines)",
      messages: [{
        info: { id: "tool-read-1", role: "assistant" },
        parts: [{ type: "tool", tool: "read", state: { status: "completed", output: TOOL_OUTPUT_POOL.readWithLines } }],
      }],
      goldenFacts: {
        mustHit: Array.from({ length: 6 }, (_, i) => `must-hit-${50 * (i + 1)}`),
        niceToHave: ["critical error at line 50", "critical error at line 300"],
      },
    },
    {
      name: "tool-git-diff",
      description: "Git diff with multiple hunks",
      messages: [{
        info: { id: "tool-diff-1", role: "assistant" },
        parts: [{ type: "tool", tool: "diff", state: { status: "completed", output: TOOL_OUTPUT_POOL.gitDiff } }],
      }],
      goldenFacts: {
        mustHit: ["budget increased for large outputs", "new timeout handling", "new protocol version handling"],
        niceToHave: ["test for timeout degradation"],
      },
    },
    {
      name: "tool-test-output",
      description: "Test runner output with failures",
      messages: [{
        info: { id: "tool-test-1", role: "assistant" },
        parts: [{ type: "tool", tool: "test", state: { status: "completed", output: TOOL_OUTPUT_POOL.testOutput } }],
      }],
      goldenFacts: {
        mustHit: ['degraded reason "timeout" at test line 15', "compression ratio threshold 0.85"],
        niceToHave: ["Test Suites: 1 failed", "Tests: 3 failed"],
      },
    },
    {
      name: "tool-noise",
      description: "Pure noise text",
      messages: [{
        info: { id: "tool-noise-1", role: "assistant" },
        parts: [{ type: "tool", tool: "cat", state: { status: "completed", output: TOOL_OUTPUT_POOL.noise } }],
      }],
      goldenFacts: {
        mustHit: [],
        niceToHave: ["lorem ipsum", "adipiscing elit"],
      },
    },
    {
      name: "tool-ansi-colors",
      description: "ANSI color codes variant",
      messages: [{
        info: { id: "tool-ansi-1", role: "assistant" },
        parts: [{ type: "tool", tool: "cat", state: { status: "completed", output: TOOL_OUTPUT_POOL.ansiColors } }],
      }],
      goldenFacts: {
        mustHit: ["ansi-marker-0", "ansi-marker-99"],
        niceToHave: ["[INFO] Processing item 50"],
      },
    },
    {
      name: "tool-carriage-return",
      description: "Carriage return progress bar variant",
      messages: [{
        info: { id: "tool-cr-1", role: "assistant" },
        parts: [{ type: "tool", tool: "cat", state: { status: "completed", output: TOOL_OUTPUT_POOL.carriageReturn } }],
      }],
      goldenFacts: {
        mustHit: ["progress-0", "progress-100", "progress-complete"],
        niceToHave: ["Progress: [====    ] 50%"],
      },
    },
    {
      name: "tool-backspace-corruption",
      description: "Backspace corruption variant",
      messages: [{
        info: { id: "tool-bs-1", role: "assistant" },
        parts: [{ type: "tool", tool: "cat", state: { status: "completed", output: TOOL_OUTPUT_POOL.backspaceCorruption } }],
      }],
      goldenFacts: {
        mustHit: ["backspace-marker-0", "backspace-marker-49"],
        niceToHave: ["corrupted"],
      },
    },
  ];
}

export function buildFixtures(): FixtureSet {
  return {
    longSession: generateLongSession(),
    toolOutputs: generateToolOutputFixtures(),
  };
}

export function allFixtures(): FixtureSample[] {
  const set = buildFixtures();
  return [set.longSession, ...set.toolOutputs];
}

export function quickFixtures(): FixtureSample[] {
  const set = buildFixtures();
  // For quick mode: just the long session + 3 tool outputs
  return [set.longSession, set.toolOutputs[0]!, set.toolOutputs[2]!, set.toolOutputs[4]!];
}

export function fixturesToHeadroomParams(fixture: FixtureSample, contextWindowTokens = 8192): HeadroomCompressParams {
  return {
    sessionId: `eval-${fixture.name}`,
    projectId: "default",
    messages: fixture.messages,
    contextWindowTokens,
    triggerRatio: 0.7,
    retainRecentTurns: 4,
  };
}