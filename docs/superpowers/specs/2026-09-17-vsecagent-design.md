# VSecAgent: approved design

The user approved a local, offline security layer on 2026-09-17. This implements
the public Bluecode reconstruction, not the private VSecAgent product.

## Binding requirements

- Two new packages: security-core (pure detection/sanitization) and vsecagent
  (terminable Bun child process, JSONL v1, client, adapters, bounded audit).
- Tool before hook evaluates risk before execution. High-confidence CRITICAL
  findings deny; HIGH/MEDIUM warn. Never rewrite executable args automatically.
- Eight families: credential, dangerous-command, sensitive-file, path-traversal,
  dynamic-execution, sql-injection, xss, weak-crypto. JS/TS/JSX/TSX syntax checks
  use TypeScript 5.9.3; Bash uses web-tree-sitter 0.25.10/tree-sitter-bash 0.25.0
  with local WASM. No LLM or external credential validation.
- write scans full candidate; edit scans inserted text and exact reconstructed
  candidate when possible; apply_patch scans all paths/additions and exact
  reconstructed files when possible. Existing findings are distinguished from
  newly introduced ones. Ambiguous reconstruction is partial, never complete.
- Canonicalize paths using realpath/nearest existing parent. In-project ../,
  public keys, safe .env examples, literal safe code and placeholders are not
  blanket-denied. Unknown MCP side effects are not trusted as read-only.
- bash structural analysis covers chains, pipes, redirects, common wrappers and
  literal shell -c up to depth two. Unsupported/dynamic syntax is reported.
- Independent security.mode off/audit/enforce; default off. Audit observes tool
  risk without blocking it, but sanitization and sanitization fail-closed remain.
  Enforce risk-based unavailability: reject writes/execution/unknown operations;
  known reads may run but their results still require sanitization.
- Deadline 1000ms including queue; startup separate. Max 32 pending / 8MiB queue,
  1MiB per text/code field; no prefix-only claim. Timed-out generation terminated,
  late results rejected. Namespace/policy/parser-keyed cache <=16MiB.
- Sanitize before RTK minBytes or bypass decisions, before headroom snapshot and
  source digests, and after generated views/candidates. Sanitize retrieval even
  though it bypasses RTK; pagination uses original cursors. Cover text metadata,
  tool input/output/error, user text and system text; opaque parts report gaps.
- Failed/unscannable text is replaced with an explicit unavailable message and
  never sent to model or Bluecode archives. Redaction is span-local/idempotent,
  preserving line breaks and non-secret requirements. New archives store only
  sanitized evidence, isolated by policy fingerprint; no legacy archive fallback.
- Audit logs contain only safe decision metadata (no command/code/args/secrets),
  are size bounded/rotated. User exceptions specify rule/scope/reason/expiry.
- Separate optional firewall and redaction provider interfaces; test mock
  adapters only. Do not invent private endpoint/auth contracts.
- Hooks are defense in depth, not a sandbox. Manual shell, template shell,
  later plugins, TOCTOU and opaque attachments are explicit coverage exclusions.
  Vendored OpenCode is read-only; original host DB/terminal history not purged.

## Acceptance

- Development: 8 families x (10 risk + 10 benign)=160. Held-out acceptance:
  8 x (20 risk +20 benign)=320, distinct template families (not renamed copies).
- Prelabelled high-confidence critical block 100%; supported risk detection >=95%;
  benign false blocks 0; false warnings <=5%. Coverage and block/detect separate.
- Tests for no side effects on denied tools, full pipeline canaries (model,
  RTK/headroom CAS/FTS/summary requests/retrieval/audit), scoped access, policy
  changes, exceptions, failures, restart, queues and tool variants.
- Real OpenCode 1.18.23 uses local mock model service only and safe tempdir tools;
  genuinely destructive commands only go through non-executing test doubles.
- Fixed-machine warm p95 targets: simple 30ms; 64KiB 150ms; 1MiB 500ms. Report
  child/main RSS, cold start and 1/8/32 concurrency. Shared CI functional gates.
- Security off preserves current RTK/headroom replay. On gets separate quality/
  token metrics; withheld content/blocked actions are never compression savings.
- Keep TS/Bun stack and existing RTK/headroom algorithms; update docs/readmes,
  dependency graph/host bundle gate; run full verify and safety acceptance.

## Implementation contracts

Shared names live in @bluecode/contracts and are prefixed Security/Vsec.
SecurityNamespace = {projectId:string, sessionId:string}.
SecurityPolicy = {version:string, exceptions:SecurityException[], deniedPaths:string[],
  mcpTools:Record<string,{operation:'read'|'write'|'execute'|'unknown',
  pathFields:string[], contentFields:string[]}>}.
Exception = {ruleId:string, scope:string, reason:string, expiresAt:string}.
SecurityFile = {path:string, content:string, before?:string, complete:boolean}.
SecurityPath = {path:string, resolvedPath:string, operation:'read'|'write'|'delete'}.
SecurityEvaluateParams = {namespace, tool:string, args:Record<string,unknown>, cwd:string,
  root:string, files:SecurityFile[], paths:SecurityPath[], policy:SecurityPolicy,
  incomplete?:boolean}.
SecurityFinding = {ruleId:string, category:SecurityCategory,
  severity:'critical'|'high'|'medium'|'low', confidence:'high'|'medium'|'low',
  message:string, remediation:string, location?:{path?:string,line?:number,column?:number}}.
SecurityDecision = {decision:'allow'|'warn'|'deny'|'unavailable',
  coverage:'complete'|'partial'|'unsupported', findings:SecurityFinding[],
  policyVersion:string, diagnostics:string[]}.
SecuritySanitizeParams = {namespace, fields:string[], policy:SecurityPolicy}.
SecuritySanitizeResult = {fields:string[], redactions:number,
  coverage:'complete'|'partial'|'unsupported', policyVersion:string}.
Core exports evaluateTool(params):Promise<SecurityDecision>,
sanitizeFields(params):SecuritySanitizeResult, defaultSecurityPolicy():SecurityPolicy.
Core modules do not access filesystem/process/network. Parser WASM assets are
loaded by the parser initialization boundary; no source or tool execution.
VsecClient.create({dataDir,entry?,timeoutMs?,maxQueuedRequests?,maxQueuedBytes?})
returns client with evaluateTool, sanitize, health, shutdown. Transport failures
throw VsecUnavailableError with a safe reason. Callers implement failure policy.
Health includes pid, protocol, uptimeMs, cacheBytes, cacheHits, serviceMs, rssBytes.
