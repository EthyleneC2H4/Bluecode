/** Offline security boundary: bounded payloads and secret-free decisions. */
import { z } from "zod"

export const VSEC_PROTOCOL_VERSION = 1
export const SECURITY_MAX_TEXT_BYTES = 1024 * 1024
export const securityTextSchema = z.string().max(SECURITY_MAX_TEXT_BYTES).refine(
  value => new TextEncoder().encode(value).byteLength <= SECURITY_MAX_TEXT_BYTES,
  "Security text exceeds the byte limit",
)
const identifier = z.string().min(1).max(512)
const path = z.string().max(4096)
export const securityCategorySchema = z.enum(["credential", "dangerous-command", "sensitive-file", "path-traversal", "dynamic-execution", "sql-injection", "xss", "weak-crypto"])
export type SecurityCategory = z.infer<typeof securityCategorySchema>
export const securityNamespaceSchema = z.object({ projectId: identifier, sessionId: identifier })
export type SecurityNamespace = z.infer<typeof securityNamespaceSchema>
export const securityExceptionSchema = z.object({ ruleId: identifier, scope: path.min(1), reason: z.string().min(1).max(2048), expiresAt: z.iso.datetime({ offset: true }) })
export type SecurityException = z.infer<typeof securityExceptionSchema>
export const securityPolicySchema = z.object({
  version: identifier.default("vsec-1"),
  exceptions: z.array(securityExceptionSchema).max(1024).default([]),
  deniedPaths: z.array(path).max(1024).default([]),
  mcpTools: z.record(identifier, z.object({ operation: z.enum(["read", "write", "execute", "unknown"]), pathFields: z.array(identifier).max(64), contentFields: z.array(identifier).max(64) })).default({}),
})
export type SecurityPolicy = z.infer<typeof securityPolicySchema>
export const securityFileSchema = z.object({ path, content: securityTextSchema, before: securityTextSchema.optional(), complete: z.boolean() })
export type SecurityFile = z.infer<typeof securityFileSchema>
export const securityPathSchema = z.object({ path, resolvedPath: path, operation: z.enum(["read", "write", "delete"]) })
export type SecurityPath = z.infer<typeof securityPathSchema>
export const securityEvaluateParamsSchema = z.object({
  namespace: securityNamespaceSchema, tool: identifier, args: z.record(z.string(), z.unknown()), cwd: path, root: path,
  files: z.array(securityFileSchema).max(256), paths: z.array(securityPathSchema).max(1024), policy: securityPolicySchema,
  incomplete: z.boolean().optional(),
})
export type SecurityEvaluateParams = z.infer<typeof securityEvaluateParamsSchema>
export const securityFindingSchema = z.object({
  ruleId: identifier, category: securityCategorySchema, severity: z.enum(["critical", "high", "medium", "low"]),
  confidence: z.enum(["high", "medium", "low"]), message: z.string().max(2048), remediation: z.string().max(2048),
  location: z.object({ path: path.optional(), line: z.number().int().positive().optional(), column: z.number().int().positive().optional() }).optional(),
})
export type SecurityFinding = z.infer<typeof securityFindingSchema>
export const securityCoverageSchema = z.enum(["complete", "partial", "unsupported"])
export const securityDecisionSchema = z.object({
  decision: z.enum(["allow", "warn", "deny", "unavailable"]), coverage: securityCoverageSchema,
  findings: z.array(securityFindingSchema).max(4096), policyVersion: identifier, diagnostics: z.array(z.string().max(512)).max(256),
})
export type SecurityDecision = z.infer<typeof securityDecisionSchema>
export const securitySanitizeParamsSchema = z.object({ namespace: securityNamespaceSchema, fields: z.array(securityTextSchema).max(1024), policy: securityPolicySchema })
export type SecuritySanitizeParams = z.infer<typeof securitySanitizeParamsSchema>
export const securitySanitizeResultSchema = z.object({ fields: z.array(securityTextSchema).max(1024), redactions: z.number().int().nonnegative(), coverage: securityCoverageSchema, policyVersion: identifier })
export type SecuritySanitizeResult = z.infer<typeof securitySanitizeResultSchema>
