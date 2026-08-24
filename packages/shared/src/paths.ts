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
import { tmpdir } from "node:os";
import path from "node:path";

export function defaultSidecarDataDir(name: string): string {
  const base = process.env.XDG_RUNTIME_DIR ?? tmpdir();
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  return uid !== null ? path.join(base, `${name}-${uid}`) : path.join(base, name);
}
