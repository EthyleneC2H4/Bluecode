import { randomBytes, timingSafeEqual } from "node:crypto"
import { createLiveBudget, providerObservation } from "./live-observation"

const UPSTREAM = "https://opencode.ai/zen/v1/chat/completions"
const MAX_BODY = 1024 * 1024
const MAX_RESPONSE = 8 * 1024 * 1024
interface Session { token: string; model: string; expiresAt: number; budget: ReturnType<typeof createLiveBudget>; active: Set<AbortController>; overWindow: boolean }
export interface BusinessProxyRecord {
  runId: string; status: number | "transport-error"; durationMs: number
  headroomMarkers: number
  estimatedInput: number; actualWindowExceeded: boolean
  inputReservation: number; outputReservation: number
  actualInput: number | null; actualOutput: number | null
  cacheRead: number | null; cacheWrite: number | null
  errorCode: string | null; usageSource: "provider-response"
}

async function readBounded(request: Request, limit: number): Promise<Uint8Array | null> {
  const size = Number(request.headers.get("content-length"))
  if (Number.isFinite(size) && size > limit) return null
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let count = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      count += value.length
      if (count > limit) { await reader.cancel(); return null }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(count)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

function authenticated(received: string | null, expected: string): boolean {
  if (!received?.startsWith("Bearer ")) return false
  const a = Buffer.from(received.slice(7)), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function cacheUsage(text: string) {
  let cacheRead: number | null = null, cacheWrite: number | null = null
  const lines = /^data:/m.test(text) ? text.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()) : [text]
  for (const line of lines) {
    try {
      const usage = JSON.parse(line).usage
      const read = usage?.prompt_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens
      const write = usage?.cache_creation_input_tokens
      if (typeof read === "number" && Number.isFinite(read)) cacheRead = read
      if (typeof write === "number" && Number.isFinite(write)) cacheWrite = write
    } catch { /* Unknown usage remains null. */ }
  }
  return { cacheRead, cacheWrite }
}

export function createBusinessProxy(options: { upstreamKey: string; upstreamFetch?: (url: string, init?: RequestInit) => Promise<Response> }) {
  if (!options.upstreamKey) throw Error("Missing upstream key")
  const sessions = new Map<string, Session>()
  const observations: BusinessProxyRecord[] = []
  const upstreamFetch = options.upstreamFetch ?? fetch
  const server = Bun.serve({ hostname: "0.0.0.0", port: 0, idleTimeout: 120, async fetch(request) {
    const match = new URL(request.url).pathname.match(/^\/([a-zA-Z0-9-]+)\/main\/chat\/completions$/)
    if (!match || request.method !== "POST") return new Response("Unknown route", { status: 404 })
    const runId = match[1]!, session = sessions.get(runId)
    if (!session || Date.now() >= session.expiresAt || !authenticated(request.headers.get("authorization"), session.token)) return new Response("Unauthorized", { status: 401 })
    if (session.overWindow) return new Response("Observed input window exceeded", { status: 402 })
    const bytes = await readBounded(request, MAX_BODY)
    if (!bytes) return new Response("Request too large", { status: 413 })
    let body: any
    try { body = JSON.parse(new TextDecoder().decode(bytes)) } catch { return new Response("Invalid JSON", { status: 400 }) }
    if (!body || typeof body !== "object" || Array.isArray(body)) return new Response("Invalid request", { status: 400 })
    if (body.model !== session.model) return new Response("Model outside free allowlist", { status: 403 })
    const estimatedInput = Math.ceil(JSON.stringify(body).length / 4) + 4096
    if (estimatedInput > 40000) return new Response("Input window estimate exceeded", { status: 413 })
    const output = Number.isSafeInteger(body.max_tokens) && body.max_tokens > 0 ? Math.min(body.max_tokens, 2048) : 2048
    body.max_tokens = output
    const reservation = session.budget.reserve(body, output)
    if (!reservation) return new Response("Run request budget exhausted", { status: 402 })
    const encoded = JSON.stringify(body)
    const record: BusinessProxyRecord = { runId, status: "transport-error", durationMs: 0, headroomMarkers: (encoded.match(/\[headroom node:[0-9a-f]{64}\]/g) ?? []).length,
      estimatedInput, actualWindowExceeded: false,
      inputReservation: reservation.inputReservation, outputReservation: reservation.outputReservation,
      actualInput: null, actualOutput: null, cacheRead: null, cacheWrite: null, errorCode: null, usageSource: "provider-response" }
    observations.push(record)
    const controller = new AbortController()
    session.active.add(controller)
    const start = performance.now()
    try {
      const response = await upstreamFetch(UPSTREAM, { method: "POST", headers: { authorization: `Bearer ${options.upstreamKey}`, "content-type": "application/json" }, body: encoded,
        redirect: "error", signal: AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(90000)]) })
      const outputBytes = await readBounded(new Request("http://local/", { method: "POST", body: response.body }), MAX_RESPONSE)
      if (!outputBytes) throw Error("Upstream response too large")
      const outputText = new TextDecoder().decode(outputBytes)
      const usage = providerObservation(outputText)
      session.budget.settle(reservation, usage)
      if (usage.input !== null && usage.input > 40000) { session.overWindow = true; record.actualWindowExceeded = true }
      Object.assign(record, { status: response.status, actualInput: usage.input, actualOutput: usage.output, errorCode: usage.errorCode, ...cacheUsage(outputText) })
      return new Response(outputBytes, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } })
    } catch {
      session.budget.settle(reservation, { input: null, output: null })
      return new Response("Upstream unavailable", { status: 502 })
    } finally { record.durationMs = performance.now() - start; session.active.delete(controller) }
  } })
  const port = server.port
  if (!port) throw Error("Proxy port allocation failed")
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    register(runId: string, model: string, expiresAt: number): string {
      if (!/^[a-zA-Z0-9-]+$/.test(runId) || sessions.has(runId) || expiresAt <= Date.now()) throw Error("Invalid or duplicate run")
      const token = randomBytes(32).toString("base64url")
      sessions.set(runId, { token, model, expiresAt, budget: createLiveBudget({ maxRequests: 8, maxInputTokens: 8 * 160000, maxOutputTokens: 8 * 2048 }), active: new Set(), overWindow: false })
      return token
    },
    revoke(runId: string) { const session = sessions.get(runId); for (const controller of session?.active ?? []) controller.abort(); sessions.delete(runId) },
    records(runId?: string) { return observations.filter(record => runId === undefined || record.runId === runId).map(record => ({ ...record })) },
    budget(runId: string) { return sessions.get(runId)?.budget.snapshot() ?? null },
    stop() { for (const runId of sessions.keys()) this.revoke(runId); server.stop(true) },
  }
}
