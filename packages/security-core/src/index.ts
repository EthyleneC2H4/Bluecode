import {
  securityEvaluateParamsSchema, securityPolicySchema,
  type SecurityEvaluateParams, type SecurityDecision, type SecurityPolicy, type SecurityFinding,
} from "@bluecode/contracts"
import { credentialHits, redact } from "./credentials"
import { guidance, hit, type Hit } from "./model"
import { normalizePath, within, sensitivePath } from "./paths"
import { scanTypeScript } from "./typescript"
import { scanBash } from "./bash"
import { texts, version } from "./bounds"
export { sanitizeFields } from "./sanitize"

export function defaultSecurityPolicy(): SecurityPolicy { return securityPolicySchema.parse({}) }
function excepted(hit: Hit, path: string | undefined, params: SecurityEvaluateParams): boolean {
  return params.policy.exceptions.some(ex => ex.ruleId === hit.ruleId && ex.reason.trim().length > 0
    && Date.parse(ex.expiresAt) > Date.now()
    && (ex.scope === "*" || ex.scope === `tool:${params.tool}` || !!path && ex.scope.startsWith("/") && within(path, ex.scope.replace(/\/\*\*$/, ""))))
}
function safeFinding(h: Hit, text: string, path?: string): SecurityFinding {
  const [message, remediation] = guidance[h.category]
  const prefix = text.slice(0, h.start)
  const line = prefix.split("\n").length
  const column = h.start - prefix.lastIndexOf("\n")
  return { ruleId: h.ruleId, category: h.category, severity: h.severity, confidence: h.confidence,
    message, remediation, location: { ...(path ? { path: redact(path).text } : {}), line, column } }
}
async function sourceHits(content: string, path: string, root: string): Promise<{ hits: Hit[]; partial: boolean }> {
  const hits = credentialHits(content)
  if (/\.[cm]?[jt]sx?$/i.test(path)) {
    const ast = scanTypeScript(content, path)
    return { hits: [...hits, ...ast.hits], partial: ast.partial }
  }
  if (/\.(?:sh|bash|zsh)$/.test(path) || /^#!\s*\/(?:usr\/bin\/env\s+)?(?:bin\/)?(?:ba|z|da|k)?sh\b/.test(content)) {
    const ast = await scanBash(content, root)
    return { hits: [...hits, ...ast.hits], partial: ast.partial }
  }
  // Text and configuration receive credential scanning; executable unsupported languages disclose gaps.
  return { hits, partial: /\.(?:py|rb|php|java|go|rs|c|cpp|cs|ps1|bat)$/i.test(path) }
}
export async function evaluateTool(params: SecurityEvaluateParams): Promise<SecurityDecision> {
  const policyVersion = version(params?.policy)
  const unavailable = (): SecurityDecision => ({ decision: "unavailable", coverage: "unsupported", findings: [], policyVersion, diagnostics: ["invalid-or-unscannable-input"] })
  // Validate total cost before invoking parsers, without logging rejected values or zod errors.
  if (!texts(params)) return unavailable()
  const validation = securityEvaluateParamsSchema.safeParse(params)
  if (!validation.success) return unavailable()
  const p = validation.data
  const findings: SecurityFinding[] = []
  const diagnostics = new Set<string>()
  let partial = !!p.incomplete
  const append = (h: Hit, text: string, path?: string) => {
    if (!excepted(h, path, p)) findings.push(safeFinding(h, text, path))
    else diagnostics.add("policy-exception-applied")
  }
  try {
    for (const file of p.files) {
      partial ||= !file.complete
      const scan = await sourceHits(file.content, file.path, p.root)
      partial ||= scan.partial
      const previous = new Map<string, number>()
      if (file.before !== undefined && file.complete) {
        const before = await sourceHits(file.before, file.path, p.root)
        partial ||= before.partial
        for (const h of before.hits) { const key = h.ruleId + "\0" + h.identity; previous.set(key, (previous.get(key) ?? 0) + 1) }
      }
      for (const h of scan.hits) {
        const key = h.ruleId + "\0" + h.identity, count = previous.get(key) ?? 0
        if (count > 0) {
          previous.set(key, count - 1)
          diagnostics.add("existing-findings")
          append({ ...h, severity: h.severity === "critical" ? "high" : h.severity }, file.content, file.path)
        } else append(h, file.content, file.path)
      }
    }
    // Exact candidate/before pairs are the authoritative evidence for these fields.
    // Removed edit/patch text must not be mistaken for newly introduced material.
    const representedFields: Record<string, string[]> = {
      write: ["content", "text"], write_file: ["content", "text"],
      edit: ["oldString", "newString", "old_string", "new_string"],
      apply_patch: ["patch", "patchText", "patch_text"],
    }
    const excluded = p.files.length ? representedFields[p.tool] ?? [] : []
    const argsText = texts(Object.fromEntries(Object.entries(p.args).filter(([key]) => !excluded.includes(key))))!
    for (const text of argsText) for (const h of credentialHits(text)) {
      // File candidates already provide exact before/after evidence for writes.
      if (!p.files.some(f => f.content === text || f.before === text)) append(h, text)
    }
    for (const target of p.paths) {
      if (!target.resolvedPath.startsWith("/") || target.resolvedPath.includes("\0")) return unavailable()
      if (!within(target.resolvedPath, p.root)) append(hit("path-traversal", "outside-root", 0, 0, target.resolvedPath, "critical"), "", target.resolvedPath)
      if (p.policy.deniedPaths.some(denied => within(target.resolvedPath, denied))) append(hit("sensitive-file", "policy-path", 0, 0, target.resolvedPath, "critical"), "", target.resolvedPath)
      if (sensitivePath(target.resolvedPath)) append(hit("sensitive-file", "protected-path", 0, 0, target.resolvedPath, "critical"), "", target.resolvedPath)
    }
    if (/^(?:bash|shell|exec|execute|terminal)$/.test(p.tool)) {
      const command = p.args.command ?? p.args.script
      if (typeof command !== "string") partial = true
      else {
        const scan = await scanBash(command, p.root, 0, p.cwd)
        partial ||= scan.partial
        for (const h of scan.hits) append(h, command)
      }
    } else if (!/^(?:read|write|edit|apply_patch|glob|grep|ls|list|read_file|write_file)$/.test(p.tool)) {
      const mapping = p.policy.mcpTools[p.tool]
      if (!mapping || mapping.operation === "unknown" || mapping.operation === "execute") partial = true
    }
    if (partial) diagnostics.add("partial-analysis")
    if (findings.length > 4096) return unavailable()
    const decision = findings.some(f => f.severity === "critical" && f.confidence === "high") ? "deny" : findings.length ? "warn" : "allow"
    return { decision, coverage: partial ? "partial" : "complete", findings, policyVersion, diagnostics: [...diagnostics] }
  } catch {
    return unavailable()
  }
}
