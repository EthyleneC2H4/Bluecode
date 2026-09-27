import type { BusinessTaskId } from "./business-acceptance"
import type { BusinessArm } from "./business-config"

export interface PlannedBusinessRun { id: string; task: BusinessTaskId; kind: "natural" | "pressure"; arm: BusinessArm; repeat: number; order: number }
export interface BusinessRecord extends PlannedBusinessRun {
  passed: boolean; durationMs: number | null; actualInput: number | null; actualOutput: number | null
  compressionExercised: boolean; failureType: string | null
}

export function plannedBusinessRuns(): PlannedBusinessRun[] {
  const plan: PlannedBusinessRun[] = []
  for (const repeat of [0, 1]) {
    const arms: BusinessArm[] = repeat === 0 ? ["baseline", "combo"] : ["combo", "baseline"]
    for (const task of ["T1", "T2", "T3"] as const) for (const arm of arms)
      plan.push({ id: `${task}-natural-${arm}-${repeat}`, task, kind: "natural", arm, repeat, order: plan.length + 1 })
    for (const arm of arms) plan.push({ id: `T3-pressure-${arm}-${repeat}`, task: "T3", kind: "pressure", arm, repeat, order: plan.length + 1 })
  }
  return plan
}

export function summarizeBusinessRuns(records: BusinessRecord[]) {
  const summarize = (kind: "natural" | "pressure") => {
    const target = plannedBusinessRuns().filter(run => run.kind === kind)
    const selected = records.filter(record => record.kind === kind)
    const failures: Record<string, number> = {}
    for (const record of selected) if (record.failureType) failures[record.failureType] = (failures[record.failureType] ?? 0) + 1
    const sum = (rows: BusinessRecord[], expected: number, field: "actualInput" | "actualOutput" | "durationMs") =>
      rows.length === expected && rows.every(record => record[field] !== null)
        ? rows.reduce((total, record) => total + record[field]!, 0) : null
    const byArm = Object.fromEntries((["baseline", "combo"] as const).map(arm => {
      const armRecords = selected.filter(record => record.arm === arm)
      const requested = target.filter(run => run.arm === arm).length
      return [arm, { requested, completed: armRecords.length, passed: armRecords.filter(record => record.passed).length,
        compressionExercised: armRecords.filter(record => record.compressionExercised).length,
        actualInput: sum(armRecords, requested, "actualInput"), actualOutput: sum(armRecords, requested, "actualOutput"),
        durationMs: sum(armRecords, requested, "durationMs") }]
    })) as Record<BusinessArm, { requested: number; completed: number; passed: number; compressionExercised: number;
      actualInput: number | null; actualOutput: number | null; durationMs: number | null }>
    return { requested: target.length, completed: selected.length, passed: selected.filter(record => record.passed).length,
      actualInput: sum(selected, target.length, "actualInput"), actualOutput: sum(selected, target.length, "actualOutput"),
      durationMs: sum(selected, target.length, "durationMs"), failures, byArm }
  }
  return { natural: summarize("natural"), pressure: summarize("pressure") }
}
