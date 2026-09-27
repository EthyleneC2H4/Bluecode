import { test, expect } from "bun:test"
import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { createOrder, cancelOrder, refundOrder, type State } from "../src/operations.ts"

const seedPath = join(import.meta.dir, "../seed.json")
const taskPath = join(import.meta.dir, "../TASK.md")
const assigned = existsSync(seedPath) && existsSync(taskPath)
const seed = assigned ? JSON.parse(await readFile(seedPath, "utf8")) as State : null
const task = assigned ? (await readFile(taskPath, "utf8")).match(/^# (T[123])/m)?.[1] : null

const assignedTest = assigned ? test : test.skip
assignedTest("Public happy path for the assigned operation", () => {
  if (!seed) throw Error("Missing task seed")
  const state = structuredClone(seed)
  if (task === "T1") {
    const result = createOrder(state, { sku: "SKU-1", quantity: 1 }, "demo-order")
    expect(result.status).toBe(201)
    expect(state.stock["SKU-1"]).toBe(1)
  } else if (task === "T2") {
    const result = cancelOrder(state, "o-pending")
    expect(result.status).toBe(200)
    expect(state.orders["o-pending"]?.status).toBe("CANCELED")
  } else if (task === "T3") {
    const result = refundOrder(state, "o-paid", { quantity: 1, amountCents: 1250 }, "demo-refund")
    expect(result.status).toBe(201)
    expect(state.orders["o-paid"]?.refundedCents).toBe(1250)
  } else throw Error("Unknown task")
})
