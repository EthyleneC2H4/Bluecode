import { appendFile, chmod, lstat, mkdir, rename, stat, unlink } from "node:fs/promises"
import { constants } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import type { SecurityFinding } from "@bluecode/contracts"
import { requestId } from "./protocol"
const ruleIds = new Set([
  ...["github", "api-token", "aws", "slack", "google", "payment", "jwt", "private-key", "connection-password", "assignment", "authorization"].map(s => `credential.${s}`),
  ...["recursive-delete", "disk-destruction", "disk-overwrite", "system-permissions", "world-writable", "download-execute", "sensitive-overwrite"].map(s => `dangerous-command.${s}`),
  ...["code-string", "vm-code", "shell-string", "timer-string"].map(s => `dynamic-execution.${s}`),
  ...["html-call", "jquery-html", "html-assignment", "react-html"].map(s => `xss.${s}`),
  ...["weak-digest", "weak-cipher", "legacy-cipher", "fixed-iv", "low-kdf-cost", "short-rsa-key", "predictable-secret"].map(s => `weak-crypto.${s}`),
  "path-traversal.outside-root", "sensitive-file.policy-path", "sensitive-file.protected-path", "sql-injection.constructed-query",
])
export interface AuditRecord {
  requestId: string
  operation: "evaluate" | "sanitize" | "health"
  decision: "allow" | "warn" | "deny" | "unavailable" | "sanitized"
  policyVersion: string
  queueMs: number
  serviceMs: number
  findings?: SecurityFinding[]
  errorCategory?: "input" | "service" | "adapter-timeout" | "adapter-error" | "adapter-malformed"
}
export interface AuditOptions { dataDir: string; maxBytes?: number; files?: number }
/** Explicit field projection prevents accidental raw-evidence persistence. */
export class SafeAudit {
  private chain: Promise<void> = Promise.resolve()
  private constructor(private readonly directory: string, private readonly maxBytes: number, private readonly files: number) {}
  static async create(options: AuditOptions): Promise<SafeAudit> {
    const directory = join(options.dataDir, "audit")
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (!(await lstat(directory)).isDirectory()) throw new Error("audit-unavailable")
    await chmod(directory, 0o700)
    return new SafeAudit(directory, Math.max(512, Math.min(options.maxBytes ?? 1024 * 1024, 1024 * 1024)), Math.max(1, Math.min(options.files ?? 3, 3)))
  }
  write(record: AuditRecord): Promise<void> {
    const operation = ["evaluate", "sanitize", "health"].includes(record.operation) ? record.operation : "health"
    const decision = ["allow", "warn", "deny", "unavailable", "sanitized"].includes(record.decision) ? record.decision : "unavailable"
    const metadata = {
      requestId: requestId(record.requestId) ? record.requestId : "invalid-request-id",
      operation, decision,
      policyFingerprint: createHash("sha256").update(record.policyVersion).digest("hex"),
      protocol: 1, policyEngine: "vsec-1", parser: "ts5.9.3/bash0.25.0",
      queueMs: Number.isFinite(record.queueMs) ? Math.max(0, record.queueMs) : 0,
      serviceMs: Number.isFinite(record.serviceMs) ? Math.max(0, record.serviceMs) : 0,
      errorCategory: record.errorCategory && ["input", "service", "adapter-timeout", "adapter-error", "adapter-malformed"].includes(record.errorCategory) ? record.errorCategory : undefined,
      findings: (record.findings ?? []).slice(0, 16).map(f => ({
        ruleId: ruleIds.has(f.ruleId) ? f.ruleId : "external-rule",
        ...(Number.isSafeInteger(f.location?.line) && f.location!.line! > 0 ? { line: f.location!.line } : {}),
        ...(Number.isSafeInteger(f.location?.column) && f.location!.column! > 0 ? { column: f.location!.column } : {}),
      })),
    }
    let line = JSON.stringify(metadata) + "\n"
    if (Buffer.byteLength(line) > this.maxBytes) line = JSON.stringify({ ...metadata, findings: [], findingsOmitted: true }) + "\n"
    const next = this.chain.then(() => this.append(line))
    this.chain = next.catch(() => {})
    return next
  }
  private async append(line: string): Promise<void> {
    const current = join(this.directory, "vsec.0.jsonl")
    let size = 0
    try { size = (await stat(current)).size } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    if (size + Buffer.byteLength(line) > this.maxBytes) {
      for (let index = this.files - 1; index >= 0; index--) {
        const source = join(this.directory, `vsec.${index}.jsonl`)
        try {
          if (index === this.files - 1) await unlink(source)
          else await rename(source, join(this.directory, `vsec.${index + 1}.jsonl`))
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      }
    }
    await appendFile(current, line, { encoding: "utf8", mode: 0o600, flag: constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW })
    await chmod(current, 0o600)
  }
}
