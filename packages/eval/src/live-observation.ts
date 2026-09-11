/** Evaluation accounting never substitutes an estimate for missing provider usage. */
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
export const INPUT_FRAMING_TOKENS = 4096
export function inputReservation(body: any): number {
  // A byte-level tokenizer cannot emit more ordinary tokens than UTF8 bytes.
  // Reserve additional provider/chat framing beyond the entire serialized body.
  return Buffer.byteLength(JSON.stringify(body), "utf8") + INPUT_FRAMING_TOKENS + (Array.isArray(body?.messages) ? body.messages.length * 64 : 0) + (Array.isArray(body?.tools) ? body.tools.length * 256 : 0)
}
const errorCodes = new Set(["MissingSessionID", "RateLimitError", "rate_limit_exceeded", "insufficient_quota", "invalid_api_key", "invalid_request_error", "context_length_exceeded", "model_not_found", "Unauthorized", "Forbidden", "BadRequest", "InternalServerError"])
export function safeErrorCode(value: unknown): string | null {
  return typeof value === "string" && errorCodes.has(value) ? value : null
}
export function providerObservation(text: string) {
  let input: number | null = null, output: number | null = null, errorCode: string | null = null
  const bodies = /^data:/m.test(text) ? text.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()) : [text]
  for (const body of bodies) {
    if (body === "[DONE]" || body.length > 8 * 1024 * 1024) continue
    try {
      const parsed = JSON.parse(body), usage = parsed.usage
      if (usage) { input = finite(usage.prompt_tokens ?? usage.input_tokens); output = finite(usage.completion_tokens ?? usage.output_tokens) }
      errorCode = safeErrorCode(parsed.error?.code) ?? safeErrorCode(parsed.error?.type) ?? safeErrorCode(parsed.error?.name) ?? safeErrorCode(parsed.name) ?? safeErrorCode(parsed.code) ?? errorCode
      // Only a finite code allowlist may be recovered from provider messages.
      if (!errorCode && typeof parsed.error?.message === "string") for (const code of errorCodes) if (parsed.error.message === code || parsed.error.message.startsWith(code + ":")) { errorCode = code; break }
    } catch { /* Missing or malformed usage is unknown, not zero. */ }
  }
  return { input, output, errorCode }
}
export function mainUsage(events: any[]) {
  const steps = events.filter(event => event.type === "step_finish")
  const sum = (pick: (event: any) => unknown) => {
    const values = steps.map(event => finite(pick(event)))
    return !values.length || values.some(value => value === null) ? null : values.reduce<number>((n, value) => n + value!, 0)
  }
  const usage = { input: sum(e => e.part?.tokens?.input), output: sum(e => e.part?.tokens?.output), cacheRead: sum(e => e.part?.tokens?.cache?.read), cacheWrite: sum(e => e.part?.tokens?.cache?.write), cost: sum(e => e.part?.cost) }
  return { ...usage, complete: Object.values(usage).every(value => value !== null) }
}
export const nullableSum = (values: Array<number | null>): number | null => values.some(value => value === null) ? null : values.reduce<number>((sum, value) => sum + value!, 0)
export interface Reservation { inputReservation: number; outputReservation: number; actualInput: number | null; actualOutput: number | null; settled: boolean }
export function createLiveBudget(limits: { maxRequests: number; maxInputTokens: number; maxOutputTokens: number }) {
  const entries: Reservation[] = []
  let violation = false, exhausted = false
  const debit = (key: "Input" | "Output") => entries.reduce((n, entry) => n + Math.max(entry[key === "Input" ? "inputReservation" : "outputReservation"], entry[key === "Input" ? "actualInput" : "actualOutput"] ?? 0), 0)
  return {
    reserve(body: unknown, output: number): Reservation | null {
      const input = inputReservation(body)
      if (violation || entries.length >= limits.maxRequests || debit("Input") + input > limits.maxInputTokens || debit("Output") + output > limits.maxOutputTokens) { exhausted = true; return null }
      const entry = { inputReservation: input, outputReservation: output, actualInput: null, actualOutput: null, settled: false }
      entries.push(entry); return entry
    },
    settle(entry: Reservation, usage: { input: number | null; output: number | null }) {
      entry.actualInput = usage.input; entry.actualOutput = usage.output; entry.settled = true
      if ((usage.input ?? 0) > entry.inputReservation || (usage.output ?? 0) > entry.outputReservation) { violation = true; exhausted = true }
    },
    snapshot() { return { ...limits, reservedInput: entries.reduce((n, e) => n + e.inputReservation, 0), reservedOutput: entries.reduce((n, e) => n + e.outputReservation, 0), debitedInput: debit("Input"), debitedOutput: debit("Output"), actualInput: nullableSum(entries.map(e => e.actualInput)), actualOutput: nullableSum(entries.map(e => e.actualOutput)), usageComplete: entries.every(e => e.settled && e.actualInput !== null && e.actualOutput !== null), exhausted, violation,
      inputReservationMode: "UTF8 serialized request bytes + 4096 framing tokens + 64/message + 256/tool; assumes byte-level tokenizer and framing within this allowance; actual usage checked separately" } },
  }
}
const normalize = (value: string) => value.trim().replace(/\s+/g, " ").replace(/[.。!?！？]+$/, "")
export function evidencePresent(value: unknown, expected: string): boolean {
  if (typeof value !== "string") return false
  // Compare entire independent sentences, never an arbitrary substring or a
  // negated/qualified rewrite. Reject explicit contradiction anywhere in field.
  const sentences = value.split(/(?<=[.!?。！？])\s+/)
  if (!sentences.some(sentence => normalize(sentence) === normalize(expected))) return false
  const extra = sentences.filter(sentence => normalize(sentence) !== normalize(expected)).join(" ")
  if (/\b(?:false|incorrect|wrong|instead|however|but|exclusive|exclude|excluding|uppercase|not true|not correct|not the case)\b|并非|不是|错误|相反|但是/i.test(extra)) return false
  return true
}
export function probesFor(handoff: any, task: { fact: string; reason: string; category: string }) {
  return { strictExact: { fact: typeof handoff?.fact === "string" && handoff.fact.replace(/[.。]$/, "") === task.fact, reason: typeof handoff?.reason === "string" && handoff.reason.replace(/[.。]$/, "") === task.reason },
    evidencePresent: { fact: evidencePresent(handoff?.fact, task.fact), reason: evidencePresent(handoff?.reason, task.reason) },
    file: typeof handoff?.file === "string" && handoff.file.includes(task.category === "test-repair" ? "test.mjs" : "src/main.js"), next: typeof handoff?.next === "string" && handoff.next.length > 0 }
}
