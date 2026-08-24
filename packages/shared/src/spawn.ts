/**
 * Sidecar interpreter argv construction.
 *
 * Moved here from @bluecode/rtk so @bluecode/headroomd can share it without
 * violating the documented dependency direction (sidecar packages may depend
 * on @bluecode/contracts and @bluecode/shared only).
 */

/**
 * Build the interpreter argv that runs a TS entry file.
 *
 * process.execPath is only a valid script runner when the host IS the bun
 * runtime. Inside a compiled single-file executable (real-session smoke, M7:
 * opencode embeds bun), execPath is the host binary and `[execPath, "run",
 * entry]` never boots a daemon — fall back to "bun" from PATH there.
 */
export function bunSpawnArgv(entry: string, execPath: string = process.execPath): string[] {
  const base = execPath.split(/[\\/]/).pop() ?? "";
  if (isBunExecutable(base)) return [execPath, "run", entry];
  // Diagnostic mirrors the repo's stderr style (headroomd boot diagnostics);
  // a silent PATH fallback would make misconfigured hosts undiagnosable.
  process.stderr.write(
    `[bluecode] execPath ${JSON.stringify(execPath)} is not a bun runtime; spawning entry via "bun" from PATH\n`,
  );
  return ["bun", "run", entry];
}

/** True when the executable's basename looks like the bun runtime itself. */
function isBunExecutable(base: string): boolean {
  if (base === "bun") return true;
  if (base.endsWith(".exe")) return /^bun(?:-[A-Za-z0-9._-]+)?\.exe$/.test(base);
  return base.startsWith("bun-");
}
