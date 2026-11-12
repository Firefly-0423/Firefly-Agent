import { it, expect } from "vitest";
import { clearUsage, applyUsageToDay, type TokenUsageDay } from "./token-usage-store";

it("counts cache coverage only for calls that supply cache usage", () => {
  const ledger: TokenUsageDay = { requests: 0, cacheCreation: 0, miss: 0, hit: 0, output: 0, input: 0 };
  applyUsageToDay(ledger, 36, 7, 1, 11, "orchid-model");
  applyUsageToDay(ledger, 14, 3, 1, undefined, "orchid-model");
  expect(ledger.models?.["orchid-model"]).toEqual({
    requests: 2, cacheUsageRequests: 1, cacheCreation: 0, input: 50, output: 10, hit: 11, miss: 25,
  });
});
it("empties the mutable day collection including all nested model counters", () => {
  const entry = { requests: 1, cacheUsageRequests: 1, cacheCreation: 0, input: 36, output: 7, hit: 11, miss: 25 };
  const ledger: Record<string, TokenUsageDay> = { "2026-09-23": { ...entry, models: { "orchid-model": { ...entry } } } };
  clearUsage(ledger);
  expect(ledger).toEqual({});
});
