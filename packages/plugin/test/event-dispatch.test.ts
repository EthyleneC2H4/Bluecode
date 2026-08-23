import { describe, expect, test } from "bun:test";
import { eventToIdleInput } from "../src/headroom";

// Upstream dispatch shape (opencode plugin/index.ts): hook["event"] receives
// { event: { id, type, properties } } — payload fields live under properties.
describe("eventToIdleInput: upstream event envelope", () => {
  test("session.idle maps to sessionID-only input", () => {
    expect(
      eventToIdleInput({ type: "session.idle", properties: { sessionID: "ses_1" } }),
    ).toEqual({ sessionID: "ses_1" });
  });

  test("session.status idle carries the status through", () => {
    expect(
      eventToIdleInput({
        type: "session.status",
        properties: { sessionID: "ses_2", status: { type: "idle" } },
      }),
    ).toEqual({ sessionID: "ses_2", status: { type: "idle" } });
  });

  test("non-idle statuses are ignored", () => {
    expect(
      eventToIdleInput({
        type: "session.status",
        properties: { sessionID: "ses_3", status: { type: "busy" } },
      }),
    ).toBeNull();
    expect(
      eventToIdleInput({
        type: "session.status",
        properties: { sessionID: "ses_3", status: { type: "retry" } },
      }),
    ).toBeNull();
  });

  test("unrelated event types are ignored", () => {
    expect(
      eventToIdleInput({
        type: "message.updated",
        properties: { sessionID: "ses_4" },
      }),
    ).toBeNull();
  });

  test("missing or anonymous sessions are ignored", () => {
    expect(eventToIdleInput({ type: "session.idle", properties: {} })).toBeNull();
    expect(eventToIdleInput({ type: "session.idle" })).toBeNull();
  });

  // M7 real-session smoke regression: reading sessionID off the envelope top
  // level left it undefined in the real host, so idle never fired.
  test("flat legacy shape (no properties) does not falsely match", () => {
    const flat = { type: "session.idle", sessionID: "ses_flat" };
    expect(eventToIdleInput(flat as any)).toBeNull();
  });
});
