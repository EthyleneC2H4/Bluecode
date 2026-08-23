/**
 * Shared fixtures for rtk-core tests. Hand-written and deterministic;
 * assertions target properties, not golden text.
 *
 * Sizes are chosen so every fixture carries enough foldable bulk that
 * anchors + retrieval hint fit well below rawTokens (compression achievable).
 */

export const LS_LA = `total 48
drwxr-xr-x@ 6 ethylene staff 192 Aug 23 10:00 .
drwxr-xr-x@ 9 ethylene staff 288 Aug 22 09:00 ..
-rw-r--r--@ 1 ethylene staff 1201 Aug 23 10:00 README.md
-rw-r--r--@ 1 ethylene staff 301 Aug 22 09:00 package.json
-rw-r--r--@ 1 ethylene staff 4501 Aug 21 08:00 tsconfig.json
-rw-r--r--@ 1 ethylene staff 2201 Aug 21 07:00 bun.lockb
-rw-r--r--@ 1 ethylene staff 801 Aug 20 06:00 .gitignore
-rw-r--r--@ 1 ethylene staff 99 Aug 19 05:00 Makefile
-rw-r--r--@ 1 ethylene staff 55 Aug 18 04:00 LICENSE
-rw-r--r--@ 1 ethylene staff 4444 Aug 17 03:00 notes-v1.txt
-rw-r--r--@ 1 ethylene staff 3333 Aug 16 02:00 notes-v2.txt`;

export const PATH_LIST = [
  "packages/core/src/",
  "packages/core/src/index.ts",
  "packages/core/src/pipeline.ts",
  "packages/core/src/util.ts",
  "packages/core/src/types.ts",
  "packages/core/src/internal/a.ts",
  "packages/core/src/internal/b.ts",
  "packages/core/src/internal/c.ts",
  "packages/core/src/internal/d.ts",
  "packages/core/src/internal/e.ts",
  "packages/core/src/internal/f.ts",
  "packages/core/src/internal/g.ts",
  "packages/core/test/main.test.ts",
  ...Array.from({ length: 25 }, (_, i) => `packages/core/dist/bundle-${String(i).padStart(2, "0")}.js`),
].join("\n");

export const GREP_OUT = [
  "src/app.ts",
  'src/app.ts:1:import { serve } from "./server"',
  "src/app.ts:2:const port = 8080",
  "src/app.ts:3:export function main() {",
  "src/app.ts:4:  return null;",
  "src/app.ts:5:}",
  "src/app.ts:15:ERROR unhandled rejection surfaced here",
  ...Array.from({ length: 30 }, (_, i) => `src/app.ts:${300 + i}:filler match ${i} scanning ${i * 3} entries`),
  "src/app.ts:400:end of scan sweep",
  "src/util.ts:40:warn: deprecated API use detected",
  "src/util.ts:41:warn: second deprecation site",
  "src/util.ts:42:consider migrating soon",
  "src/util.ts:90:done scanning",
  "random chatter line without structure",
].join("\n");

export const DIFF_OUT = [
  "some preamble log line",
  "diff --git a/src/calc.ts b/src/calc.ts",
  "index abcdef0..1234567 100644",
  "--- a/src/calc.ts",
  "+++ b/src/calc.ts",
  "@@ -1,4 +1,6 @@",
  " existing context",
  ...Array.from({ length: 20 }, (_, i) => `-removed old line ${i + 1}`),
  ...Array.from({ length: 20 }, (_, i) => `+added fresh line ${i + 1}`),
  " trailing context",
  "diff --git a/src/other.ts b/src/other.ts",
  "index 1111111..2222222 100644",
  "--- a/src/other.ts",
  "+++ b/src/other.ts",
  "@@ -2,2 +2,3 @@",
  " unchanged",
  "-tiny removal",
  "+tiny addition",
].join("\n");

export const READ_OUT = Array.from({ length: 200 }, (_, i) => {
  const n = i + 1;
  const content =
    n === 3
      ? "ANCHOR_UNIQUE_TOP_CONTENT"
      : n === 198
        ? "ANCHOR_UNIQUE_BOTTOM_CONTENT"
        : `line ${n} of the file body with some padding text`;
  return `${String(n).padStart(6)}\t${content}`;
}).join("\n");

export const JEST_OUT = `PASS src/app.test.ts
  main()
${Array.from({ length: 30 }, (_, i) => `    ✓ handles generated case ${i} (${i + 1} ms)`).join("\n")}
    ✗ throws on bad input (5 ms)

  ● throws on bad input

    expect(received).toThrow()

    Expected: "boom"
    Received: "quiet failure"

      24 | function main() {
    at Object.<anonymous> (src/app.test.ts:25:11)

Test Suites: 1 failed, 1 total
Tests: 30 passed, 1 failed, 31 total
Snapshots: 0 total
Time: 0.81 s`;

export const GO_TEST_OUT = [
  "=== RUN   TestAdd",
  "--- PASS: TestAdd (0.00s)",
  ...Array.from({ length: 20 }, (_, i) => ["=== RUN   TestGen" + i, "--- PASS: TestGen" + i + " (0.00s)"]).flat(),
  "=== RUN   TestSub",
  "--- FAIL: TestSub (0.00s)",
  "    sub_test.go:12: got -1, want -2",
  "FAIL",
  "FAIL    example.com/pkg 0.153s",
  "ok      example.com/other 0.001s",
].join("\n");

export const NOISE = `hello world
this is just some plain text
nothing structural about it
yet another ordinary sentence
more prose follows here
the final line of noise`;
