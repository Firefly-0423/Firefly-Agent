import { expect, it, vi } from "vitest";
import { buildPerfSession, buildStreamingScript, perfSessionMeta } from "./fixture";

it("builds repeatable alternating history and matching metadata", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const options = { seed: 31, count: 12, dataset: "mixed" as const };
    const first = buildPerfSession(options);
    expect(buildPerfSession(options)).toEqual(first);
    expect(first.messages.map(message => message.role)).toEqual(Array.from({ length: 12 }, (_, i) => i % 2 ? "model" : "user"));
    expect(first.messages.every(message => message.content.length > 0)).toBe(true);
    expect(perfSessionMeta(first).messageCount).toBe(12);
  } finally {
    vi.useRealTimers();
  }
});

it("creates deterministic streaming scripts with start and finish events", () => {
  const options = { seed: 7, durationMs: 5000, dataset: "plain" as const };
  const script = buildStreamingScript(options);
  expect(buildStreamingScript(options)).toEqual(script);
  expect(script.events[0].event.type).toBe("RUN_STARTED");
  expect(script.events.at(-1)?.event.type).toBe("RUN_FINISHED");
  expect(script.deltaCount).toBeGreaterThan(0);
});
