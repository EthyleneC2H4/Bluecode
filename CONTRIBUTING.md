# Contributing

Thanks for looking at BlueCode. This document covers the minimum needed to
open a good PR; [`docs/architecture.md`](docs/architecture.md) explains how the
pieces fit.

## Setup

```bash
git clone git@github.com:EthyleneC2H4/Bluecode.git
cd Bluecode
bun install          # Bun 1.4+ required
bun run verify       # typecheck (all packages) + tests
```

## Before you open a PR

1. **`bun run verify` green.** Strict TS (`exactOptionalPropertyTypes`) and all
   tests passing is the floor, not the bar.
2. **Eval gate green if you touched rtk / headroomd / eval.** Run `bun run eval`
   — the frozen baseline in
   [`packages/eval/baseline.json`](packages/eval/baseline.json) fails CI on
   compression regression (>2pp worse) or recall regression. Latency is
   measured locally by default but CI runs with `EVAL_SKIP_LATENCY=1`: p95 on
   shared runners is too noisy to gate on, so treat a local latency blowup as
   your own red flag, not a CI failure. If your change *intentionally* moves
   numbers, re-run with `--update-baseline`, paste the old/new table into the
   PR, and say why.
3. **Respect the dependency direction** — CI enforces it via
   [`scripts/check-dependency-direction.ts`](scripts/check-dependency-direction.ts)
   (also part of `bun run verify`):

   ```
   contracts   shared          ← leaves; import nothing internal
      ↑  ↑        ↑  ↑
      │  └────────┘  │
   rtk-core    headroomd     ← sidecar cores: contracts + shared only
      ↑                          (headroomd never sees rtk-core)
      ├── rtk                   ← rtk builds on rtk-core
      │      ↑
   plugin   eval               ← hosts: rtk + headroomd + contracts + shared
   ```

   The two sidecars must stay mutually unaware — the retrieval bridge that
   lets them share hashes lives in the plugin's tool layer, not in either
   daemon.
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
