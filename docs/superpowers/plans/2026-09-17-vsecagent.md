# VSecAgent Implementation Plan

**Goal:** Deliver the approved offline tool safety and sanitized archival pipeline.
**Spec:** ../specs/2026-09-17-vsecagent-design.md
**Tech stack:** Bun 1.4.0, TypeScript 5.9.3, OpenCode plugin SDK 1.18.21,
real-host validation 1.18.23. JSONL v1 scanner, existing sidecar protocols unchanged.

## Global constraints

Use the binding requirements and implementation contracts in the spec. No external
LLM or security endpoint calls. No edits to vendored OpenCode. Worktree isolated;
all implementation uses behavior tests first. No destructive commands in real-host
tests. Security off must preserve existing behavior and frozen baseline.

## Task 1: Contracts and pure security rules

Own packages/contracts security additions and packages/security-core. Add schemas,
safe findings, eight rule families, TS/Bash parsing, span redaction, exception
application and new-versus-existing findings. Unit tests cover positives/negatives,
partial coverage, placeholders, secret-free diagnostics, and AST distinctions.
Run package tests and strict typechecks before commit.

## Task 2: Scanner process and bounded infrastructure

Own packages/vsecagent. Implement JSONL v1 engine/server/client with warmed startup,
bounded deadline/queue, generation isolation/restart, bounded scoped cache, safe
rotating audit and provider adapters. Actual subprocess tests cover faults and
resource limits; fake services test optional adapters. Root updates dependency gate.

## Task 3: Host pipeline and safe storage integration

Root owns packages/plugin security adapter/config/index/runtime/retrieval and
related tests. Normalize tools/paths and exact file previews; before checks,
after redaction, system/messages/compacting filtering, safe archive namespaces,
retrieval redaction preserving cursors. Tests prove disabled compatibility,
denied no-execution, pipeline canaries, safe exceptions, policy lifecycle.

## Task 4: Independent acceptance and actual-host validation

Add development 160 / held-out 320 diverse fixtures with fixed labels before
tuning. Separate metrics for detection/block/false-warning/coverage. Add scanner
and end-to-end latency/RSS/concurrency evaluation. Real OpenCode local mock provider
tests builtins/MCP/child tools with safe tempdir side effects only. Re-run original
security-off ablation and separate security-on quality metrics.

## Task 5: Integration review, docs, verification and publication

Independent spec/quality reviews after subsystem delivery and broad final review.
Fix critical/important findings with regression tests. Document supported syntax,
coverage exclusions, modes, policies, exceptions, archive semantics, startup and
failure recovery, adapters, measured data and remaining production prerequisites.
Run full verify, security acceptance and host import/dependency gates. Commit by
stage. Preserve unrelated worktrees and sync approved repository work to GitHub.
