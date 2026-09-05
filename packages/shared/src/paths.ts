/**
 * Per-user default data directories for sidecar components.
 *
 * A fixed `<tmpdir>/bluecode-*` path is writable by every account on
 * multi-user hosts (e.g. Linux /tmp): one account could attach to another
 * account's daemon socket or plant objects in its CAS. Namespace by uid;
 * prefer XDG_RUNTIME_DIR when exported — it is purpose-built per-user 0700
 * runtime space. macOS tmpdir (/var/folders/…) is already per-user, where the
 * uid suffix is redundant but harmless.
 */
import { tmpdir, homedir } from "node:os"
import { createHash } from "node:crypto"
import path from "node:path"

export function defaultSidecarDataDir(name: string): string {
  const base = process.env.XDG_RUNTIME_DIR ?? tmpdir()
  const uid = typeof process.getuid === "function" ? process.getuid() : null
  return uid !== null ? path.join(base, `${name}-${uid}`) : path.join(base, name)
}

/** Durable application data. Never place canonical archives in runtime/tmp space. */
export function defaultDataDir(): string {
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, "bluecode")
  return process.platform === "darwin"
    ? path.join(homedir(), "Library", "Application Support", "bluecode")
    : path.join(homedir(), ".local", "share", "bluecode")
}

export function storageLayout(dataDir: string) {
  const root = path.resolve(dataDir)
  const key = createHash("sha256").update(root).digest("hex").slice(0, 20)
  const uid = typeof process.getuid === "function" ? process.getuid() : "user"
  // macOS sockaddr_un has a short limit; use a private short runtime directory.
  const preferred = process.env.XDG_RUNTIME_DIR ?? tmpdir()
  const base = Buffer.byteLength(preferred) < 52 ? preferred : "/tmp"
  const runtime = path.join(base, `bluecode-${uid}`)
  return {
    root,
    rtk: path.join(root, "storage-v2", "rtk"),
    headroom: path.join(root, "storage-v2", "headroom"),
    runtime,
    socket: path.join(runtime, `${key}.sock`),
  }
}
