/** Security runs independently of compression, with explicit fail-closed evidence. */
import { createHash } from "node:crypto"
import path from "node:path"
import type { SecurityDecision, SecurityEvaluateParams, SecuritySanitizeParams, SecuritySanitizeResult } from "@bluecode/contracts"
import type { PluginOptions } from "./config"
import { prepareTool, toolOperation } from "./security-tools"

export const WITHHELD = "[VSecAgent: security inspection unavailable; content withheld]"
export interface SecurityPort {
  evaluateTool(input: SecurityEvaluateParams): Promise<SecurityDecision>
  sanitize(input: SecuritySanitizeParams): Promise<SecuritySanitizeResult>
  shutdown(): Promise<void>
}
export class SecurityBlockedError extends Error {
  constructor(reason: string) { super(`VSecAgent blocked this tool call: ${reason}`); this.name = "SecurityBlockedError" }
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]))
  return value
}
export function securityFingerprint(options: PluginOptions): string {
  return createHash("sha256").update(JSON.stringify(stable({ format: "vsec-1", policy: options.security.policy }))).digest("hex")
}
export function securityDataDir(options: PluginOptions): string {
  return options.security.mode === "off" ? options.dataDir : path.join(options.dataDir, "security-v1", securityFingerprint(options))
}

export function createSecurityGuard(input: {
  projectId: string; directory: string; root?: string; options: PluginOptions; port: () => SecurityPort | null | undefined
}) {
  const { options } = input
  const enabled = () => options.enabled && options.security.mode !== "off"
  const stats = { scans: 0, denied: 0, warned: 0, unavailable: 0, withheld: 0, redactions: 0, opaqueParts: 0 }
  const pending = new Map<string, SecurityDecision>()
  async function strings(sessionId: string, values: string[]): Promise<string[]> {
    if (!enabled()) return values
    const result: string[] = []
    // Sequential bounded batches avoid treating a long session as one giant field.
    for (let start = 0; start < values.length; ) {
      let bytes = 0
      const batch: string[] = []
      while (start < values.length && batch.length < 64) {
        const value = values[start]!, size = Buffer.byteLength(value)
        if (size > 1024 ** 2) {
          if (batch.length) break
          result.push(WITHHELD); stats.withheld++; start++; continue
        }
        if (batch.length && bytes + size > 2 * 1024 ** 2) break
        batch.push(value); bytes += size; start++
      }
      if (!batch.length) continue
      try {
        const port = input.port()
        if (!port) throw new Error("unavailable")
        const response = await port.sanitize({ namespace: { projectId: input.projectId, sessionId },
          fields: batch, policy: options.security.policy })
        if (response.coverage !== "complete" || response.fields.length !== batch.length ||
            response.fields.some(value => typeof value !== "string")) throw new Error("incomplete")
        result.push(...response.fields); stats.redactions += response.redactions
      } catch {
        stats.unavailable++; stats.withheld += batch.length
        result.push(...batch.map(() => WITHHELD))
      }
    }
    return result
  }
  async function object<T>(sessionId: string, value: T, preserveCursor = false, hostMessages = false): Promise<T> {
    if (!enabled()) return value
    const clone = structuredClone(value)
    const leaves: Array<{ parent: any; key: string | number; text: string; contextual?: boolean }> = []
    const keys: Array<{ parent: any; key: string }> = []
    const wrapper: any = { value: clone }
    const walk = (parent: any, key: string | number, depth: number, context = "generic") => {
      const item = parent[key]
      if (typeof item === "string") {
        // Content discriminators are protocol, not user-controlled evidence.
        const discriminator = key === "type" && ["text", "tool", "reasoning", "step-start", "step-finish", "compaction"].includes(item)
        const routing = context === "info" && ["id", "role", "sessionID", "parentID", "modelID", "providerID"].includes(String(key)) ||
          context === "part" && ["id", "type", "sessionID", "messageID", "tool", "callID"].includes(String(key)) ||
          context === "state" && key === "status"
        if (!routing && !discriminator && !(preserveCursor && key === "nextCursor")) {
          const contextual = /^(?:api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd|token|secret|aws_secret_access_key)$/i.test(String(key))
          leaves.push({ parent, key, text: contextual ? JSON.stringify({ [key]: item }) : item, contextual })
        }
      } else if (item && typeof item === "object") {
        if (depth > 64 || leaves.length > 20_000) { parent[key] = WITHHELD; stats.withheld++; return }
        // Binary/unknown host parts retain their shape; count the coverage gap.
        if (typeof item.type === "string" && (["image", "file", "audio", "resource_link"].includes(item.type) ||
            context === "part" && !["text", "tool", "reasoning", "step-start", "step-finish", "compaction"].includes(item.type))) { stats.opaqueParts++; return }
        for (const child of Object.keys(item)) {
          if (!Array.isArray(item)) keys.push({ parent: item, key: child })
          const childContext = context === "messages" ? "message" : context === "parts" ? "part" :
            context === "message" && child === "info" ? "info" : context === "message" && child === "parts" ? "parts" :
            context === "part" && child === "state" ? "state" :
            ["info", "part", "state"].includes(context) && typeof item[child] === "string" ? context : "generic"
          walk(item, child, depth + 1, childContext)
        }
      }
    }
    walk(wrapper, "value", 0, hostMessages ? "messages" : "generic")
    const filtered = await strings(sessionId, leaves.map(leaf => leaf.text))
    leaves.forEach((leaf, i) => {
      let text = filtered[i]!
      if (leaf.contextual && text !== WITHHELD) {
        try { text = JSON.parse(text)[leaf.key]; if (typeof text !== "string") text = WITHHELD }
        catch { text = WITHHELD }
        if (text !== leaf.parent[leaf.key] && /[\r\n]/.test(leaf.parent[leaf.key])) text = leaf.parent[leaf.key].replace(/[^\r\n]+/g, "[REDACTED]")
      }
      leaf.parent[leaf.key] = text
    })
    const distinctKeys = [...new Set(keys.map(item => item.key))]
    const checkedKeys = await strings(sessionId, distinctKeys)
    const filteredKeys = new Map(distinctKeys.map((key, i) => [key, checkedKeys[i]!]))
    const schemaKeys = new Set(["info", "parts", "id", "role", "sessionID", "messageID", "parentID", "modelID", "providerID", "type", "tool", "callID", "state", "status", "input", "output", "error", "metadata", "text", "title", "content", "system", "context", "time", "start", "end", "created", "completed", "summary", "finish", "tokens", "cost", "model", "bluecode", "vsec", "nextCursor", "found", "archive", "filePath", "path", "command", "args", "name", "data"])
    keys.forEach(item => {
      const key = filteredKeys.get(item.key)!
      if (key === item.key || key === WITHHELD && schemaKeys.has(item.key)) return
      const value = item.parent[item.key]
      delete item.parent[item.key]
      Object.defineProperty(item.parent, key, { value, writable: true, configurable: true, enumerable: true })
    })
    return wrapper.value
  }
  async function messages<T extends { info: Record<string, any>; parts: any[] }>(sessionId: string, values: T[]): Promise<T[]> {
    return object(sessionId, values, false, true)
  }
  return {
    enabled, stats: () => ({ ...stats }), strings, object, messages,
    async before(event: { tool: string; sessionID: string; callID: string }, output: { args: unknown }) {
      if (!enabled()) return
      let decision: SecurityDecision
      try {
        const params = await prepareTool({ projectId: input.projectId, sessionId: event.sessionID,
          directory: input.directory, root: input.root ?? input.directory, tool: event.tool,
          args: output.args, policy: options.security.policy })
        const port = input.port()
        if (!port) throw new Error("unavailable")
        stats.scans++
        decision = await port.evaluateTool(params)
      } catch {
        stats.unavailable++
        decision = { decision: "unavailable", coverage: "unsupported", findings: [],
          policyVersion: options.security.policy.version, diagnostics: ["scanner_unavailable"] }
      }
      if (pending.size >= 256) pending.delete(pending.keys().next().value!)
      pending.set(JSON.stringify([event.sessionID, event.callID]), decision)
      const denied = decision.decision === "deny" || decision.decision === "unavailable" &&
        toolOperation(event.tool, options.security.policy) !== "read"
      if (denied && options.security.mode === "enforce") {
        stats.denied++
        pending.delete(JSON.stringify([event.sessionID, event.callID]))
        const ids = decision.findings.map(f => f.ruleId).join(", ")
        throw new SecurityBlockedError(decision.decision === "unavailable" ? "scanner unavailable; retry when ready" : ids.slice(0, 512))
      }
      if (decision.decision !== "allow") stats.warned++
    },
    async after(event: { sessionID: string; callID: string }, output: Record<string, any>) {
      if (!enabled()) return
      const clean = await object(event.sessionID, output)
      for (const key of Object.keys(output)) delete output[key]
      Object.assign(output, clean)
      const withheld = JSON.stringify(clean).includes(WITHHELD)
      const decision = pending.get(JSON.stringify([event.sessionID, event.callID]))
      pending.delete(JSON.stringify([event.sessionID, event.callID]))
      if (decision || withheld) output.metadata = { ...output.metadata, vsec: {
        decision: decision?.decision ?? "unavailable", coverage: decision?.coverage ?? "unsupported",
        policyVersion: options.security.policy.version, rules: decision?.findings.map(f => f.ruleId) ?? [], withheld,
      } }
      if (decision?.findings.length && typeof output.output === "string") {
        const text = decision.findings.map(f => `${f.ruleId}: ${f.remediation}`).join("; ").slice(0, 900)
        output.output += `\n[VSecAgent] ${(await strings(event.sessionID, [text]))[0]}`
      }
    },
    clearSession(sessionId: string) {
      for (const key of pending.keys()) if ((JSON.parse(key) as string[])[0] === sessionId) pending.delete(key)
    },
  }
}
