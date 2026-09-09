# BlueCode

Context engineering for [OpenCode](https://github.com/anomalyco/opencode): an RTK tool-output sidecar and a headroomd history archive, mounted through one plugin.

[简体中文](README.zh-CN.md) · [Architecture](docs/architecture.md) · [Operations](docs/operations.md) · [Implementation and evidence](docs/reliability-implementation.md)

This is an independent learning implementation, not vivo's private BlueCode source. Evaluation uses local synthetic data.

## How it works

| Component | Responsibility |
|---|---|
| RTK | Condenses recognized command output, preserving code, changed diff lines and complete failure diagnostics. The 512-token target is soft; protected content can exceed it. |
| headroomd | Archives completed turns, builds evidence memory, and persists a view that can be reapplied to each fresh host message array. Recent turns, active tools and unsupported content remain protected. |
| Plugin | Owns clients and state per instance; binds retrieval to actual project/session IDs; coordinates model limits and upstream compaction. |
| Retrieval | Searches full-content chunks with FTS5/BM25 and restores verified archives through bounded cursors. Retrieval output bypasses RTK. |

RTK uses protocol v3 over stdio; headroomd uses protocol v2 over a Unix socket. Durable data lives outside temporary runtime sockets. Errors preserve host-visible content or pause planning; retrieval reports missing or corrupt archives explicitly. RTK stores the sanitized text it receives, which may already have been truncated by the host.

## Implementation architecture

RTK condenses individual tool results; headroomd archives accumulated conversation history. These three diagrams describe this repository's Bun / TypeScript implementation. The sidecars do not call each other: the host plugin owns orchestration and retrieval routing.

### Overview: two compression stages and a retrieval loop

```mermaid
flowchart TB
    subgraph HOST["OpenCode host process"]
        direction TB
        LLM["LLM / Agent loop"]
        TOOL["Execute tools<br/>bash, grep, read, glob, etc."]
        AFTER["tool.execute.after<br/>PluginRuntime.toolAfter"]
        HISTORY["Host conversation history<br/>Tool results have passed the RTK hook"]
        TRANSFORM["messages.transform<br/>Capture the visible snapshot<br/>Validate and apply a ready history view"]
        RETRIEVE["headroom_retrieve<br/>Project / session isolation<br/>Routing + page budgets"]
        RC["RtkClient<br/>Warmup, queue, deadline, restart"]
        HC["HeadroomClient<br/>Connect to or spawn a daemon"]

        LLM -->|"Tool call"| TOOL
        TOOL -->|"Text after execution completes"| AFTER
        AFTER -->|"Compressed result or original text"| HISTORY
        HISTORY --> TRANSFORM
        TRANSFORM -->|"Valid history view"| LLM
        LLM -->|"Needs archived details"| RETRIEVE
        RETRIEVE -->|"Retrieved output bypasses RTK in the hook"| HISTORY
        AFTER <-->|"Wait for this compress result"| RC
        TRANSFORM -.->|"Schedule a snapshot in the background<br/>Do not wait for a new plan"| HC
        HC -.->|"Publish after candidate validation<br/>Replay on later transforms"| TRANSFORM
        RETRIEVE -->|"sha256: reference → fetch"| RC
        RETRIEVE -->|"Message hash / historyHash / query"| HC
    end

    subgraph RTK["Separate RTK subprocess"]
        RE["RtkEngine<br/>Rule compression + original text storage"]
        RS[("RTK object store<br/>Canonical text CAS<br/>SQLite ownership / quota")]
        RE <--> RS
    end

    subgraph HR["Separate headroomd daemon"]
        HE["HeadroomEngine<br/>Turn segmentation, archive planning, memory"]
        HO[("objects<br/>Gzipped message objects")]
        HM[("meta.db<br/>Ownership, manifests, active views")]
        HI[("index.db<br/>Full-content chunks + FTS5 / BM25")]
        HE <--> HO
        HE <--> HM
        HE <--> HI
    end

    RC <-->|"stdio JSONL v3"| RE
    HC <-->|"Unix socket JSONL v2"| HE
```

RTK waits for a deadline-bounded compression call after a tool returns. Headroom plans in the background; before a model call, the plugin validates and applies a ready view. Clients and pure calculations run in the host, while databases and archive writes stay in separate processes. Retrieved evidence explicitly bypasses RTK so that recovery does not immediately fold it again.

Source: [plugin factory](packages/plugin/src/index.ts), [production runtime](packages/plugin/src/runtime.ts), [retrieval entry point](packages/plugin/src/retrieval.ts).

### Inside RTK: rules, protected anchors and durable originals

```mermaid
flowchart TB
    IN["Tool result<br/>tool, output, metadata<br/>project/session, callId"]
    GUARD{"Retrieved evidence<br/>or below minBytes?"}
    PASS["Preserve original host text"]
    CLIENT["RtkClient<br/>Default 40ms deadline includes queue time<br/>At most 32 pending requests / 8MiB"]
    WIRE["stdio JSONL v3<br/>Request / response ID matching<br/>Schema validation"]

    subgraph CORE["rtk-core: rules without persistence access"]
        CLEAN["sanitize → redactor<br/>Canonicalize text and compute SHA-256"]
        CLASSIFY["Classifier<br/>Explicit tool ID first<br/>Otherwise score output structure"]
        STRATEGY["Strategy parser<br/>diff / test / grep / ls / read / unknown"]
        FAST{"read / unknown<br/>or original fits budget?"}
        LINE["Shared CLine representation<br/>text, sourceLine<br/>anchor, priority, group"]
        BUDGET["Budget selection<br/>Fold only unprotected content<br/>Select by priority and group"]
        GAIN{"Is the assembled result<br/>smaller than the original?"}
        UNCHANGED["Choose canonical original<br/>status = unchanged"]
        COMPRESSED["Choose compressed text<br/>status = compressed"]

        CLEAN --> CLASSIFY --> STRATEGY --> FAST
        FAST -->|"Yes"| UNCHANGED
        FAST -->|"No"| LINE --> BUDGET --> GAIN
        GAIN -->|"Positive gain"| COMPRESSED
        GAIN -->|"No gain"| UNCHANGED
    end

    STORE["RtkEngine persists the canonical original<br/>Reserve quota → publish CAS object<br/>Verify hash → grant session ownership"]
    RESULT["Return output, rawHash, strategy<br/>status, omittedRanges<br/>budgetExceeded, diagnostics"]
    OUT["Tool result enters conversation"]

    IN --> GUARD
    GUARD -->|"Yes"| PASS
    GUARD -->|"No"| CLIENT
    CLIENT --> WIRE --> CLEAN
    COMPRESSED --> STORE
    UNCHANGED --> STORE
    STORE -->|"Stored successfully"| RESULT
    RESULT -->|"Only compressed status replaces host text"| OUT
    PASS --> OUT
    CLIENT -.->|"Timeout, overload or unavailable process"| PASS
    STORE -.->|"Capacity or storage error"| PASS
```

The default `minBytes=512` is a client byte threshold; `budgetTokens=512` is a soft compression target. Strategies mark protected content with `anchor`: `read` preserves full source text, `diff` protects all changes and file / hunk headers, and `test` protects failure diagnostics. `grep` and `ls` fold structural groups; `unknown` preserves the text. Protected content may exceed the target, reported through `budgetExceeded`.

CAS stores text after sanitize / redactor processing. The default redactor is identity, so this does not imply automatic secret removal. Compressed output carries retrieval instructions; storage failure preserves host text. Content truncated by the host before the hook cannot be recovered here.

Source: [client](packages/rtk/src/client.ts), [classifier](packages/rtk-core/src/classify.ts), [strategy pipeline](packages/rtk-core/src/pipeline.ts), [budget selection](packages/rtk-core/src/budget.ts), [storage and fallback](packages/rtk/src/engine.ts).

### Inside headroomd: background planning and active view replay

```mermaid
flowchart TB
    SNAP["messages.transform<br/>Copy the currently visible host messages"]
    READY{"Active view available?"}
    VERIFY["Validate ordered message IDs<br/>Per-message content digests<br/>Upstream compaction epoch"]
    APPLY["Replace the safe history prefix<br/>Synthetic user message: summary + retrieval hint"]
    MODEL["Current model input<br/>Valid history view + retained tail"]

    SNAP --> READY
    READY -->|"Yes"| VERIFY
    VERIFY -->|"Valid"| APPLY --> MODEL
    VERIFY -->|"Invalid: clear old view, preserve host messages"| MODEL
    READY -->|"No: preserve host messages"| MODEL

    subgraph BACKGROUND["Background planning: the current model call does not wait"]
        PROJECT["Project visible messages<br/>Protect unknown content, attachments and active tools<br/>Estimate effective context after applying the old view"]
        TRIGGER{"Known model window and<br/>effective context at least 70% of usable budget?"}
        TURNS["Split turns at user messages<br/>Retain the last turn and 4 preceding turns"]
        PREFIX["Select the oldest contiguous safe prefix<br/>Stop at a protected turn"]
        MEMORY["Build rule-based evidence memory<br/>Constraints, decisions, changes<br/>Verification, failures, open work"]
        PLAN["Evaluate progressively larger prefixes<br/>Target 55% of usable budget<br/>Require positive token savings"]
        ARCHIVE["Persist archive<br/>Message objects → metadata → derived index<br/>Save manifest"]
        CHECK["Revalidate the candidate<br/>against the latest host snapshot"]
        PUBLISH["view.set<br/>Persist the active view<br/>Update the plugin instance cache"]
        SKIP["Do not publish a new view<br/>Keep the valid view or host messages"]

        PROJECT --> TRIGGER
        TRIGGER -->|"Yes"| TURNS
        TRIGGER -->|"No"| SKIP
        TURNS --> PREFIX --> MEMORY --> PLAN
        PLAN -->|"Positive gain"| ARCHIVE --> CHECK
        PLAN -->|"No safe prefix or no gain"| SKIP
        CHECK -->|"Still valid"| PUBLISH
        CHECK -->|"Stale"| SKIP
        ARCHIVE -.->|"Storage failure"| SKIP
    end

    SNAP -.->|"Schedule background work"| PROJECT
    PUBLISH -.->|"Next and subsequent transforms"| READY
    UP["OpenCode upstream compaction"]
    UP -.->|"Start: pause application / cancel old planning<br/>Complete: clear the old view"| READY
```

The usable input budget is `min(input limit, context limit − output reserve) − estimated system tokens − 512`, using context when no separate input limit is available. Unknown windows pause planning. Runtime thresholds and planning use `ceil(text.length / 4)`; exact tokenization is reserved for offline evaluation. Retrieval pages separately use UTF-8 bytes as a conservative token upper bound.

Memory uses rule-based categorization and exact repetition folding, without an LLM call. User text stays verbatim; tool `input/output/error` all participate, and each memory entry carries `sourceIds`. A plan includes ordered `replacedMessageIds`, `sourceDigests`, an `epoch`, a summary and archive references. Each transform validates and replays it: tail appends can preserve an existing prefix, while source edits, removal, reordering or an upstream epoch change invalidate the old plan.

Message objects use content hashes and are checked against their schema and hash on read. `meta.db` owns attribution, manifests, archive lineage and active views; `index.db` holds rebuildable full-text indexes. Replacement affects the model-input view and does not delete the host's persistent history through this path.

Source: [scheduling and budgets](packages/plugin/src/runtime.ts), [host projection and replacement](packages/plugin/src/host-adapter.ts), [archive engine](packages/headroomd/src/engine.ts), [memory builder](packages/headroomd/src/memory.ts), [plan validation](packages/headroomd/src/compaction.ts), [active view persistence](packages/headroomd/src/store/manifests.ts). See [protocol](docs/protocol.md) for the complete interfaces.

## Run locally

Use **Bun 1.4.0**. Linux and macOS are intended platforms. Local verification was on macOS; Linux has a configured CI job, with execution results pending.

```sh
bun install --frozen-lockfile
bun run verify
bun run eval --check --skip-latency
```

Verification runs strict workspace typechecks, tests, dependency checks and a host bundle check that rejects SQLite imports. Evaluation requires no model credentials.

Mount the checkout through OpenCode's tuple-form configuration:

```json
{
  "plugin": [["file:///absolute/path/Bluecode/packages/plugin/src/index.ts", {
    "mode": "on",
    "rtk": {"budgetTokens": 512, "timeoutMs": 40, "minBytes": 512},
    "headroom": {"triggerRatio": 0.7, "targetRatio": 0.55, "retainRecentTurns": 4}
  }]]
}
```

The adapter targets the inspected OpenCode **1.18.21** API. Some hooks are experimental. See [integration notes](docs/integration-notes.md) and [operations](docs/operations.md) for off/shadow/on, allowances, migration and recovery.

## Measured replay

Eleven fixtures run through four configurations using the production plugin runtime. The o200k_base count covers all fixed model-input representations, repeated context, question calls and retrieval evidence.

| Configuration | Total input tokens |
|---|---:|
| A: passthrough | 582,501 |
| B: RTK | 464,781 |
| C: headroomd | 529,923 |
| D: combined | 435,436 |

The combined query-only replay saves **25.25%** total input. Natural-question Recall@5 is 10/10 in C/D; each group preserves 3/3 designated critical constraints and passes 10/10 deterministic answer checks. D restores 108/108 archive items exactly. Ordinary legacy context facts remain 102/104 in B/D and are reported separately.

These are deterministic content checks, not measured LLM task-solving accuracy or provider billing. Eager full-document retrieval saves only **6.95%**, failing the 20% cost target. At 32 concurrent calls, RTK degrades 13 times under its 40ms deadline. See [full evidence and limitations](docs/reliability-implementation.md) and [evaluation CLI](packages/eval/README.md).

## Development

Seven packages separate contracts, shared primitives, pure RTK strategies, RTK transport/storage, headroomd, the plugin and evaluation. Evaluation imports the production runtime; sidecars remain independent. Legacy plugin helpers remain for compatibility tests, outside the production factory's import graph.

See [CONTRIBUTING.md](CONTRIBUTING.md), [protocol](docs/protocol.md), [design](docs/superpowers/specs/2026-09-05-reliability-design.md) and [implementation plan](docs/superpowers/plans/2026-09-05-reliability.md).

MIT; see [LICENSE](LICENSE). AI assisted implementation and documentation; architectural sources and license boundaries are recorded in the implementation report.
