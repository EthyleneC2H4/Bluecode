import { expect, test } from "bun:test"
import * as runner from "../src/runner"

test("real-client 1/8/32 concurrency benchmark reports observations without wall-clock gates", async () => {
  expect(runner.runConcurrencyBenchmarks).toBeFunction()
  const samples = await runner.runConcurrencyBenchmarks()
  expect(samples.map((s) => s.concurrency)).toEqual([1, 8, 32])
  for (const sample of samples) {
    expect(sample.completed).toBe(sample.concurrency)
    expect(sample.rtkCalls).toBe(sample.concurrency)
    expect(sample.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(sample.rssBytes).toBeGreaterThan(0)
    expect(sample.queueMs).toBeNull()
    expect(sample.serviceMs).toBeNull()
  }
}, 30_000)
