import { afterEach, expect, it, vi } from "vitest";
vi.mock("../memory/memory-store", () => ({ memoryStore: {} }));
import { L2_FIXTURES, L2_ROUNDS } from "./scenarios/l2-working-memory";
afterEach(() => vi.restoreAllMocks());
it("runs every fixture round in order, prints bounded activations and limits recall to four", async () => {
  vi.resetModules(); const log = vi.spyOn(console, "log").mockImplementation(() => {}); await import("./run-l2-sim"); const rows = log.mock.calls.map(c => c.map(String).join(" "));
  expect(rows[0]).toBe("V5 L2 Working Memory Simulator"); expect(rows.filter(r => r.startsWith("\n--- Round"))).toEqual(L2_ROUNDS.map(r => `\n--- Round ${r.index + 1} ---`)); expect(rows.filter(r => r.startsWith("User: "))).toEqual(L2_ROUNDS.map(r => "User: " + r.userText));
  const recalled = rows.filter(r => r.startsWith("Recalled:")); expect(recalled).toHaveLength(L2_ROUNDS.length); expect(recalled.every(r => r.slice(11, -1).split(", ").filter(Boolean).length <= 4)).toBe(true);
  const states = rows.filter(r => /^  l2_/.test(r)); expect(states).toHaveLength(L2_FIXTURES.length * L2_ROUNDS.length); expect(states.every(r => { const value = Number(/A=\s*([\d.]+)/.exec(r)?.[1]); return Number.isFinite(value) && value >= 0 && value <= 100; })).toBe(true); expect(states.some(r => r.includes("state=Archived"))).toBe(true);
});
