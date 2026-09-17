import { securitySanitizeParamsSchema, type SecuritySanitizeParams, type SecuritySanitizeResult } from "@bluecode/contracts"
import { redact } from "./credentials"
import { texts, version } from "./bounds"
const unavailableText = "[Security sanitization unavailable: content withheld]"

export function sanitizeFields(params: SecuritySanitizeParams): SecuritySanitizeResult {
  const validation = securitySanitizeParamsSchema.safeParse(params)
  const policyVersion = version(params?.policy)
  if (!validation.success || !texts(params)) {
    const length = Array.isArray(params?.fields) ? Math.min(params.fields.length, 1024) : 1
    return { fields: Array.from({ length }, () => unavailableText), redactions: 0, coverage: "unsupported", policyVersion }
  }
  let redactions = 0
  const fields = validation.data.fields.map(field => {
    const result = redact(field)
    redactions += result.count
    return result.text
  })
  return { fields, redactions, coverage: "complete", policyVersion }
}
