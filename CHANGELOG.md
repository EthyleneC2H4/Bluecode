# Changelog

All notable changes to BlueCode are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
semver-ish at the workspace level — all `@bluecode/*` packages move together
for now.

## [0.1.0] - 2026-08-25

First tagged release: the complete BlueCode plugin + dual-sidecar system,
hardened through two full audit rounds.

### Added

- **rtk sidecar** (`@bluecode/rtk`): stdio JSONL daemon that compresses tool
  outputs past a byte threshold into sha256-addressed CAS objects and returns
  compact previews; originals stay retrievable via the `sha256:` hash.
- **headroomd sidecar** (`@bluecode/headroomd`): UDS daemon archiving evicted
  conversation turns into SQLite + FTS5 with deterministic summarization;
  retrieval by hash or BM25 query; startup self-heal rebuilding the derived
  index from objects + attribution ledger.
- **opencode plugin** (`@bluecode/plugin`): wires both sidecars into opencode
  via tool-execute-after compression, messages-transform plan application,
  compacting fallback injection, session-idle watermark monitoring, and the
  `headroom_retrieve` custom tool whose routing layer bridges both sidecars'
  hash namespaces.
- **Contracts** (`@bluecode/contracts`): zod wire schemas for every frame,
  error codes, and protocol version pinning.
- **Shared** (`@bluecode/shared`): line framing, spawn argv resolution,
  uid-namespaced default paths, local-path redaction.
- **Eval harness** (`@bluecode/eval`): fixture-driven compression-ratio,
  recall, and latency measurement against a frozen baseline
  (`bun run eval --check`; latency skipped in CI).
- CI: typecheck + tests across packages, dependency-direction gate, eval
  regression gate.

### Fixed (audit round 2)

- Plugin factory actually forwards `headroom.socketPath` /
  `headroom.idleExitMs` to the spawned daemon via spawn args — both options
  were parsed-but-unwired, and an explicit socketPath broke daemon self-heal
  outright (daemon bound the default path while connect polled the explicit
  one).
- `headroom_retrieve` routes `sha256:`-prefixed hashes to rtk before any
  headroomd availability guard: the two sidecars fail independently, so a
  tool-output fetch must work whenever rtk is alive.
- `rebuild_state` records the rebuild's `skipped` count, so meta-ahead-of-index
  divergence (WAL checkpoint rollback, crash between the two write
  transactions) is detected even when neither file dropped below its recorded
  baseline.
- chmod hardening degrades to a warning instead of killing daemon startup on
  root-owned leftovers or exotic mounts.
- Connect-time handshake accumulator is bounded (64 KiB) against rogue socket
  listeners.

[0.1.0]: https://github.com/EthyleneC2H4/Bluecode/releases/tag/v0.1.0
