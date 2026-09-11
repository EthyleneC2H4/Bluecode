import { memoryEntrySchema, summaryProviderSchema, type MemoryEntry, type SummaryProviderConfig } from "@bluecode/contracts"

/** Null is unknown provider usage, never an estimated or fabricated zero. */
export interface SummaryUsage { inputTokens: number | null; outputTokens: number | null }
export interface SummaryRequest {
  messages: Array<{ role: "system" | "user"; content: string }>
  maxOutputTokens: number
  signal: AbortSignal
}
export interface SummaryResult { entries: MemoryEntry[]; usage: SummaryUsage }
export interface SummaryProvider { readonly model: string; summarize(request: SummaryRequest): Promise<SummaryResult> }
export class SummaryProviderError extends Error {
  constructor(readonly code: string, readonly usage: SummaryUsage = { inputTokens: null, outputTokens: null }) { super(code) }
}
const tokenUsage = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null

/** Explicit text-only adapter: no agent loop, tools, streaming, retries or host session fabrication. */
export class OpenAICompatibleSummaryProvider implements SummaryProvider {
  readonly model: string
  private readonly config: SummaryProviderConfig
  constructor(config: SummaryProviderConfig) {
    this.config = summaryProviderSchema.parse(config)
    if (!this.config.enabled) throw new SummaryProviderError("provider-disabled")
    const url = new URL(this.config.baseURL!)
    if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) throw new SummaryProviderError("invalid-base-url")
    this.model = this.config.model!
  }
  async summarize(request: SummaryRequest): Promise<SummaryResult> {
    const key = process.env[this.config.apiKeyEnv!]
    if (!key) throw new SummaryProviderError("missing-api-key-env")
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(this.config.timeoutMs)])
    let usage: SummaryUsage = { inputTokens: null, outputTokens: null }
    try {
      const response = await fetch(`${this.config.baseURL!.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST", signal, redirect: "error",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: this.model, messages: request.messages, stream: false, max_tokens: Math.min(request.maxOutputTokens, this.config.maxOutputTokens) }),
      })
      if (!response.ok) { await response.body?.cancel(); throw new SummaryProviderError("http-error") }
      // Bound bytes before JSON parsing, including chunked responses with no content-length.
      const reader = response.body?.getReader()
      if (!reader) throw new SummaryProviderError("empty-response")
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          size += next.value.byteLength
          if (size > 262144) { await reader.cancel(); throw new SummaryProviderError("response-too-large") }
          chunks.push(next.value)
        }
      } finally { reader.releaseLock() }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      usage = { inputTokens: tokenUsage(body?.usage?.prompt_tokens), outputTokens: tokenUsage(body?.usage?.completion_tokens) }
      const choice = body?.choices?.[0]
      if (choice?.finish_reason === "length" || choice?.message?.tool_calls || typeof choice?.message?.content !== "string") throw new SummaryProviderError("invalid-response", usage)
      const payload = JSON.parse(choice.message.content)
      if (!Array.isArray(payload?.entries) || payload.entries.length > 64) throw new SummaryProviderError("invalid-entries", usage)
      return { entries: payload.entries.map((entry: unknown) => memoryEntrySchema.strict().parse(entry)), usage }
    } catch (error) {
      if (error instanceof SummaryProviderError) throw error
      // Never forward fetch URLs, headers, raw response data or schema-error excerpts.
      throw new SummaryProviderError(signal.aborted ? "provider-timeout-or-abort" : "invalid-response", usage)
    }
  }
}
