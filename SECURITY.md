# Security Policy

## Supported versions

Security fixes land on `main` only; there are no long-lived release branches.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** (Security tab → Report a
vulnerability) rather than a public issue. Include a reproduction and, if
possible, the affected package(s).

## Scope notes

BlueCode is a local developer tool. One OpenCode plugin coordinates RTK over
stdio, headroomd over a Unix socket, and optional VSecAgent scanning over stdio.
VSecAgent is offline by default. Enterprise adapters and LLM summaries require
explicit configuration. There is no telemetry.

Areas of particular interest to this project:

- **Cross-user escalation on shared hosts** — the headroomd socket and its
  data directory must not be attachable/writable by other local accounts
  (default dirs are uid-namespaced, dir mode `0700`, socket mode `0600`).
- **Evidence leakage** — archives require project/session ownership. With VSecAgent
  enabled, recognized credentials must be filtered before RTK/headroom persistence
  and retrieval. Policy-bound archives must not fall back to older unfiltered data.
- **Tool safety regression** — supported high-confidence critical operations must
  be denied before execution in enforce mode, with no side effect. Scanner failure
  must block write/execute/unknown operations and withhold unverified output.
- **Protocol-level injection** — malformed JSONL frames, oversized frames, or
  hostile tool output reaching the model unescaped.

Out of scope: prompt-injection *inside* repository content that an agent chooses
to act on — that is inherent to coding agents, though reports about BlueCode
amplifying it are welcome.

The [VSecAgent guide](docs/vsecagent.md) lists supported syntax and Hook coverage
limits. This is not an OS sandbox or complete SAST. Manual shell, command-template
execution, later plugin mutation, filesystem races and opaque attachments remain
outside full enforcement. OpenCode original session storage is not scrubbed.
