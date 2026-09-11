/** Deterministic, I/O-free, incremental evidence planner. Raw requests are never summarized. */
import type { ChatMessage, HeadroomCompressResult, LayeredBudget, LayeredMetrics, LayeredNode, LayeredSourceRef, LayeredStateEvent, LayeredTaskState, MemoryEntry, Namespace, ViewOperation } from "@bluecode/contracts"
import { canonicalJSON, contentDigest } from "./turns"
import { COMPLETED_TOOL_STATUSES, materializeOperations, textDigest } from "./layered-operations"
import { createCachedTokenCounter, estimatedTokenCounter, type TokenCounter } from "./token-counter"

export const LAYERED_POLICY_VERSION = "layered-rules-v1"
const NODE_MARKER = "[headroom node:"
const LEAF_SOURCE_TOKENS = 8192
const LEAF_SUMMARY_TOKENS = 512
const PARENT_SUMMARY_TOKENS = 1024

interface Observation {
  partIndex: number
  kind: "tool-output" | "text-range"
  start?: number
  end?: number
  fieldDigest: string
  sourceTokens: number
  text: string
  memoryKind: MemoryEntry["kind"]
  key: string
}
interface Analysis {
  digest: string
  tokens: number
  observations: Observation[]
  protectedMemory: MemoryEntry[]
  stateEntries: Array<Omit<LayeredStateEvent, "eventId" | "sourceIds" | "sourceDigests" | "order"> & { partIndex: number }>
}
export interface LayeredCache {
  get(key: string): Analysis | undefined
  set(key: string, value: Analysis): void
  readonly size: number
}
/** Bounded by both entry count and serialized summary bytes, never retains original outputs. */
export function createLayeredCache(options: { maxEntries?: number; maxBytes?: number } = {}): LayeredCache {
  const maxEntries = options.maxEntries ?? 4096, maxBytes = options.maxBytes ?? 16 * 1024 * 1024
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid analysis cache capacity")
  const entries = new Map<string, { value: Analysis; bytes: number }>()
  let bytes = 0
  return {
    get size() { return entries.size },
    get(key) { const hit = entries.get(key); if (!hit) return; entries.delete(key); entries.set(key, hit); return hit.value },
    set(key, value) {
      const old = entries.get(key)
      if (old) { bytes -= old.bytes; entries.delete(key) }
      const size = JSON.stringify(value).length * 2
      if (size > maxBytes) return
      entries.set(key, { value, bytes: size }); bytes += size
      while (entries.size > maxEntries || bytes > maxBytes) {
        const oldest = entries.keys().next().value!
        bytes -= entries.get(oldest)!.bytes; entries.delete(oldest)
      }
    },
  }
}
export interface LayeredPlanOptions {
  namespace: Namespace
  contextWindowTokens: number
  targetTokens?: number
  retainRecentTurns?: number
  memoryMaxTokens?: number
  memoryRatio?: number
  protectedMessageIds?: readonly string[]
  epoch?: string
  cache?: LayeredCache
  tokenCounter?: TokenCounter
  /** Existing immutable nodes, e.g. from the namespace archive. */
  nodes?: readonly LayeredNode[]
}
export type LayeredPlan = HeadroomCompressResult & {
  operations: ViewOperation[]
  nodes: LayeredNode[]
  memory: MemoryEntry[]
  protectedMemory: MemoryEntry[]
  budget: LayeredBudget
  metrics: LayeredMetrics
  taskState: LayeredTaskState
}
export function nodeContentHash(node: Omit<LayeredNode, "nodeId">): string {
  return textDigest(canonicalJSON(node))
}
function makeNode(node: Omit<LayeredNode, "nodeId">): LayeredNode {
  return Object.freeze({ ...node, namespace: Object.freeze({ ...node.namespace }), nodeId: nodeContentHash(node), children: Object.freeze([...node.children]) as unknown as string[], sourceRefs: Object.freeze(node.sourceRefs.map((ref) => Object.freeze({ ...ref }))) as unknown as LayeredSourceRef[] })
}
function clip(text: string, maxTokens: number, counter: TokenCounter): string {
  if (counter.count(text) <= maxTokens) return text
  const marker = "\n[excerpt; expand source for full evidence]"
  if (counter.count(marker) >= maxTokens) return ""
  let low = 0, high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (counter.count(text.slice(0, mid) + marker) <= maxTokens) low = mid
    else high = mid - 1
  }
  // Do not split a surrogate pair.
  if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1]!)) low--
  return text.slice(0, low) + marker
}
export function layeredMessageTokens(message: ChatMessage, counter: TokenCounter = estimatedTokenCounter): number {
  return counter.count(message.parts.map((part) => part.type === "text" ? part.text : part.type === "tool" ? [part.tool, part.input === undefined ? "" : JSON.stringify(part.input), part.state.output ?? "", part.state.error ?? ""].join("\n") : canonicalJSON(part)).join("\n"))
}
function materialRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  const fences = /```[^\n]*\n[\s\S]*?\n```/g
  for (const match of text.matchAll(fences)) {
    const start = match.index!
    const prefix = text.slice(Math.max(0, start - 200), start).trim()
    if (/\b(?:implement|generate|write|create|desired|proposed|template)\b|实现|编写|生成|期望|待实现|模板/i.test(prefix)) continue
    if (/(?:\b(?:observed logs?|logs?|terminal output|file contents?|source file|reference material)|日志|终端输出|文件内容|参考材料|运行输出)\s*[:：]?\s*$/i.test(prefix)) ranges.push({ start, end: start + match[0].length })
  }
  return ranges
}
function skeleton(tool: string, input: unknown, status: string, output: string, error: string, counter: TokenCounter): { text: string; kind: MemoryEntry["kind"] } {
  const args = input === undefined ? "" : canonicalJSON(input)
  const failure = /error|fail/i.test(status) || /\b(?:error|failed|exception|panic|traceback)\b|失败|错误/i.test(output + error)
  const command = typeof input === "object" && input ? String((input as Record<string, unknown>).command ?? "") : ""
  const test = /test|pytest|vitest|jest|typecheck|check|build/i.test(tool + " " + command)
  const write = /write|edit|patch/i.test(tool)
  const kind: MemoryEntry["kind"] = failure ? "failures" : write ? "changes" : test ? "verification" : "decisions"
  const lines = output.split("\n")
  const diagnostics: string[] = []
  if (failure) {
    for (let i = 0; i < lines.length; i++) {
      if (/\b(?:error|fail(?:ed|ure)?|exception|panic|traceback|assert|expected|received)\b|失败|错误|^not ok/i.test(lines[i]!)) {
        diagnostics.push(...lines.slice(i, i + 3)); i += 2
        if (counter.count(diagnostics.join("\n")) > 320) break
      }
    }
  } else if (test) {
    diagnostics.push(...lines.filter((line) => /pass|fail|tests?|suites?|duration|exit|通过|失败/i.test(line)).slice(-8))
  } else if (write) diagnostics.push(...lines.filter((line) => /^[-+]|changed|updated|written|modified|file/i.test(line)).slice(0, 6))
  else if (/grep|search|glob/i.test(tool)) diagnostics.push(...lines.filter((line) => line.trim()).slice(0, 5))
  // Read evidence records the file and revision via its source reference, without restating source code.
  if (failure && !diagnostics.length) diagnostics.push(...lines.slice(0, 3), ...lines.slice(-3))
  const header = `tool ${tool} (${status}) input: ${clip(args, 120, counter)}`
  const body = [header, error, ...diagnostics].filter(Boolean).join("\n")
  return { text: clip(body, 480, counter), kind }
}
function analyze(message: ChatMessage, namespaceKey: string, counter: TokenCounter, digest: string): Analysis {
  const observations: Observation[] = [], protectedMemory: MemoryEntry[] = []
  const stateEntries: Analysis["stateEntries"] = []
  for (let partIndex = 0; partIndex < message.parts.length; partIndex++) {
    const part = message.parts[partIndex]!
    if (part.type === "text") {
      const ranges = materialRanges(part.text)
      if (message.info.role === "assistant" && /\b(?:todo|pending|next|unresolved|decided|decision|changed|updated|verified|passed|failed)\b|待办|下一步|尚未|决定|修改|验证|失败/i.test(part.text)) {
        const kind: MemoryEntry["kind"] = /\b(?:todo|pending|next|unresolved)\b|待办|下一步|尚未/i.test(part.text) ? "open" : /fail|error|失败|错误/i.test(part.text) ? "failures" : /changed|updated|修改/i.test(part.text) ? "changes" : /verified|passed|验证|通过/i.test(part.text) ? "verification" : "decisions"
        stateEntries.push({ partIndex, kind, text: clip(part.text, 480, counter) })
      }
      // Keep all remaining user text byte-for-byte, including explicit corrections.
      if (message.info.role === "user") {
        let offset = 0
        for (const range of ranges) {
          const text = part.text.slice(offset, range.start)
          if (text.trim()) protectedMemory.push({ kind: "constraints", text, sourceIds: [message.info.id] })
          offset = range.end
        }
        const text = part.text.slice(offset)
        if (text.trim()) protectedMemory.push({ kind: "constraints", text, sourceIds: [message.info.id] })
      }
      for (const range of ranges) {
        const material = part.text.slice(range.start, range.end)
        observations.push({ partIndex, kind: "text-range", ...range, fieldDigest: textDigest(material), sourceTokens: counter.count(material), text: "Explicit reference material; expand source for original content.", memoryKind: "decisions", key: textDigest(namespaceKey + "\0material\0" + material) })
      }
    } else if (part.type === "tool" && COMPLETED_TOOL_STATUSES.has(part.state.status) && part.state.output && !part.state.output.includes(NODE_MARKER)) {
      const { text, kind } = skeleton(part.tool, part.input, part.state.status, part.state.output, part.state.error ?? "", counter)
      const fieldDigest = textDigest(part.state.output)
      stateEntries.push({ partIndex, kind, text, tool: part.tool, inputDigest: textDigest(canonicalJSON(part.input)), outputDigest: fieldDigest, status: part.state.status })
      observations.push({ partIndex, kind: "tool-output", fieldDigest, sourceTokens: counter.count(part.state.output), text, memoryKind: kind, key: textDigest(canonicalJSON([namespaceKey, part.tool, part.input, part.state.status, fieldDigest, part.state.error])) })
    }
  }
  if (message.archive?.protectedMemory) protectedMemory.push(...message.archive.protectedMemory)
  if (message.archive && message.info.id === `compaction-${message.archive.historyHash}`) protectedMemory.push(...message.archive.memory.filter((entry) => entry.kind === "constraints"))
  return { digest, tokens: layeredMessageTokens(message, counter), observations, protectedMemory, stateEntries }
}
interface Candidate {
  observation: Observation
  message: ChatMessage
  messageIndex: number
  digest: string
  nodeId: string
  replacement: string
}
function operation(candidate: Candidate, suffix = ""): ViewOperation {
  const o = candidate.observation
  const common = { operationId: textDigest(canonicalJSON([LAYERED_POLICY_VERSION, candidate.message.info.id, candidate.digest, o.kind, o.partIndex, o.start, o.end, candidate.nodeId])), sourceVersion: 1 as const, nodeId: candidate.nodeId, messageId: candidate.message.info.id, sourceDigest: candidate.digest, partIndex: o.partIndex, replacement: candidate.replacement + suffix }
  return o.kind === "tool-output" ? { ...common, kind: "tool-output", outputDigest: o.fieldDigest } : { ...common, kind: "text-range", start: o.start!, end: o.end!, textDigest: o.fieldDigest }
}
function validateOptions(options: LayeredPlanOptions): void {
  if (!Number.isFinite(options.contextWindowTokens) || options.contextWindowTokens <= 0) throw new Error("Invalid context window")
  for (const value of [options.targetTokens, options.memoryMaxTokens]) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error("Invalid token budget")
  if (options.retainRecentTurns !== undefined && (!Number.isSafeInteger(options.retainRecentTurns) || options.retainRecentTurns < 0)) throw new Error("Invalid retained turns")
  if (options.memoryRatio !== undefined && (!Number.isFinite(options.memoryRatio) || options.memoryRatio < 0 || options.memoryRatio > 1)) throw new Error("Invalid memory ratio")
}

export function buildLayeredPlan(messages: readonly ChatMessage[], options: LayeredPlanOptions): LayeredPlan {
  validateOptions(options)
  const counter = createCachedTokenCounter(options.tokenCounter ?? estimatedTokenCounter)
  const target = Math.floor(options.targetTokens ?? options.contextWindowTokens * 0.55)
  const namespaceKey = canonicalJSON(options.namespace)
  const protectedIds = new Set(options.protectedMessageIds ?? [])
  const metrics: LayeredMetrics = { scannedMessages: messages.length, analyzedMessages: 0, analysisCacheHits: 0, candidateCount: 0, selectedMemoryBlocks: 0, deduplicatedObservations: 0, operationCount: 0, leafNodes: 0, parentNodes: 0, tokenCounter: counter.id, tokenCountMode: counter.mode }
  const analyses: Analysis[] = []
  const turnStarts: number[] = []
  const turnIndices: number[] = []
  const protectedMemory: MemoryEntry[] = []
  const protectedKeys = new Set<string>()
  const events: LayeredStateEvent[] = []
  let rawTokens = 0
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    if (i === 0 || message.info.role === "user") turnStarts.push(i)
    turnIndices.push(turnStarts.length - 1)
    const digest = contentDigest(message)
    const key = `${namespaceKey}\0${LAYERED_POLICY_VERSION}\0${counter.id}\0${digest}`
    let analysis = options.cache?.get(key)
    if (analysis) metrics.analysisCacheHits++
    else { analysis = analyze(message, namespaceKey, counter, digest); options.cache?.set(key, analysis); metrics.analyzedMessages++ }
    analyses.push(analysis); rawTokens += analysis.tokens
    for (const entry of analysis.stateEntries) {
      const { partIndex, ...event } = entry
      events.push({ ...event, eventId: textDigest(canonicalJSON([namespaceKey, digest, partIndex, event.kind])), sourceIds: [message.info.id], sourceDigests: [digest], order: i })
    }
    for (const entry of analysis.protectedMemory) {
      const key = canonicalJSON([entry.text, entry.sourceIds])
      if (!protectedKeys.has(key)) { protectedKeys.add(key); protectedMemory.push({ ...entry, sourceIds: [...entry.sourceIds] }) }
    }
  }
  const keepTurns = (options.retainRecentTurns ?? 4) + 1
  const recentStart = turnStarts[Math.max(0, turnStarts.length - keepTurns)] ?? 0
  const recentTokens = analyses.slice(recentStart).reduce((sum, a) => sum + a.tokens, 0)
  const candidates: Candidate[] = []
  const byKey = new Map<string, Candidate[]>()
  for (let i = 0; i < recentStart; i++) {
    const message = messages[i]!, analysis = analyses[i]!
    if (message.protected || protectedIds.has(message.info.id)) continue
    for (const observation of analysis.observations) {
      // Minimum reference wrapper has a fixed-size node ID. Nonpositive gains are inert.
      const minimumReplacement = `${NODE_MARKER}${"0".repeat(64)}]${observation.memoryKind === "failures" ? `\n${observation.text}` : ""}`
      if (observation.sourceTokens <= counter.count(minimumReplacement)) continue
      const candidate: Candidate = { observation, message, messageIndex: i, digest: analysis.digest, nodeId: "", replacement: "" }
      candidates.push(candidate)
      const duplicates = byKey.get(observation.key) ?? []
      if (duplicates.length) metrics.deduplicatedObservations++
      duplicates.push(candidate); byKey.set(observation.key, duplicates)
    }
  }
  metrics.candidateCount = candidates.length
  const nodes: LayeredNode[] = []
  // Persisted ancestors are included only when referenced by this visible input, never from another session.
  const available = new Map((options.nodes ?? []).filter((node) => canonicalJSON(node.namespace) === namespaceKey && nodeContentHash(nodeWithoutId(node)) === node.nodeId).map((node) => [node.nodeId, node]))
  const roots: LayeredNode[] = []
  const usedExisting = new Set<string>()
  const addExisting = (id: string) => {
    if (usedExisting.has(id)) return
    usedExisting.add(id)
    const node = available.get(id)
    if (!node) return
    roots.push(node)
  }
  for (const message of messages.slice(0, recentStart)) {
    for (const id of message.archive?.nodeIds ?? []) addExisting(id)
    for (const part of message.parts) {
      const text = part.type === "text" ? part.text : part.type === "tool" ? part.state.output ?? "" : ""
      for (const match of text.matchAll(/\[headroom node:([0-9a-f]{64})\]/g)) addExisting(match[1]!)
    }
  }
  interface SourcePiece { candidate: Candidate; start?: number; end?: number; tokens: number }
  const candidateNodes = new Map<Candidate, string[]>()
  let group: SourcePiece[] = [], groupTokens = 0
  const flush = () => {
    if (!group.length) return
    const refs: LayeredSourceRef[] = group.map(({ candidate, start, end }) => ({ messageId: candidate.message.info.id, contentHash: candidate.digest, partIndex: candidate.observation.partIndex, ...(start !== undefined ? { start, end: end! } : candidate.observation.start !== undefined ? { start: candidate.observation.start, end: candidate.observation.end! } : {}), ...(candidate.message.archive ? { historyHash: candidate.message.archive.historyHash } : {}) }))
    const uniqueText = [...new Set(group.map(({ candidate }) => candidate.observation.text))]
    const text = clip(uniqueText.join("\n"), LEAF_SUMMARY_TOKENS, counter)
    const node = makeNode({ namespace: { ...options.namespace }, level: 0, children: [], sourceRefs: refs, policyVersion: LAYERED_POLICY_VERSION, text, tokens: counter.count(text), sourceTokens: groupTokens })
    nodes.push(node); roots.push(node); metrics.leafNodes++
    for (const { candidate } of group) {
      const ids = candidateNodes.get(candidate) ?? []
      if (ids.at(-1) !== node.nodeId) ids.push(node.nodeId)
      candidateNodes.set(candidate, ids)
    }
    group = []; groupTokens = 0
  }
  const addPiece = (piece: SourcePiece) => {
    if (group.length && groupTokens + piece.tokens > LEAF_SOURCE_TOKENS) flush()
    group.push(piece); groupTokens += piece.tokens
    if (groupTokens >= LEAF_SOURCE_TOKENS) flush()
  }
  for (const candidate of candidates) {
    const observation = candidate.observation
    if (observation.sourceTokens <= LEAF_SOURCE_TOKENS) { addPiece({ candidate, tokens: observation.sourceTokens }); continue }
    const part = candidate.message.parts[observation.partIndex]!
    const source = part.type === "tool" ? part.state.output ?? "" : part.type === "text" ? part.text.slice(observation.start, observation.end) : ""
    const baseOffset = observation.kind === "text-range" ? observation.start! : 0
    for (let offset = 0; offset < source.length;) {
      let end = Math.min(source.length, offset + LEAF_SOURCE_TOKENS * 4)
      if (counter.count(source.slice(offset, end)) > LEAF_SOURCE_TOKENS) {
        let low = offset, high = end
        while (low < high) {
          const mid = Math.ceil((low + high) / 2)
          if (counter.count(source.slice(offset, mid)) <= LEAF_SOURCE_TOKENS) low = mid
          else high = mid - 1
        }
        end = low
      }
      if (end > offset && /[\uD800-\uDBFF]/.test(source[end - 1]!)) end--
      if (end <= offset) throw new Error("TokenCounter cannot fit one source character in a leaf")
      addPiece({ candidate, start: baseOffset + offset, end: baseOffset + end, tokens: counter.count(source.slice(offset, end)) })
      offset = end
    }
  }
  flush()
  for (const candidate of candidates) {
    const ids = candidateNodes.get(candidate)!
    candidate.nodeId = ids[0]!
    candidate.replacement = ids.map((id) => `${NODE_MARKER}${id}]`).join("\n")
    if (candidate.observation.memoryKind === "failures") candidate.replacement += `\n${candidate.observation.text}`
  }
  // Build a balanced 4-ary evidence hierarchy. Parent text is bounded; source recovery follows children.
  if (rawTokens > target) {
    let frontier = roots
    while (frontier.length >= 4) {
      const next: LayeredNode[] = []
      let merged = false
      for (let i = 0; i < frontier.length;) {
        const group = frontier.slice(i, i + 4)
        if (group.length === 4 && group.every((node) => node.level === group[0]!.level)) {
          const children = group.map((node) => node.nodeId)
          const text = clip(group.map((node) => node.text).join("\n"), PARENT_SUMMARY_TOKENS, counter)
          const parent = makeNode({ namespace: { ...options.namespace }, level: group[0]!.level + 1, children, sourceRefs: [], policyVersion: LAYERED_POLICY_VERSION, text, tokens: counter.count(text), sourceTokens: group.reduce((sum, node) => sum + node.sourceTokens, 0) })
          if (!available.has(parent.nodeId)) { nodes.push(parent); metrics.parentNodes++ }
          next.push(parent); i += 4; merged = true
        } else { next.push(frontier[i]!); i++ }
      }
      if (!merged) break
      frontier = next
    }
  }
  const snapshot = { messageIds: messages.map((message) => message.info.id), sourceDigests: analyses.map((analysis) => analysis.digest) }
  const initialOperations = candidates.map((candidate) => operation(candidate))
  const baseline = initialOperations.length ? materializeOperations(messages, initialOperations, snapshot) : { status: "applied", messages: [...messages] }
  const baselineTokens = baseline.messages.reduce((sum, message) => sum + layeredMessageTokens(message, counter), 0)
  const wrapperTokens = candidates.reduce((sum, candidate) => sum + counter.count(candidate.replacement), 0)
  const protectedTokens = Math.max(0, baselineTokens - recentTokens - wrapperTokens)
  const historyBudgetTokens = Math.max(0, Math.min(4096, options.memoryMaxTokens ?? 4096, Math.floor(options.contextWindowTokens * (options.memoryRatio ?? 0.15)), Math.min(target, Math.floor(options.contextWindowTokens * 0.55)) - protectedTokens - recentTokens - wrapperTokens))
  const budget: LayeredBudget = { availableInputTokens: options.contextWindowTokens, targetTokens: target, protectedTokens, recentTokens, wrapperTokens, historyBudgetTokens, memoryTokens: 0, reasons: [] }
  if (protectedTokens > target) budget.reasons.push("protected-content-exceeds-target")
  if (protectedTokens + recentTokens > target) budget.reasons.push("protected-and-recent-content-exceeds-target")
  const latestRequest = messages.filter((message) => message.info.role === "user").at(-1)?.parts.filter((part) => part.type === "text").map((part) => part.text).join(" ") ?? ""
  const terms = new Set((latestRequest.toLowerCase().match(/[\p{L}\p{N}_/.:-]{3,}/gu) ?? []).slice(0, 128))
  const unique = [...byKey.values()].map((values) => ({ candidate: values[0]!, values, relevance: [...terms].filter((term) => values[0]!.observation.text.toLowerCase().includes(term)).length }))
  const priority = (entry: typeof unique[number]) => entry.candidate.observation.memoryKind === "failures" || entry.candidate.observation.memoryKind === "open" ? 0 : entry.candidate.observation.memoryKind === "changes" ? 1 : entry.relevance > 0 ? 2 : 3
  unique.sort((a, b) => priority(a) - priority(b) || b.relevance - a.relevance || b.values.at(-1)!.messageIndex - a.values.at(-1)!.messageIndex || a.candidate.observation.key.localeCompare(b.candidate.observation.key))
  const memory: MemoryEntry[] = []
  const suffixes = new Map<Candidate, string>()
  for (const entry of unique) {
    const candidate = entry.candidate
    // Failure diagnosis is already mandatory visible evidence; do not charge or inject it twice.
    const suffix = candidate.observation.memoryKind === "failures" ? "" : `\n${candidate.observation.text}`
    const cost = counter.count(suffix)
    if (budget.memoryTokens + cost > historyBudgetTokens || candidate.observation.sourceTokens <= counter.count(candidate.replacement + suffix)) continue
    const sourceIds = [...new Set(entry.values.map((value) => value.message.info.id))]
    memory.push({ kind: candidate.observation.memoryKind, text: candidate.observation.text, sourceIds })
    suffixes.set(candidate, suffix); budget.memoryTokens += cost
  }
  metrics.selectedMemoryBlocks = memory.length
  let operations = candidates.map((candidate) => operation(candidate, suffixes.get(candidate) ?? ""))
  const materialized = operations.length ? materializeOperations(messages, operations, snapshot) : baseline
  const finalTokens = materialized.messages.reduce((sum, message) => sum + layeredMessageTokens(message, counter), 0)
  const compacted = materialized.status === "applied" && operations.length > 0 && finalTokens < rawTokens
  const affected = new Set(candidates.map((candidate) => candidate.messageIndex))
  const evicted = analyses.reduce((sum, analysis, index) => sum + (affected.has(index) ? analysis.tokens : 0), 0)
  const retained = rawTokens - evicted
  const refs = messages.flatMap((message, i) => affected.has(i) ? [{ contentHash: analyses[i]!.digest, role: message.info.role, turnIndex: turnIndices[i]! }] : [])
  if (!compacted) { operations = []; memory.length = 0; budget.memoryTokens = 0; metrics.selectedMemoryBlocks = 0; budget.reasons.push(candidates.length ? "nonpositive-gain-or-invalid-snapshot" : "no-safe-positive-gain-candidates") }
  if (finalTokens > target) budget.reasons.push("target-not-reached")
  metrics.operationCount = operations.length
  return {
    strategy: "layered", compacted, operations, nodes: compacted ? nodes : [], protectedMemory, memory, budget, metrics,
    taskState: { events, currentRequestIds: messages.slice(recentStart).filter((message) => message.info.role === "user").map((message) => message.info.id).slice(-1) },
    sourceSnapshot: snapshot, ...(options.epoch !== undefined ? { epoch: options.epoch } : {}),
    historyHash: compacted ? textDigest(canonicalJSON([LAYERED_POLICY_VERSION, options.namespace, snapshot, operations])) : null,
    summary: compacted ? memory.map((entry) => entry.text).join("\n") : null,
    refs: compacted ? refs : [], replacedMessageIds: compacted ? messages.filter((_, i) => affected.has(i)).map((message) => message.info.id) : [], sourceDigests: compacted ? refs.map((ref) => ref.contentHash) : [],
    rawTokens, summaryTokens: compacted ? counter.count(memory.map((entry) => entry.text).join("\n")) : 0,
    sourceTokensEst: rawTokens, evictedTokensEst: compacted ? evicted : 0, retainedTokensEst: compacted ? retained : rawTokens,
    replacementTokensEst: compacted ? finalTokens - retained : 0, finalTokensEst: compacted ? finalTokens : rawTokens, freedTokens: compacted ? rawTokens - finalTokens : 0,
    budgetExceeded: (compacted ? finalTokens : rawTokens) > target,
  }
}
function nodeWithoutId(node: LayeredNode): Omit<LayeredNode, "nodeId"> {
  const { nodeId, ...body } = node
  return body
}
