/**
 * Best-effort filesystem hardening: a chmod failure must degrade to a warning
 * instead of killing daemon startup. Legitimate failure modes exist — a
 * root-owned dir left by a previous uid's run, exotic mounts where chmod is
 * EINVAL or a no-op, read-only fallback paths. Losing the permission
 * tightening is survivable; losing the daemon (and with it every session's
 * history compression) over a permission bit is not.
 */
import { chmodSync } from "node:fs";

/**
 * Apply `mode` to `path`. Returns false and warns on failure rather than
 * throwing. `chmod` is injectable so tests can simulate EACCES/EPERM without
 * mocking node:fs.
 */
export function hardenPath(
  path: string,
  mode: number,
  chmod: (path: string, mode: number) => void = chmodSync,
): boolean {
  try {
    chmod(path, mode);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "unknown";
    console.warn(
      `[headroomd] chmod ${mode.toString(8)} failed on a data/socket path (${code}); continuing unhardened`,
    );
    return false;
  }
}
