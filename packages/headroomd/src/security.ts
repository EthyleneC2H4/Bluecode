/** Pure redaction guard around storage, never a call to another sidecar. */
import { createHash } from "node:crypto"
import { readFile, writeFile, readdir } from "node:fs/promises"
import path from "node:path"
import { securityPolicySchema, type SecurityPolicy } from "@bluecode/contracts"
import { sanitizeFields } from "@bluecode/security-core/sanitize"
import { canonicalJSON } from "./turns"

export interface ArchiveSecurity {
  assert(value: unknown): void
  sanitize(text: string): string
}
const failure = () => new Error("Archive security inspection failed")
export function createArchiveSecurity(policy: SecurityPolicy): ArchiveSecurity {
  const parsed = securityPolicySchema.parse(policy)
  const sanitize = (fields: string[]) => {
    const result = sanitizeFields({ namespace: { projectId: "archive", sessionId: "guard" }, fields, policy: parsed })
    if (result.coverage !== "complete" || result.fields.length !== fields.length) throw failure()
    return result.fields
  }
  return {
    assert(value) {
      let fields: string[] = [], bytes = 0
      const flush = () => {
        if (fields.length && sanitize(fields).some((text, i) => text !== fields[i])) throw failure()
        fields = []; bytes = 0
      }
      const add = (text: string) => {
        const size = Buffer.byteLength(text)
        if (size > 1024 ** 2) throw failure()
        if (fields.length >= 64 || bytes + size > 2 * 1024 ** 2) flush()
        fields.push(text); bytes += size
      }
      const visit = (item: unknown, depth: number) => {
        if (depth > 64) throw failure()
        if (typeof item === "string") add(item)
        else if (Array.isArray(item)) for (const entry of item) visit(entry, depth + 1)
        else if (item && typeof item === "object") for (const [key, entry] of Object.entries(item)) { add(key); visit(entry, depth + 1) }
      }
      visit(value, 0); flush()
    },
    sanitize(text) { return sanitize([text])[0]! },
  }
}

export async function bindArchiveSecurity(dataDir: string, policy?: SecurityPolicy): Promise<ArchiveSecurity | undefined> {
  const marker = path.join(dataDir, "security-policy.json")
  const fingerprint = policy ? createHash("sha256").update(canonicalJSON({ format: "vsec-1", policy })).digest("hex") : undefined
  let bound: string | undefined
  try { bound = await readFile(marker, "utf8") }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw failure() }
  if (bound !== undefined) {
    if (!fingerprint || bound !== JSON.stringify({ fingerprint })) throw failure()
  } else if (fingerprint) {
    // Never re-label an existing unsanitized store as a secure archive.
    if ((await readdir(dataDir)).some(name => !/^writer-lock\.db(?:-journal|-wal|-shm)?$/.test(name))) throw failure()
    await writeFile(marker, JSON.stringify({ fingerprint }), { flag: "wx", mode: 0o600 })
  }
  return policy ? createArchiveSecurity(policy) : undefined
}
