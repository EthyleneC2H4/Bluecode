import { spawn } from "node:child_process"
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export type BusinessTaskId = "T1" | "T2" | "T3"
export interface BusinessCheck { name: string; passed: boolean; reason: string | null }
export interface BusinessAcceptance { task: BusinessTaskId; passed: boolean; checks: BusinessCheck[] }
const fixture = join(import.meta.dir, "../fixtures/order-after-sales")

export async function prepareBusinessTask(task: BusinessTaskId, destination: string): Promise<void> {
  if (!["T1", "T2", "T3"].includes(task)) throw Error("Unknown business task")
  await mkdir(destination, { recursive: true })
  await cp(join(fixture, "base"), destination, { recursive: true })
  await cp(join(fixture, "tasks", task, "TASK.md"), join(destination, "TASK.md"))
  await cp(join(fixture, "tasks", task, "seed.json"), join(destination, "seed.json"))
}

export async function startLocalBusinessService(workdir: string) {
  const child = spawn("bun", ["src/server.ts"], { cwd: workdir, env: { ...process.env, PORT: "0", ORDER_STATE_FILE: join(workdir, "data", "acceptance-state.json") }, stdio: ["ignore", "pipe", "pipe"] })
  let output = "", errors = ""
  child.stderr.on("data", chunk => { errors += String(chunk).slice(0, 1000) })
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error(`Service did not start: ${errors.slice(-500)}`)), 8000)
    child.stdout.on("data", chunk => {
      output += String(chunk)
      const match = output.match(/PORT:(\d+)/)
      if (match) { clearTimeout(timeout); resolve(Number(match[1])) }
    })
    child.once("exit", code => { clearTimeout(timeout); reject(Error(`Service exited ${code}: ${errors.slice(-500)}`)) })
    child.once("error", error => { clearTimeout(timeout); reject(error) })
  }).catch(error => { child.kill("SIGKILL"); throw error })
  return { base: `http://127.0.0.1:${port}`, close: async () => { child.kill("SIGTERM"); await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else { child.once("exit", () => resolve()); setTimeout(() => { child.kill("SIGKILL"); resolve() }, 1000) } }) } }
}

async function request(base: string, path: string, body?: unknown, key?: string) {
  const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) } }), signal: AbortSignal.timeout(3000) })
  return { status: response.status, body: await response.json() as any }
}

function insist(condition: unknown, message: string): asserts condition { if (!condition) throw Error(message) }

export type BusinessServiceStarter = (workdir: string) => Promise<{ base: string; close(): Promise<void> }>
export async function checkBusinessTask(task: BusinessTaskId, workdir: string, start: BusinessServiceStarter = startLocalBusinessService): Promise<BusinessAcceptance> {
  let service: Awaited<ReturnType<BusinessServiceStarter>>
  try { service = await start(workdir) } catch (error) { return { task, passed: false, checks: [{ name: "service-start", passed: false, reason: String(error) }] } }
  const { base } = service
  const checks: BusinessCheck[] = []
  const scenario = async (name: string, run: () => Promise<void>) => {
    try { await request(base, "/_reset", {}); await run(); checks.push({ name, passed: true, reason: null }) }
    catch (error) { checks.push({ name, passed: false, reason: error instanceof Error ? error.message : String(error) }) }
  }
  try {
    if (task === "T1") {
      await scenario("server-price", async () => {
        const result = await request(base, "/orders", { sku: "SKU-1", quantity: 1, clientTotalCents: 1 }, "price")
        insist(result.status === 201 && result.body.totalCents === 1250 && result.body.unitPriceCents === 1250, "Server price was not used")
        insist((await request(base, "/state")).body.stock["SKU-1"] === 1, "Stock was not decremented once")
      })
      await scenario("idempotency-and-conflict", async () => {
        const first = await request(base, "/orders", { sku: "SKU-1", quantity: 1 }, "same")
        const retry = await request(base, "/orders", { sku: "SKU-1", quantity: 1 }, "same")
        const conflict = await request(base, "/orders", { sku: "SKU-1", quantity: 2 }, "same")
        const state = (await request(base, "/state")).body
        insist(first.status === 201 && retry.status === 201 && first.body.id === retry.body.id && conflict.status === 409, "Retry or conflict semantics failed")
        insist(state.stock["SKU-1"] === 1 && Object.keys(state.orders).length === 1, "Retry changed business state")
      })
      await scenario("invalid-and-insufficient", async () => {
        const cases = [[{ sku: "SKU-1", quantity: 0 }, 400], [{ sku: "MISSING", quantity: 1 }, 404], [{ sku: "SKU-1", quantity: 3 }, 409]] as const
        for (const [body, status] of cases) insist((await request(base, "/orders", body, crypto.randomUUID())).status === status, `Expected ${status} for invalid purchase`)
        insist((await request(base, "/state")).body.stock["SKU-1"] === 2, "Failure changed stock")
      })
      await scenario("concurrent-stock", async () => {
        const results = await Promise.all(Array.from({ length: 4 }, (_, i) => request(base, "/orders", { sku: "SKU-1", quantity: 1 }, `race-${i}`)))
        const state = (await request(base, "/state")).body
        insist(results.filter(result => result.status === 201).length === 2 && results.filter(result => result.status === 409).length === 2, "Concurrent orders oversold or rejected valid stock")
        insist(state.stock["SKU-1"] === 0 && Object.keys(state.orders).length === 2, "Concurrent stock/order state mismatch")
      })
    }
    if (task === "T2") {
      await scenario("cancel-once", async () => {
        const first = await request(base, "/orders/o-pending/cancel", {})
        const retry = await request(base, "/orders/o-pending/cancel", {})
        const state = (await request(base, "/state")).body
        insist(first.status === 200 && retry.status === 200 && first.body.id === retry.body.id, "Cancellation retry failed")
        insist(state.orders["o-pending"].status === "CANCELED" && state.stock["SKU-1"] === 2, "Stock release or order state is wrong")
      })
      await scenario("paid-and-shipped-unchanged", async () => {
        for (const id of ["o-paid", "o-shipped"]) insist((await request(base, `/orders/${id}/cancel`, {})).status === 409, `${id} was cancellable`)
        const state = (await request(base, "/state")).body
        insist(state.stock["SKU-1"] === 1 && state.orders["o-paid"].status === "PAID" && state.orders["o-shipped"].status === "SHIPPED", "Rejected cancel changed state")
      })
      await scenario("unknown-order", async () => { insist((await request(base, "/orders/missing/cancel", {})).status === 404, "Missing order was accepted") })
    }
    if (task === "T3") {
      await scenario("partial-and-cumulative", async () => {
        insist((await request(base, "/orders/o-paid/refunds", { quantity: 1, amountCents: 1250 }, "one")).status === 201, "First partial refund failed")
        insist((await request(base, "/orders/o-paid/refunds", { quantity: 2, amountCents: 2500 }, "two")).status === 201, "Remaining refundable balance failed")
        insist((await request(base, "/orders/o-paid/refunds", { quantity: 1, amountCents: 1250 }, "three")).status === 409, "Cumulative quantity or amount exceeded paid order")
        const state = (await request(base, "/state")).body
        insist(state.orders["o-paid"].refundedQuantity === 3 && state.orders["o-paid"].refundedCents === 3750 && Object.keys(state.refunds).length === 2, "Failure changed refund totals")
      })
      await scenario("refund-idempotency", async () => {
        const first = await request(base, "/orders/o-paid/refunds", { quantity: 1, amountCents: 1250 }, "same")
        const retry = await request(base, "/orders/o-paid/refunds", { quantity: 1, amountCents: 1250 }, "same")
        const conflict = await request(base, "/orders/o-paid/refunds", { quantity: 2, amountCents: 2500 }, "same")
        const state = (await request(base, "/state")).body
        insist(first.status === 201 && retry.status === 201 && first.body.id === retry.body.id && conflict.status === 409, "Refund retry or conflict failed")
        insist(state.orders["o-paid"].refundedQuantity === 1 && Object.keys(state.refunds).length === 1, "Refund retry changed state")
      })
      await scenario("amount-and-input-boundaries", async () => {
        for (const body of [{ quantity: 1, amountCents: 1249 }, { quantity: 1, amountCents: 0 }, { quantity: 0, amountCents: 0 }, { quantity: 1.5, amountCents: 1875 }]) insist((await request(base, "/orders/o-paid/refunds", body, crypto.randomUUID())).status === 400, "Invalid amount or quantity accepted")
        const state = (await request(base, "/state")).body
        insist(state.orders["o-paid"].refundedCents === 0 && Object.keys(state.refunds).length === 0, "Invalid refund changed state")
      })
      await scenario("illegal-status-and-unknown", async () => {
        for (const id of ["o-pending", "o-shipped"]) insist((await request(base, `/orders/${id}/refunds`, { quantity: 1, amountCents: 1250 }, id)).status === 409, `${id} was refunded`)
        insist((await request(base, "/orders/missing/refunds", { quantity: 1, amountCents: 1250 }, "missing")).status === 404, "Missing order was refunded")
      })
    }
  } finally { await service.close() }
  return { task, passed: checks.length > 0 && checks.every(check => check.passed), checks }
}

const mutants: Record<BusinessTaskId, Array<{ name: string; from: string; to: string }>> = {
  T1: [
    { name: "client-price", from: "totalCents: price * data.quantity", to: "totalCents: Number(data.clientTotalCents ?? price * data.quantity)" },
    { name: "duplicate-retry", from: "if (previous) return previous.fingerprint === fingerprint ? { status: 201, body: previous.result } : { status: 409, body: { error: \"Idempotency key conflict\" } }", to: "void previous" },
    { name: "oversell", from: "(state.stock[data.sku] ?? 0) < data.quantity", to: "(state.stock[data.sku] ?? 0) < 0" },
  ],
  T2: [
    { name: "paid-cancel", from: "order.status !== \"PENDING\"", to: "order.status === \"SHIPPED\"" },
    { name: "duplicate-release", from: "if (order.status === \"CANCELED\") return { status: 200, body: order }", to: "if (order.status === \"CANCELED\") { state.stock[order.sku] = (state.stock[order.sku] ?? 0) + order.quantity; return { status: 200, body: order } }" },
  ],
  T3: [
    { name: "refund-retry", from: "const previous = state.refundKeys[key]\n  if (previous) return previous.fingerprint === fingerprint ? { status: 201, body: previous.result } : { status: 409, body: { error: \"Idempotency key conflict\" } }", to: "const previous = state.refundKeys[key]\n  void previous" },
    { name: "single-refund-only", from: "order.refundedQuantity + data.quantity > order.quantity || order.refundedCents + data.amountCents > order.totalCents", to: "data.quantity > order.quantity || data.amountCents > order.totalCents" },
    { name: "amount-mismatch", from: "data.amountCents !== order.unitPriceCents * data.quantity", to: "false" },
    { name: "pending-refund", from: "order.status !== \"PAID\"", to: "order.status === \"SHIPPED\"" },
  ],
}

export async function checkReferenceAndMutants() {
  const reference = await readFile(join(import.meta.dir, "business-reference/operations.txt"), "utf8")
  const types = (await readFile(join(fixture, "base/src/operations.ts"), "utf8")).split("export function createOrder")[0]!
  const root = await mkdtemp(join(tmpdir(), "business-reference-"))
  try {
    const result: Array<{ task: BusinessTaskId; reference: BusinessAcceptance; mutants: Array<{ name: string; result: BusinessAcceptance }> }> = []
    for (const task of ["T1", "T2", "T3"] as const) {
      const work = join(root, task)
      await prepareBusinessTask(task, work)
      const source = types + reference
      await writeFile(join(work, "src/operations.ts"), source)
      const correct = await checkBusinessTask(task, work)
      const wrong = []
      for (const mutant of mutants[task]) {
        if (!source.includes(mutant.from)) throw Error(`Mutation anchor missing: ${mutant.name}`)
        await writeFile(join(work, "src/operations.ts"), source.replace(mutant.from, mutant.to))
        wrong.push({ name: mutant.name, result: await checkBusinessTask(task, work) })
      }
      result.push({ task, reference: correct, mutants: wrong })
    }
    return result
  } finally { await rm(root, { recursive: true, force: true }) }
}
