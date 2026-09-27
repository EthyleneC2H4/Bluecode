import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { cancelOrder, createOrder, refundOrder, type State, type Result } from "./operations.ts"

const stateFile = process.env.ORDER_STATE_FILE ?? join(import.meta.dir, "../data/state.json")
const seed: State = JSON.parse(await readFile(join(import.meta.dir, "../seed.json"), "utf8"))
let state: State
try { state = JSON.parse(await readFile(stateFile, "utf8")) } catch { state = structuredClone(seed) }
let serial = Promise.resolve()

async function save(next: State) {
  await mkdir(dirname(stateFile), { recursive: true })
  const temporary = `${stateFile}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(next) + "\n")
  await rename(temporary, stateFile)
}

function transaction(action: (draft: State) => Result): Promise<Result> {
  const next = serial.then(async () => {
    const draft = structuredClone(state)
    const result = action(draft)
    if (result.status >= 200 && result.status < 300) {
      await save(draft)
      state = draft
    }
    return result
  })
  serial = next.then(() => undefined, () => undefined)
  return next
}

const server = Bun.serve({ port: Number(process.env.PORT ?? "3000"), hostname: "0.0.0.0", async fetch(request) {
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/health") return Response.json({ ok: true })
  if (request.method === "GET" && url.pathname === "/state") return Response.json(state)
  if (request.method === "POST" && url.pathname === "/_reset") {
    const result = await transaction(draft => { Object.assign(draft, structuredClone(seed)); return { status: 200, body: { ok: true } } })
    return Response.json(result.body, { status: result.status })
  }
  if (request.method !== "POST") return Response.json({ error: "Not found" }, { status: 404 })
  let input: unknown
  try { input = await request.json() } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }) }
  const key = request.headers.get("idempotency-key")
  const cancel = url.pathname.match(/^\/orders\/([^/]+)\/cancel$/)
  const refund = url.pathname.match(/^\/orders\/([^/]+)\/refunds$/)
  const result = await transaction(draft => url.pathname === "/orders" ? createOrder(draft, input, key)
    : cancel ? cancelOrder(draft, decodeURIComponent(cancel[1]!))
    : refund ? refundOrder(draft, decodeURIComponent(refund[1]!), input, key)
    : { status: 404, body: { error: "Not found" } })
  return Response.json(result.body, { status: result.status })
} })
console.log(`PORT:${server.port}`)
