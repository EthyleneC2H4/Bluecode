# Contributing

Thanks for looking at BlueCode. This document covers the minimum needed to
open a good PR; [`docs/architecture.md`](docs/architecture.md) explains how the
pieces fit.

## Setup

```bash
git clone git@github.com:EthyleneC2H4/Bluecode.git
cd Bluecode
bun install --frozen-lockfile  # Bun 1.4.0
bun run verify                # types, tests, dependency, host-import and security gates
```

## Before you open a PR

1. **`bun run verify` green.** Strict TS (`exactOptionalPropertyTypes`) and all
   tests passing is the floor, not the bar.
2. **Eval gate green if you touched rtk / headroomd / eval.** Run `bun run eval --check --skip-latency`
   — the frozen baseline in
   [`packages/eval/baseline.json`](packages/eval/baseline.json) fails CI on
   compression regression (>2pp worse) or recall regression. Latency is
   measured locally by default but CI runs with `EVAL_SKIP_LATENCY=1`: p95 on
   shared runners is too noisy to gate on, so treat a local latency blowup as
   your own red flag, not a CI failure. If your change *intentionally* moves
   numbers, explain the semantic change and old/new measurements before
   refreshing with `--update-baseline`. A refresh still requires all absolute
   reliability targets to pass; it cannot waive failed quality gates.
   See [evaluation methodology](packages/eval/README.md). Test reports and
   baselines must use isolated temporary paths.
3. **Respect the dependency direction** — CI enforces it via
   [`scripts/check-dependency-direction.ts`](scripts/check-dependency-direction.ts)
   (also part of `bun run verify`):

   | Package | Internal dependencies |
   |---|---|
   | contracts / shared | none |
   | rtk-core | contracts, shared |
   | rtk | rtk-core, contracts, shared |
   | security-core | contracts |
   | vsecagent | security-core, contracts, shared |
   | headroomd | contracts, shared, security-core (pure archive guard) |
   | plugin | clients for rtk, headroomd, vsecagent; contracts, shared |
   | eval | production runtime and clients; declared evaluation dependencies |

   The sidecars do not call one another. The plugin orchestrates tool checks,
   redaction, compression and retrieval. SQLite and TS/Bash parsers must remain
   outside the host factory bundle. Security tests use synthetic canaries and
   local mock services, never real credentials or destructive execution.
4. **Add tests for behavior fixes.** A fix without a test that would have caught
   the bug tends to come back.
5. **Notable changes get a devlog entry** ([`docs/devlog.md`](docs/devlog.md)):
   what broke or was hard, root cause, fix, lesson.

## Commit style

Short imperative subject (`fix: …`, `feat: …`, `docs: …`, `test: …`), body only
when the *why* isn't obvious from the diff.

## Reporting bugs

Open an issue with the template. For security-sensitive reports, see
[`SECURITY.md`](SECURITY.md) instead.
