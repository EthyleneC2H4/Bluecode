import { test, expect } from "bun:test"
import { createBusinessProxy } from "../src/business-proxy"

test("Temporary run token scopes model, route, body size and upstream authentication", async () => {
  const calls: Array<{ authorization: string | null; url: string }> = []
  const proxy = createBusinessProxy({ upstreamKey: "real-secret", upstreamFetch: async (input, init) => {
    calls.push({ authorization: new Headers(init?.headers).get("authorization"), url: String(input) })
    return Response.json({ usage: { prompt_tokens: 12, completion_tokens: 3 }, choices: [] })
  } })
  const token = proxy.register("run-1", "mimo-v2.5-free", Date.now() + 60000)
  const endpoint = `${proxy.url}/run-1/main/chat/completions`
  const body = { model: "mimo-v2.5-free", max_tokens: 20, messages: [{ role: "user", content: `[headroom node:${"a".repeat(64)}]` }] }
  const post = (url: string, key: string, value: unknown) => fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(value) })
  try {
    expect((await post(endpoint, "wrong", body)).status).toBe(401)
    expect((await post(`${proxy.url}/run-1/summary/chat/completions`, token, body)).status).toBe(404)
    expect((await post(endpoint, token, { ...body, model: "paid-model" })).status).toBe(403)
    expect((await post(endpoint, token, { ...body, messages: [{ role: "user", content: "x".repeat(1024 * 1024 + 1) }] })).status).toBe(413)
    expect((await post(endpoint, token, body)).status).toBe(200)
    expect(calls).toEqual([{ authorization: "Bearer real-secret", url: "https://opencode.ai/zen/v1/chat/completions" }])
    expect(proxy.records()[0]?.actualInput).toBe(12)
    expect(proxy.records()[0]?.headroomMarkers).toBe(1)
    proxy.revoke("run-1")
    expect((await post(endpoint, token, body)).status).toBe(401)
  } finally { proxy.stop() }
})

test("Proxy keeps missing usage unknown and blocks a ninth request", async () => {
  const proxy = createBusinessProxy({ upstreamKey: "fixture", upstreamFetch: async () => Response.json({ choices: [] }) })
  const token = proxy.register("run-2", "mimo-v2.5-free", Date.now() + 60000)
  const endpoint = `${proxy.url}/run-2/main/chat/completions`
  try {
    for (let i = 0; i < 8; i++) expect((await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "mimo-v2.5-free", messages: [], max_tokens: 1 }) })).status).toBe(200)
    expect((await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "mimo-v2.5-free", messages: [] }) })).status).toBe(402)
    expect(proxy.records().every(record => record.actualInput === null && record.actualOutput === null)).toBe(true)
  } finally { proxy.stop() }
})

test("Input window estimate admits long ASCII history below forty thousand estimated tokens", async () => {
  const proxy = createBusinessProxy({ upstreamKey: "fixture", upstreamFetch: async () => Response.json({ choices: [] }) })
  const token = proxy.register("run-3", "mimo-v2.5-free", Date.now() + 60000)
  try {
    const response = await fetch(`${proxy.url}/run-3/main/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "mimo-v2.5-free", max_tokens: 1, messages: [{ role: "user", content: "x".repeat(60000) }] }) })
    expect(response.status).toBe(200)
    expect(proxy.records()[0]?.estimatedInput).toBeLessThan(40000)
  } finally { proxy.stop() }
})

test("Expired tokens and observed provider window overflow stop forwarding", async () => {
  let forwarded = 0
  const proxy = createBusinessProxy({ upstreamKey: "fixture", upstreamFetch: async (_url, init) => {
    expect(init?.redirect).toBe("error")
    forwarded++
    return Response.json({ choices: [], usage: { prompt_tokens: 40001, completion_tokens: 2 } })
  } })
  const expired = proxy.register("expired", "mimo-v2.5-free", Date.now() + 20)
  const token = proxy.register("overflow", "mimo-v2.5-free", Date.now() + 60000)
  const post = (id: string, key: string) => fetch(`${proxy.url}/${id}/main/chat/completions`, { method: "POST",
    headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ model: "mimo-v2.5-free", messages: [], max_tokens: 2 }) })
  try {
    await Bun.sleep(30)
    expect((await post("expired", expired)).status).toBe(401)
    expect((await post("overflow", token)).status).toBe(200)
    expect(proxy.records("overflow")[0]?.actualWindowExceeded).toBe(true)
    expect((await post("overflow", token)).status).toBe(402)
    expect(forwarded).toBe(1)
  } finally { proxy.stop() }
})
