/**
 * Redaction hook layer. Applied to content before it reaches the CAS store;
 * defaults to identity so nothing is transformed unless a policy is wired in.
 */
import { homedir, tmpdir } from "node:os";

export type Redactor = (text: string) => string;

/** Identity redactor: the default pre-persistence hook. */
export const noopRedactor: Redactor = (text) => text;

/** Compose redactors left-to-right: composeRedactors(f, g)(t) === g(f(t)). */
export function composeRedactors(...fns: Redactor[]): Redactor {
  return (text) => {
    let current = text;
    for (const fn of fns) {
      current = fn(current);
    }
    return current;
  };
}

/**
 * Egress scrubber for machine-local absolute paths in free text (error
 * messages, diagnostics). Spawn/connect failures embed entry and socket paths
 * (`/home/alice/…`, `/var/folders/…/bluecode-headroom-501/headroomd.sock`);
 * anything that flows into MODEL context goes through this first so the local
 * filesystem layout never leaves the machine. Home dir → `~`, per-user runtime
 * dirs (tmpdir, XDG_RUNTIME_DIR) → `<tmp>`.
 */
export function redactLocalPaths(text: string): string {
  let out = text;
  const prefixes: Array<[string, string]> = [
    [homedir(), "~"],
    [process.env.XDG_RUNTIME_DIR ?? "", "<tmp>"],
    [tmpdir(), "<tmp>"],
  ];
  for (const [prefix, marker] of prefixes) {
    // "/" as a prefix would mangle every absolute path; skip empty too.
    if (!prefix || prefix === "/") continue;
    out = out.split(`${prefix}/`).join(`${marker}/`).split(prefix).join(marker);
  }
  return out;
}
