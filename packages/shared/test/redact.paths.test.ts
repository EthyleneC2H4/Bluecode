import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { redactLocalPaths } from "../src/redact";

describe("redactLocalPaths", () => {
  test("collapses home-dir paths to ~", () => {
    const home = homedir();
    const out = redactLocalPaths(`failed to read ${home}/projects/x.ts`);
    expect(out).toBe("failed to read ~/projects/x.ts");
    // Bare home dir (no trailing segment) is also covered.
    expect(redactLocalPaths(`cannot chdir ${home}`)).toBe("cannot chdir ~");
  });

  test("collapses tmpdir and XDG_RUNTIME_DIR paths to <tmp>", () => {
    const socket = `${tmpdir()}/bluecode-headroom-501/headroomd.sock`;
    expect(redactLocalPaths(`headroomd: cannot connect to ${socket}: ECONNREFUSED`)).toBe(
      "headroomd: cannot connect to <tmp>/bluecode-headroom-501/headroomd.sock: ECONNREFUSED",
    );
    const xdg = process.env.XDG_RUNTIME_DIR;
    if (xdg) {
      expect(redactLocalPaths(`socket at ${xdg}/app.sock`)).toBe("socket at <tmp>/app.sock");
    }
  });

  test("leaves text without local prefixes untouched", () => {
    const msg = "headroomd: compress timed out after 5000ms";
    expect(redactLocalPaths(msg)).toBe(msg);
    expect(redactLocalPaths("/usr/local/bin/bun run /opt/entry.ts")).toBe(
      "/usr/local/bin/bun run /opt/entry.ts",
    );
  });
});
