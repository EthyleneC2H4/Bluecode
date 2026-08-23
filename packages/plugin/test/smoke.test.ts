import { describe, expect, test } from "bun:test";
import bluecodePlugin from "../src/index";

describe("@bluecode/plugin", () => {
  // opencode's legacy plugin loader iterates every named export of the
  // module and requires each to be a plugin function; the factory must ride
  // on the default export alone (M7 real-session smoke found a string
  // export breaking load with "Plugin export is not a function").
  test("default export is an async plugin factory function", () => {
    expect(typeof bluecodePlugin).toBe("function");
    expect(bluecodePlugin.constructor.name).toBe("AsyncFunction");
  });
});
