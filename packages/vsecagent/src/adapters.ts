/** Vendor-neutral SDK interfaces. No HTTP, credentials, endpoints or enterprise contract assumptions. */
import {
  securityDecisionSchema, securitySanitizeResultSchema,
  type SecurityDecision, type SecurityEvaluateParams, type SecuritySanitizeParams, type SecuritySanitizeResult,
} from "@bluecode/contracts"
import { sanitizeFields } from "@bluecode/security-core/sanitize"
import { boundedInput } from "./protocol"
export interface AdapterContext { signal: AbortSignal }
export interface FirewallAdapter { version: string; evaluate(params: SecurityEvaluateParams, context: AdapterContext): Promise<unknown> }
export interface RedactionAdapter { version: string; sanitize(params: SecuritySanitizeParams, context: AdapterContext): Promise<unknown> }
export type AdapterErrorCategory = "adapter-timeout" | "adapter-error" | "adapter-malformed"
export type AdapterResult<T> = { ok: true; value: T } | { ok: false; errorCategory: AdapterErrorCategory }
async function invoke(call: (context: AdapterContext) => Promise<unknown>, timeoutMs: number): Promise<AdapterResult<unknown>> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<AdapterResult<unknown>>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve({ ok: false, errorCategory: "adapter-timeout" }) }, Math.max(1, timeoutMs))
  })
  const operation = Promise.resolve().then(() => call({ signal: controller.signal })).then(
    value => ({ ok: true as const, value }),
    () => ({ ok: false as const, errorCategory: "adapter-error" as const }),
  )
  try { return await Promise.race([timeout, operation]) } finally { clearTimeout(timer) }
}
export async function callRedactor(adapter: RedactionAdapter, params: SecuritySanitizeParams, timeoutMs = 250): Promise<AdapterResult<SecuritySanitizeResult>> {
  const result = await invoke(context => adapter.sanitize(params, context), timeoutMs)
  if (!result.ok) return result
  if (!boundedInput(result.value)) return { ok: false, errorCategory: "adapter-malformed" }
  const parsed = securitySanitizeResultSchema.safeParse(result.value)
  if (!parsed.success || parsed.data.fields.length !== params.fields.length || parsed.data.coverage !== "complete") return { ok: false, errorCategory: "adapter-malformed" }
  const local = sanitizeFields({ ...params, fields: parsed.data.fields })
  if (local.coverage !== "complete") return { ok: false, errorCategory: "adapter-malformed" }
  return { ok: true, value: { ...local, redactions: local.redactions + parsed.data.redactions } }
}
export async function callFirewall(adapter: FirewallAdapter, params: SecurityEvaluateParams, timeoutMs = 250): Promise<AdapterResult<SecurityDecision>> {
  const result = await invoke(context => adapter.evaluate(params, context), timeoutMs)
  if (!result.ok) return result
  if (!boundedInput(result.value)) return { ok: false, errorCategory: "adapter-malformed" }
  const parsed = securityDecisionSchema.safeParse(result.value)
  if (!parsed.success || parsed.data.decision === "unavailable" || parsed.data.coverage === "unsupported") return { ok: false, errorCategory: "adapter-malformed" }
  const value = parsed.data
  const policyVersion = sanitizeFields({ namespace: params.namespace, policy: params.policy, fields: [] }).policyVersion
  return { ok: true, value: {
    decision: value.findings.some(f => f.severity === "critical" && f.confidence === "high") ? "deny" : value.decision,
    coverage: value.coverage, policyVersion, diagnostics: value.coverage === "partial" ? ["external-firewall-partial"] : [],
    findings: value.findings.map(f => ({ ruleId: `external-firewall.${f.category}`, category: f.category, severity: f.severity, confidence: f.confidence,
      message: "The configured firewall detected a security risk.", remediation: "Review the operation against the configured firewall policy.",
      ...(f.location ? { location: { ...(f.location.line === undefined ? {} : { line: f.location.line }), ...(f.location.column === undefined ? {} : { column: f.location.column }) } } : {}),
    })),
  } }
}
