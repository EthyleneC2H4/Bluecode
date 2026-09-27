import { test, expect } from "bun:test"
import { makeBusinessConfig } from "../src/business-config"

test("Baseline and combo keep the same enforced security policy and only change compression", () => {
  const baseline = makeBusinessConfig("baseline", "run-1", 9000)
  const combo = makeBusinessConfig("combo", "run-2", 9000)
  expect(baseline.effective.security).toEqual(combo.effective.security)
  expect(baseline.effective.mode).toBe("off")
  expect(combo.effective.mode).toBe("on")
  expect(baseline.effective.rtk.mode).toBe("off")
  expect(combo.effective.rtk.mode).toBe("on")
  expect(baseline.effective.headroom.mode).toBe("off")
  expect(combo.effective.headroom.mode).toBe("on")
  expect(combo.effective.headroom.strategy).toBe("layered")
  expect(combo.effective.headroom.retainRecentTurns).toBe(1)
  expect(combo.effective.headroom.summarizer.enabled).toBe(false)
  expect(baseline.host.model).toBe(combo.host.model)
  expect(baseline.host.compaction).toEqual({ auto: false, prune: false })
  expect(JSON.stringify(baseline.host)).not.toContain("real-secret")
})
