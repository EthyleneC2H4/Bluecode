# Security Policy

## Supported versions

Security fixes land on `main` only; there are no long-lived release branches.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** (Security tab → Report a
vulnerability) rather than a public issue. Include a reproduction and, if
possible, the affected package(s).

## Scope notes

BlueCode is a local developer tool: one opencode plugin process talking to two
sidecar processes it spawns itself (rtk over stdio pipes, headroomd over a
Unix domain socket). There is no network listener and no telemetry.

Areas of particular interest to this project:

- **Cross-user escalation on shared hosts** — the headroomd socket and its
  data directory must not be attachable/writable by other local accounts
  (default dirs are uid-namespaced, dir mode `0700`, socket mode `0600`).
- **Uncompressed-content leakage** — tool outputs and history turns are stored
  verbatim in the CAS (`dataDir/objects/`); anything that lets another process
  or account read them is a vulnerability.
- **Protocol-level injection** — malformed JSONL frames, oversized frames, or
  hostile tool output reaching the model unescaped.

Out of scope: prompt-injection *inside* repository content that an agent chooses
to act on — that is inherent to coding agents, though reports about BlueCode
amplifying it are welcome.
