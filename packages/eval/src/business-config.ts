import { parseOptions } from "@bluecode/plugin/config"

export type BusinessArm = "baseline" | "combo"
export const BUSINESS_MODEL = "bluecode-free/mimo-v2.5-free"
export const BUSINESS_UPSTREAM_MODEL = "mimo-v2.5-free"
export const BUSINESS_OBSERVER = "file:///opt/bluecode/packages/plugin/src/business-observer.ts"

export function makeBusinessConfig(arm: BusinessArm, runId: string, proxyPort: number) {
  if (!/^[a-zA-Z0-9-]+$/.test(runId) || !Number.isSafeInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) throw Error("Invalid run configuration")
  const compressed = arm === "combo"
  const plugin = {
    mode: compressed ? "on" as const : "off" as const,
    dataDir: "/artifacts/bluecode",
    security: { mode: "enforce" as const },
    rtk: { mode: compressed ? "on" as const : "off" as const, minBytes: 512, budgetTokens: 512 },
    headroom: { mode: compressed ? "on" as const : "off" as const, strategy: "layered" as const,
      triggerRatio: 0.7, targetRatio: 0.55, retainRecentTurns: 1, memoryMaxTokens: 4096,
      fallback: "passthrough" as const, summarizer: { enabled: false } },
  }
  const effective = parseOptions(plugin)
  const host = {
    model: BUSINESS_MODEL, small_model: BUSINESS_MODEL, autoupdate: false, share: "disabled",
    enabled_providers: ["bluecode-free"], compaction: { auto: false, prune: false }, lsp: false, formatter: false,
    provider: { "bluecode-free": { npm: "@ai-sdk/openai-compatible", name: "BlueCode frozen free model", options: {
      baseURL: `http://host.docker.internal:${proxyPort}/${runId}/main`, apiKey: "{env:BLUECODE_RUN_TOKEN}",
    }, models: { [BUSINESS_UPSTREAM_MODEL]: { name: "MiMo-V2.5 Free", tool_call: true, limit: { context: 40000, input: 40000, output: 2048 } } } } },
    agent: { build: { steps: 8, model: BUSINESS_MODEL } },
    permission: { "*": "deny", read: "allow", edit: "allow", write: "allow", glob: "allow", grep: "allow", list: "allow", bash: "allow", headroom_retrieve: "allow" },
    plugin: [[BUSINESS_OBSERVER, plugin]],
  }
  return { host, effective }
}
