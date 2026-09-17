import type { SecurityCategory, SecurityFinding } from "@bluecode/contracts"

/** Internal source spans never cross the public decision boundary. */
export interface Hit {
  ruleId: string
  category: SecurityCategory
  severity: SecurityFinding["severity"]
  confidence: SecurityFinding["confidence"]
  start: number
  end: number
  identity: string
}
export interface Scan { hits: Hit[]; partial: boolean }
export function hit(category: SecurityCategory, suffix: string, start: number, end: number, identity: string, severity: Hit["severity"] = "high"): Hit {
  return { ruleId: `${category}.${suffix}`, category, severity, confidence: "high", start, end, identity }
}
export const guidance: Record<SecurityCategory, [string, string]> = {
  credential: ["Credential material detected.", "Use a secret store or environment reference and rotate exposed credentials."],
  "dangerous-command": ["A destructive or remotely sourced executable operation was detected.", "Use a scoped, reviewed operation and verify the target before execution."],
  "sensitive-file": ["This operation targets a sensitive file.", "Use a public example or an explicitly scoped, expiring exception."],
  "path-traversal": ["The resolved target is outside the allowed project boundary.", "Use a canonical path inside the project or an explicitly scoped exception."],
  "dynamic-execution": ["Dynamic input reaches an executable code sink.", "Use structured APIs with fixed code and separate data arguments."],
  "sql-injection": ["Dynamic string construction reaches a SQL execution sink.", "Use parameterized statements with bound values."],
  xss: ["Dynamic markup reaches an HTML execution sink.", "Use text nodes or a reviewed HTML sanitizer."],
  "weak-crypto": ["A weak cryptographic primitive or security parameter was detected.", "Use current cryptographic primitives, random nonces and adequate key strength."],
}
