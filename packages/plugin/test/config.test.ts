import { describe, expect, test, beforeEach } from "bun:test";
import { parseOptions, PluginOptionsSchema, DEFAULT_OPTIONS } from "../src/config";
import { resolveRtkEntry, resolveHeadroomEntry, clearSidecarCache } from "../src/sidecar";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("config: parseOptions", () => {
  test("default values applied when input is empty", () => {
    const options = parseOptions({});

    expect(options.enabled).toBe(true);
    expect(options.dataDir).toContain("bluecode-headroom");
    expect(options.rtk.budgetTokens).toBe(512);
    expect(options.rtk.timeoutMs).toBe(40);
    expect(options.rtk.minBytes).toBe(512);
    expect(options.headroom.triggerRatio).toBe(0.7);
    expect(options.headroom.retainRecentTurns).toBe(4);
    expect(options.headroom.fallback).toBe("upstream");
  });

  test("explicit values override defaults", () => {
    const options = parseOptions({
      enabled: false,
      dataDir: "/custom/data",
      rtk: { budgetTokens: 1024, timeoutMs: 100, minBytes: 1024, entry: "/custom/rtk" },
      headroom: { triggerRatio: 0.8, retainRecentTurns: 2, fallback: "passthrough", socketPath: "/custom.sock", entry: "/custom/headroom" },
      sidecarDir: "/custom/sidecar",
    });

    expect(options.enabled).toBe(false);
    expect(options.dataDir).toBe("/custom/data");
    expect(options.rtk.budgetTokens).toBe(1024);
    expect(options.rtk.timeoutMs).toBe(100);
    expect(options.rtk.minBytes).toBe(1024);
    expect(options.rtk.entry).toBe("/custom/rtk");
    expect(options.headroom.triggerRatio).toBe(0.8);
    expect(options.headroom.retainRecentTurns).toBe(2);
    expect(options.headroom.fallback).toBe("passthrough");
    expect(options.headroom.socketPath).toBe("/custom.sock");
    expect(options.headroom.entry).toBe("/custom/headroom");
    expect(options.sidecarDir).toBe("/custom/sidecar");
  });

  test("partial rtk config merges with defaults", () => {
    const options = parseOptions({ rtk: { budgetTokens: 2000 } });

    expect(options.rtk.budgetTokens).toBe(2000);
    expect(options.rtk.timeoutMs).toBe(40); // default
    expect(options.rtk.minBytes).toBe(512); // default
  });

  test("partial headroom config merges with defaults", () => {
    const options = parseOptions({ headroom: { retainRecentTurns: 10 } });

    expect(options.headroom.triggerRatio).toBe(0.7); // default
    expect(options.headroom.retainRecentTurns).toBe(10);
    expect(options.headroom.fallback).toBe("upstream"); // default
  });

  test("invalid triggerRatio rejected", () => {
    expect(() => parseOptions({ headroom: { triggerRatio: 1.5 } })).toThrow();
    expect(() => parseOptions({ headroom: { triggerRatio: -0.1 } })).toThrow();
  });

  test("invalid fallback rejected", () => {
    expect(() => parseOptions({ headroom: { fallback: "invalid" } })).toThrow();
  });

  test("DEFAULT_OPTIONS matches parseOptions({})", () => {
    const parsed = parseOptions({});
    expect(DEFAULT_OPTIONS).toEqual(parsed);
  });
});

describe("sidecar: resolveRtkEntry", () => {
  beforeEach(() => {
    clearSidecarCache();
    delete process.env.BLUECODE_SIDECAR_DIR;
  });

  test("explicit rtk.entry option takes precedence", () => {
    const options = parseOptions({ rtk: { entry: "/explicit/rtk" } });
    expect(resolveRtkEntry(options)).toBe("/explicit/rtk");
  });

  test("BLUECODE_SIDECAR_DIR env used when no explicit entry", () => {
    process.env.BLUECODE_SIDECAR_DIR = "/env/sidecar";
    const options = parseOptions({});
    expect(resolveRtkEntry(options)).toBe("/env/sidecar/rtk/src/bin.ts");
  });

  test("package-relative fallback when no explicit entry or env", () => {
    const options = parseOptions({});
    const expected = path.resolve(__dirname, "../../rtk/src/bin.ts");
    expect(resolveRtkEntry(options)).toBe(expected);
  });

  test("result is cached", () => {
    const options = parseOptions({});
    const first = resolveRtkEntry(options);
    const second = resolveRtkEntry(options);
    expect(first).toBe(second);
  });
});

describe("sidecar: resolveHeadroomEntry", () => {
  beforeEach(() => {
    clearSidecarCache();
    delete process.env.BLUECODE_SIDECAR_DIR;
  });

  test("explicit headroom.entry option takes precedence", () => {
    const options = parseOptions({ headroom: { entry: "/explicit/headroom" } });
    expect(resolveHeadroomEntry(options)).toBe("/explicit/headroom");
  });

  test("BLUECODE_SIDECAR_DIR env used when no explicit entry", () => {
    process.env.BLUECODE_SIDECAR_DIR = "/env/sidecar";
    const options = parseOptions({});
    expect(resolveHeadroomEntry(options)).toBe("/env/sidecar/headroomd/src/bin.ts");
  });

  test("package-relative fallback when no explicit entry or env", () => {
    const options = parseOptions({});
    const expected = path.resolve(__dirname, "../../headroomd/src/bin.ts");
    expect(resolveHeadroomEntry(options)).toBe(expected);
  });

  test("result is cached", () => {
    const options = parseOptions({});
    const first = resolveHeadroomEntry(options);
    const second = resolveHeadroomEntry(options);
    expect(first).toBe(second);
  });
});