import { expect, it } from "vitest";
import * as modes from "./memory-session-modes";

function registry() {
  const create = (modes as Record<string, unknown>).createMemorySessionModes;
  expect(create).toBeTypeOf("function");
  return (create as () => { bind(id: string, mode: "persistent" | "temporary"): void; require(id: string): string; capture(id: string): Readonly<{mode: string; revision: number}>; remove(id: string): void })();
}
it("rejects a session whose mode was not registered by Main", () => {
  expect(() => registry().require("session-a")).toThrow("MEMORY_SESSION_MODE_DENIED");
});
it("preserves the registered mode and rejects both in-place mode changes", () => {
  const r = registry();
  for (const mode of ["persistent", "temporary"] as const) {
    r.bind(mode, mode);
    expect(r.require(mode)).toBe(mode);
    const capture = r.capture(mode);
    r.bind(mode, mode);
    expect(r.capture(mode)).toBe(capture);
    expect(() => r.bind(mode, mode === "persistent" ? "temporary" : "persistent")).toThrow("MEMORY_SESSION_MODE_DENIED");
    expect(r.capture(mode)).toBe(capture);
  }
});
it("removing and recreating a session produces a different immutable binding", () => {
  const r = registry(); r.bind("session-a", "persistent");
  const old = r.capture("session-a");
  expect(Object.isFrozen(old)).toBe(true);
  r.remove("session-a");
  expect(() => r.capture("session-a")).toThrow("MEMORY_SESSION_MODE_DENIED");
  r.bind("session-a", "persistent");
  expect(r.capture("session-a")).not.toBe(old);
  expect(r.capture("session-a").revision).toBeGreaterThan(old.revision);
});
it("rejects invalid IDs and modes without creating a binding", () => {
  const r = registry();
  for (const id of ["", " ", "x".repeat(513)]) expect(() => r.bind(id, "persistent")).toThrow();
  expect(() => r.bind("session-a", "unknown" as never)).toThrow("MEMORY_SESSION_MODE_DENIED");
  expect(() => r.require("session-a")).toThrow("MEMORY_SESSION_MODE_DENIED");
});
