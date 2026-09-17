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
  if (/node_modules\/.*(?:typescript\/lib|web-tree-sitter|tree-sitter-bash)/.test(await output.text()))
    throw new Error("Host bundle imports security parsers; keep scanning in the child process")
}
console.log("Host import boundary OK: production factory bundle contains no SQLite or security parser runtime")
