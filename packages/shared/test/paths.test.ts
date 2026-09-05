import { expect, test } from "bun:test"
import * as paths from "../src/paths"

test("durable data and runtime sockets are distinct and explicit roots determine identity", () => {
  const layout = (paths as any).storageLayout("/data/blue")
  expect(layout.rtk).toBe("/data/blue/storage-v2/rtk")
  expect(layout.headroom).toBe("/data/blue/storage-v2/headroom")
  expect(layout.socket).not.toStartWith("/data/blue/")
  expect(layout.socket).not.toBe((paths as any).storageLayout("/data/other").socket)
  expect(Buffer.byteLength(layout.socket)).toBeLessThan(104)
  expect((paths as any).defaultDataDir()).not.toContain("/tmp/")
})
