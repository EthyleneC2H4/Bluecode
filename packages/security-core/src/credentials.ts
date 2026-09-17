import { hit, type Hit } from "./model"

export interface SecretSpan { start: number; end: number; kind: string; critical: boolean }
const placeholders = /^(?:\[REDACTED\]|\*+|x+|your[_ -].*|<[^>]+>|\$\{[^}]+\}|(?:test|example|dummy|fake|sample|placeholder|changeme|change_me|replace_me)(?:[_ -].*)?|undefined|null|none)$/i
function real(value: string): boolean {
  return value.length >= 8 && !/^(.)\1{7,}$/.test(value) && !placeholders.test(value) && !value.startsWith("[REDACTED") && !value.startsWith("${") && !/^process\.env\.|^os\.environ|^env\./.test(value)
}
// Only explicit sensitive assignments with long, diverse literal values receive
// critical severity. Entropy is evidence of a secret, not proof of validity.
function strongLiteral(value: string): boolean {
  if (value.length < 20 || /\s/.test(value)) return false
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(re => re.test(value)).length
  if (classes < 3) return false
  const counts = new Map<string, number>()
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) { const p = count / value.length; entropy -= p * Math.log2(p) }
  return counts.size >= 12 && entropy >= 3.5
}
/** Exact token formats and contextual assignments; no remote credential validation. */
export function secretSpans(text: string): SecretSpan[] {
  const spans: SecretSpan[] = []
  const add = (start: number, value: string, kind: string, critical: boolean) => {
    if (real(value)) spans.push({ start, end: start + value.length, kind, critical })
  }
  const formats: Array<[RegExp, string]> = [
    [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, "github"],
    [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, "github"],
    [/\bsk-(?:proj-|ant-api\d{2}-|live_)?[A-Za-z0-9_-]{20,}\b/g, "api-token"],
    [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "aws"],
    [/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, "slack"],
    [/\bAIza[A-Za-z0-9_-]{30,50}\b/g, "google"],
    [/\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g, "payment"],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/g, "jwt"],
  ]
  for (const [pattern, kind] of formats) for (const match of text.matchAll(pattern)) add(match.index!, match[0], kind, true)
  // Private key markers are included; public keys are deliberately excluded.
  for (const match of text.matchAll(/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|$)/g)) add(match.index!, match[0], "private-key", true)
  for (const match of text.matchAll(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|https?):\/\/[^\s/:@]+:([^\s/@]+)@/gi)) {
    const value = match[1]!
    add(match.index! + match[0].lastIndexOf(value + "@"), value, "connection-password", true)
  }
  // Scan values linearly: nested escaped-string regexes can silently stop matching
  // on large valid fields near the 1 MiB boundary in JavaScriptCore.
  const assignment = /\b(?:api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd|token|secret|aws_secret_access_key)\b["']?\s*[:=]\s*/gi
  let match: RegExpExecArray | null
  while ((match = assignment.exec(text))) {
    const quote = text[assignment.lastIndex]
    const quoted = quote === '"' || quote === "'"
    const start = assignment.lastIndex + (quoted ? 1 : 0)
    let end = start
    while (end < text.length) {
      const ch = text[end]!
      if (quoted) {
        if (ch === quote || ch === "\r" || ch === "\n") break
        if (ch === "\\" && end + 1 < text.length && !/[\r\n]/.test(text[end + 1]!)) { end += 2; continue }
      } else if (/[\s,;\]}]/.test(ch)) break
      end++
    }
    assignment.lastIndex = Math.max(assignment.lastIndex, end + (quoted && text[end] === quote ? 1 : 0))
    const value = text.slice(start, end)
    const sourceAssignment = /(?:const|let|var)\s+$/.test(text.slice(Math.max(0, match.index - 16), match.index))
    if (!quoted && sourceAssignment && /^[A-Za-z_$][\w$]*(?:\.|\(|$)/.test(value)) continue
    if (!quoted && /^(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\(/.test(value)) continue
    add(start, value, "assignment", strongLiteral(value))
  }
  for (const match of text.matchAll(/\b(?:Bearer|Basic)\s+([A-Za-z0-9_+/.=-]{16,})/g)) add(match.index! + match[0].length - match[1]!.length, match[1]!, "authorization", true)
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: SecretSpan[] = []
  for (const span of spans) {
    const previous = merged.at(-1)
    if (previous && span.start < previous.end) {
      previous.end = Math.max(previous.end, span.end)
      previous.critical ||= span.critical
      if (span.critical) previous.kind = span.kind
    } else merged.push({ ...span })
  }
  return merged
}
export function credentialHits(text: string): Hit[] {
  return secretSpans(text).map(s => hit("credential", s.kind, s.start, s.end, text.slice(s.start, s.end), s.critical ? "critical" : "high"))
}
export function redact(text: string): { text: string; count: number } {
  const spans = secretSpans(text)
  let result = "", cursor = 0
  for (const span of spans) {
    result += text.slice(cursor, span.start)
    // Replacing each nonempty line independently preserves CRLF as well as LF.
    result += text.slice(span.start, span.end).replace(/[^\r\n]+/g, "[REDACTED]")
    cursor = span.end
  }
  return { text: result + text.slice(cursor), count: spans.length }
}
