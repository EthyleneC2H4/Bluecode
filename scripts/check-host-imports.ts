#!/usr/bin/env bun
/** Bundle the actual host factory: client/pure imports must not pull in a database. */
const result = await Bun.build({
  entrypoints: [new URL("../packages/plugin/src/index.ts", import.meta.url).pathname],
  target: "bun",
  write: false,
})
if (!result.success) throw new AggregateError(result.logs, "Host plugin failed to bundle")
for (const output of result.outputs) {
  if ((await output.text()).includes("bun:sqlite"))
    throw new Error("Host bundle imports bun:sqlite; use client/pure subentries")
}
console.log("Host import boundary OK: production factory bundle contains no SQLite runtime")
