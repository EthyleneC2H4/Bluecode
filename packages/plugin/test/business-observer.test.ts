import { test, expect } from "bun:test"
import { newHeadroomNodeIds } from "../src/business-observer"

test("Business observer records only nodes introduced by the applied transform", () => {
  const oldNode = `[headroom node:${"a".repeat(64)}]`
  const newNode = `[headroom node:${"b".repeat(64)}]`
  expect(newHeadroomNodeIds(oldNode, `${oldNode} ${newNode} ${newNode}`)).toEqual(["b".repeat(64)])
  expect(newHeadroomNodeIds(oldNode, oldNode)).toEqual([])
})
