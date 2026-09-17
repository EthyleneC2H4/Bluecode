import { test, expect } from "bun:test"
import * as core from "../src/index"
import type { SecurityEvaluateParams } from "@bluecode/contracts"
const api = core as unknown as { evaluateTool:(p:SecurityEvaluateParams)=>Promise<any> }
import { risks, benign } from "../fixtures/development"
for (const [family, fixtures] of Object.entries(risks)) for (const [i,p] of fixtures.entries()) test(`${family} risk ${i+1}`, async()=>{
  const result = await api.evaluateTool(p)
  expect(result.findings.some((f:any)=>f.category===family)).toBe(true)
  expect(result.decision).not.toBe("allow")
})
for (const [family, fixtures] of Object.entries(benign)) for (const [i,p] of fixtures.entries()) test(`${family} benign ${i+1}`, async()=>{
  const result = await api.evaluateTool(p)
  expect(result.findings.filter((f:any)=>f.category===family)).toHaveLength(0)
  expect(result.decision).not.toBe("deny")
})
