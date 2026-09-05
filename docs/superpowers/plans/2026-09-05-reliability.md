# RTK / headroomd Reliability Implementation Plan

**Goal:** 实施已批准的可靠工程版，保持插件与双sidecar边界。
**Architecture:** core纯逻辑、client进程调度、daemon归档、plugin宿主适配、eval真实链路。
**Tech Stack:** Bun 1.4.0 / strict TypeScript / zod / SQLite FTS5 / CAS。
**Spec:** docs/superpowers/specs/2026-09-05-reliability-design.md

## Global Constraints

用户已授权全部六阶段。上游只读。独立分支。每个行为先编写失败回归，再实现、定向测试和审查；全仓测试仅由控制器执行。不得宣称尚未跑过的验收。并行改动按文件所有权隔离，不覆盖他人修改。无需询问是否继续。

## Task 1: RTK and shared reliability

Ownership: packages/rtk-core, packages/rtk, packages/contracts/src/rtk.ts, shared/jsonl.ts, shared/cas.ts and corresponding tests.
Interfaces: preserve existing client conveniences while adding wire v3 status, envelope context, provenance, max limits; compress includes total deadline; fetch has bounded pagination. Export shared pagination helper separately only if needed by agreement with controller.
- [x] Add failing cases: real read colon wrapper, diff4-6, dense failures, budget many groups, chunk partition invariance, same-size corrupt CAS, concurrent deadline, truthful status.
- [x] Implement block/source-aware conservative strategies, linear scanning and incremental budgeting, quota-compatible confirmed CAS publication, queue/deadline/generation handling.
- [x] Add protocol v3 fields with explicit result status, queue/phase diagnostics, range/provenance and fetch cursor.
- [x] Run RTK/shared targeted tests and typecheck; report reviewable diff and evidence.

## Task 2: Headroom archive, integrity, memory and retrieval

Ownership: packages/headroomd and contracts/headroom.ts. Controller-owned initially.
Interfaces: protocol v2 sourceDigests/epoch/manifest/memory/targetBudget plus persistent views; ordered full-projection hash; verified legacy reader; bounded cursor retrieval; client and pure subpath exports.
- [x] Add failing integrity/EOF/rebuild/multi-generation/fulltext/paging/stale cases.
- [x] Implement verified storage v2, durable manifests/memory/views, full-content indexing and paging, repairable derived database, quota.
- [x] Implement 70/55 planner, protected turns, user-verbatim evidence memory, lineage.
- [x] Implement v2 connect/EOF/backpressure/concurrency limits and read-only legacy access.
- [x] Run targeted headroom/contracts tests and typecheck; review.

## Task 3: Plugin runtime and integration

Ownership: packages/plugin, shared/paths.ts, package exports/manifests in coordination with prior owners.
Interfaces: runtime factory receives host project/model/messages, explicit clients; old helpers remain compatibility adapters only for tests if needed but factory never uses module globals.
- [x] Add tests for instances/MCP/retrieval bypass/shadow/model-switch/real compaction/sticky fresh arrays/stale prefix.
- [x] Implement runtime-owned state, explicit spawning, stable model cache, accurate project namespace, activity planning, persistent views, upstream coordination.
- [x] Register only factory default export; preserve host fields and protected parts.
- [x] Run plugin tests and SDK typecheck; review.

## Task 4: Migration, lifecycle and operations

Ownership: scripts and shared storage paths; related daemon files coordinated.
- [x] Add isolated migration and quota/GC tests; implement copy-verify-switch migration with retained source, v1 read only.
- [x] Separate durable data and runtime socket, clean explicit ownership, bounded reconnect.
- [x] Add off/shadow/on controls and platform smoke checks; exact pin current installed dependencies.

## Task 5: Real plugin replay evaluation and quality gates

Ownership: packages/eval and CI.
- [x] Inject report/baseline paths; remove tracked-file substitution from tests.
- [x] Run A/B/C/D through actual plugin adapter, persistent multi-step views and retrieval; independent questions and expected content comparison.
- [x] Add critical invariants, natural-query Recall@5, total tokens including retrieval, latency breakdown and deterministic task outcomes.
- [x] Record measured metrics honestly; refresh baseline only after explaining semantic changes and all correctness gates pass.

## Task 6: Whole change verification and documentation

Ownership: docs, README, CI and final integration.
- [x] Run bun run verify and full eval gates; inspect worktree diff and independent final review.
- [x] Fix review findings with regressions; rerun affected checks.
- [x] Update architecture/protocol/integration/devlog, migration and recovery docs, actual test counts and measured baseline.
- [x] Record platform/real-provider limitations explicitly; commit changes on branch without remote push or publish.

## 完成记录

实现与最终验收见 [reliability-implementation.md](../../reliability-implementation.md) 及 [机器可读证据](../../reliability-verification.json)。473 tests / 0 failures；默认组合回放净输入减少25.25%，独立相对检查通过；全文展开场景6.95%并按预期未通过成本门槛。Linux配置待CI实跑，未测真实provider。保留实施分支与工作树，提交到本地，不推送。
