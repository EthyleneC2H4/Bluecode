/**
 * Dependency-direction gate: asserts the workspace's internal package graph
 * matches the ALLOWED_EDGES table exactly. Runs in CI (and locally via
 * `bun run check:deps`) so a new `@bluecode/*` import fails fast instead of
 * quietly coupling layers — humans documented the direction, but prose does
 * not review PRs.
 *
 * The graph (see CONTRIBUTING.md):
 *   contracts, shared   ← leaves, import nothing internal
 *   rtk-core, headroomd → contracts + shared
 *   rtk                 → rtk-core + contracts + shared
 *   plugin, eval        → rtk + headroomd + contracts + shared
 *
 * Anything not listed is forbidden: notably plugin/eval must never be
 * imported by a sidecar, and sidecar internals (rtk vs headroomd) must stay
 * mutually unaware.
 */
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

const PACKAGES_DIR = path.join(import.meta.dir, "..", "packages")

const ALLOWED_EDGES: Record<string, readonly string[]> = {
  contracts: [],
  shared: [],
  "rtk-core": ["contracts", "shared"],
  headroomd: ["contracts", "shared"],
  rtk: ["rtk-core", "contracts", "shared"],
  plugin: ["rtk", "headroomd", "contracts", "shared"],
  eval: ["rtk", "headroomd", "contracts", "shared", "plugin"],
}

interface Violation {
  from: string
  to: string
  kind: "undeclared-package" | "forbidden-edge" | "missing-declaration"
}

const violations: Violation[] = []

const discovered = readdirSync(PACKAGES_DIR)

const packageNames = new Set<string>(
  // Package dir names equal their @bluecode/<name> suffixes by convention;
  // verify against package.json to keep the gate honest if that ever drifts.
  discovered.filter((dir) => {
    try {
      const pkg = JSON.parse(readFileSync(path.join(PACKAGES_DIR, dir, "package.json"), "utf8"))
      return typeof pkg.name === "string" && pkg.name.startsWith("@bluecode/")
    } catch {
      return false
    }
  })
)

function internalDeps(pkgJsonPath: string): string[] {
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }
  const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }
  return Object.keys(all).filter((name) => name.startsWith("@bluecode/"))
}

for (const dir of discovered) {
  if (!packageNames.has(dir)) continue
  const declared = internalDeps(path.join(PACKAGES_DIR, dir, "package.json"))
  for (const dep of declared) {
    const target = dep.replace("@bluecode/", "")
    if (!ALLOWED_EDGES[dir]?.includes(target)) {
      violations.push({ from: dir, to: target, kind: "forbidden-edge" })
    }
  }
  for (const allowed of ALLOWED_EDGES[dir] ?? []) {
    if (!declared.includes(`@bluecode/${allowed}`)) {
      violations.push({ from: dir, to: allowed, kind: "missing-declaration" })
    }
  }
}

// Every directory holding an @bluecode package must appear in ALLOWED_EDGES —
// a new package without a gate entry would otherwise skip checking entirely.
for (const name of packageNames) {
  if (!(name in ALLOWED_EDGES)) {
    violations.push({ from: name, to: "(gate)", kind: "undeclared-package" })
  }
}
for (const name of Object.keys(ALLOWED_EDGES)) {
  if (!packageNames.has(name)) {
    violations.push({ from: "(gate)", to: name, kind: "undeclared-package" })
  }
}

if (violations.length > 0) {
  console.error("dependency-direction check FAILED:")
  for (const v of violations) {
    if (v.kind === "undeclared-package") {
      console.error(
        `  - package/gate mismatch: ${v.from} ↔ ${v.to} (add it to ALLOWED_EDGES or fix packages/)`
      )
    } else if (v.kind === "missing-declaration") {
      console.error(
        `  - ${v.from}: expected dependency on @bluecode/${v.to} is missing from package.json`
      )
    } else {
      console.error(
        `  - ${v.from} -> @bluecode/${v.to}: edge not allowed (allowed: [${
          (ALLOWED_EDGES[v.from] ?? []).join(", ") || "none"
        }])`
      )
    }
  }
  process.exit(1)
}

console.log(`dependency-direction OK (${packageNames.size} packages, graph matches the gate)`)
