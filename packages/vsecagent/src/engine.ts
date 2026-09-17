import { evaluateTool, sanitizeFields } from "@bluecode/security-core"
import {
  securityDecisionSchema, securitySanitizeResultSchema, securityEvaluateParamsSchema, securitySanitizeParamsSchema,
  type SecurityDecision, type SecuritySanitizeResult,
} from "@bluecode/contracts"
import { BoundedCache, cacheKey, PARSER_VERSION } from "./cache"
import { SafeAudit } from "./audit"
import { callFirewall, callRedactor, type AdapterErrorCategory, type FirewallAdapter, type RedactionAdapter } from "./adapters"
import { boundedInput, type VsecHealth, type VsecRequest, type VsecTiming } from "./protocol"
export interface EngineOptions {
  dataDir: string; cacheBytes?: number; auditMaxBytes?: number; auditFiles?: number
  firewall?: FirewallAdapter; redactor?: RedactionAdapter; providerTimeoutMs?: number
}
type ScanResult = SecurityDecision | SecuritySanitizeResult
export type VsecResponse = { protocol: 1; id: string; ok: true; result: ScanResult | VsecHealth; timing: VsecTiming } | { protocol: 1; id: string; ok: false; error: "service" | "input"; timing: VsecTiming }
function combine(local: SecurityDecision, external: SecurityDecision): SecurityDecision {
  const decisions = [local.decision, external.decision]
  return { ...local,
    decision: decisions.includes("deny") ? "deny" : decisions.includes("unavailable") ? "unavailable" : decisions.includes("warn") ? "warn" : "allow",
    coverage: local.coverage === "complete" && external.coverage === "complete" ? "complete" : local.coverage === "unsupported" ? "unsupported" : "partial",
    findings: [...local.findings, ...external.findings], diagnostics: [...local.diagnostics, ...external.diagnostics],
  }
}
export class VsecEngine {
  private readonly started = performance.now()
  private serviceMs = 0
  private constructor(private readonly cache: BoundedCache, private readonly audit: SafeAudit, private readonly options: EngineOptions) {}
  static async create(options: EngineOptions): Promise<VsecEngine> {
    const audit = await SafeAudit.create({ dataDir: options.dataDir, ...(options.auditMaxBytes === undefined ? {} : { maxBytes: options.auditMaxBytes }), ...(options.auditFiles === undefined ? {} : { files: options.auditFiles }) })
    const scanner = new VsecEngine(new BoundedCache(options.cacheBytes), audit, options)
    const namespace = { projectId: "warm", sessionId: "warm" }
    const policy = { version: "vsec-1", exceptions: [], deniedPaths: [], mcpTools: {} }
    const warm = await evaluateTool({ namespace, policy, tool: "bash", args: { command: "printf warm" }, cwd: "/", root: "/", files: [{ path: "warm.ts", content: "const warm = true", complete: true }], paths: [] })
    if (warm.coverage !== "complete") throw new Error("scanner-unavailable")
    return scanner
  }
  health(): VsecHealth { return { pid: process.pid, protocol: 1, uptimeMs: performance.now() - this.started, cacheBytes: this.cache.bytes, cacheHits: this.cache.hits, serviceMs: this.serviceMs, rssBytes: process.memoryUsage().rss } }
  async request(request: VsecRequest): Promise<VsecResponse> {
    const start = performance.now(), startedAt = Date.now()
    if (request.op === "health") return { protocol: 1, id: request.id, ok: true, result: this.health(), timing: { requestId: request.id, queueMs: request.queueMs, serviceMs: 0, policyVersion: "vsec-1" } }
    let policyVersion = "invalid-policy"
    let safePolicyVersion = "invalid-policy"
    let failureCategory: "input" | "service" = "input"
    try {
      if (!boundedInput(request.params)) throw new Error("input")
      const parsed = request.op === "sanitize" ? securitySanitizeParamsSchema.safeParse(request.params) : securityEvaluateParamsSchema.safeParse(request.params)
      if (!parsed.success) throw new Error("input")
      const params = parsed.data
      policyVersion = params.policy.version
      safePolicyVersion = sanitizeFields({ namespace: params.namespace, policy: params.policy, fields: [] }).policyVersion
      failureCategory = "service"
      // Capture before any awaited adapter work: an exception expiring mid-scan must never turn into an infinite TTL.
      const expiry = Math.min(Infinity, ...params.policy.exceptions.map(e => Date.parse(e.expiresAt)).filter(date => date > startedAt))
      const key = cacheKey(request.op, params, JSON.stringify([PARSER_VERSION, this.options.firewall?.version, this.options.redactor?.version]))
      let result = this.cache.get<ScanResult>(key)
      let errorCategory: AdapterErrorCategory | undefined
      if (!result) {
        if ("fields" in params) {
          result = sanitizeFields(params)
          if (this.options.redactor) {
            const external = await callRedactor(this.options.redactor, params, this.options.providerTimeoutMs)
            if (external.ok) result = external.value
            else {
              errorCategory = external.errorCategory
              result = { fields: params.fields.map(() => "[Security sanitization unavailable: content withheld]"), redactions: 0, coverage: "unsupported", policyVersion: result.policyVersion }
            }
          }
        } else {
          result = await evaluateTool(params)
          if (this.options.firewall) {
            const external = await callFirewall(this.options.firewall, params, this.options.providerTimeoutMs)
            if (expiry <= Date.now()) result = await evaluateTool(params)
            if (external.ok) result = combine(result, external.value)
            else {
              errorCategory = external.errorCategory
              result = { decision: "unavailable", coverage: "unsupported", findings: [], policyVersion: result.policyVersion, diagnostics: [external.errorCategory] }
            }
          }
        }
        if (!boundedInput(result) || !("fields" in result ? securitySanitizeResultSchema.safeParse(result) : securityDecisionSchema.safeParse(result)).success) throw new Error("service")
        if (result.coverage !== "unsupported" && !("decision" in result && result.decision === "unavailable")) this.cache.set(key, result, expiry)
      }
      this.serviceMs = performance.now() - start
      await this.audit.write({ requestId: request.id, operation: request.op, decision: "decision" in result ? result.decision : result.coverage === "unsupported" ? "unavailable" : "sanitized", policyVersion,
        queueMs: request.queueMs, serviceMs: this.serviceMs, ...("findings" in result ? { findings: result.findings } : {}), ...(errorCategory ? { errorCategory } : {}) })
      return { protocol: 1, id: request.id, ok: true, result, timing: { requestId: request.id, queueMs: request.queueMs, serviceMs: performance.now() - start, policyVersion: result.policyVersion } }
    } catch {
      try { await this.audit.write({ requestId: request.id, operation: request.op, decision: "unavailable", policyVersion, queueMs: request.queueMs, serviceMs: performance.now() - start, errorCategory: failureCategory }) } catch {}
      return { protocol: 1, id: request.id, ok: false, error: failureCategory, timing: { requestId: request.id, queueMs: request.queueMs, serviceMs: performance.now() - start, policyVersion: safePolicyVersion } }
    }
  }
}
