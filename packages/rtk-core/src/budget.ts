/** Stable O(n log n) block selection; only positive-gain replacements are legal. */
import type { CLine } from "./strategies/types"
export interface BudgetOptions {
  budgetTokens: number
  rawHash: string
  rawTokensEst: number
  tool: string
}
export interface BudgetResult {
  text: string
  elidedTokens: number
  groupsCollapsed: number
  keptLines: CLine[]
}
interface Block {
  start: number
  end: number
  priority: number
  label: string
  summary: string
  gain: number
  chars: number
}
export function applyBudget(lines: CLine[], opts: BudgetOptions): BudgetResult {
  const blocks: Block[] = []
  let chars = 0
  for (const line of lines) chars += line.text.length + 1
  for (let i = 0; i < lines.length; ) {
    const first = lines[i]!
    if (first.anchor) {
      i++
      continue
    }
    const start = i
    const label = first.group ?? opts.tool
    let cost = 0
    while (
      i < lines.length &&
      !lines[i]!.anchor &&
      (lines[i]!.group ?? opts.tool) === label &&
      lines[i]!.priority === first.priority
    ) {
      cost += lines[i]!.text.length + 1
      i++
    }
    const summary = `[+${i - start} lines elided in ${label}]`
    const gain = cost - summary.length - 1
    if (gain > 0)
      blocks.push({ start, end: i, priority: first.priority, label, summary, gain, chars: cost })
  }
  blocks.sort((a, b) => a.priority - b.priority || a.start - b.start)
  const footer = (elided: number): string =>
    `[bluecode rtk] compressed: rawHash=${opts.rawHash} (${elided} tokens elided). Full output: headroom_retrieve(hash="${opts.rawHash}")`
  const selected = new Map<number, Block>()
  const groups = new Set<string>()
  let elidedChars = 0
  for (const block of blocks) {
    if (Math.ceil((chars + footer(Math.ceil(elidedChars / 4)).length) / 4) <= opts.budgetTokens)
      break
    selected.set(block.start, block)
    groups.add(block.label)
    chars -= block.gain
    elidedChars += block.chars
  }
  const output: string[] = []
  const keptLines: CLine[] = []
  for (let i = 0; i < lines.length; ) {
    const block = selected.get(i)
    if (block) {
      output.push(block.summary)
      i = block.end
    } else {
      output.push(lines[i]!.text)
      keptLines.push(lines[i]!)
      i++
    }
  }
  const elidedTokens = Math.ceil(elidedChars / 4)
  return {
    text: `${output.join("\n")}\n${footer(elidedTokens)}`,
    elidedTokens,
    groupsCollapsed: groups.size,
    keptLines,
  }
}
