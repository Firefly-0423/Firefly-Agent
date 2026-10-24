import { describe, expect, it } from "vitest";
import { isContextUsageSnapshot, type ContextUsageSnapshot } from "./context-usage";

function snapshot(overrides: Partial<ContextUsageSnapshot> = {}): ContextUsageSnapshot {
  return {
    phase: "preRequest",
    contextWindowTokens: 200_000,
    totalTokens: 1_234,
    categories: [
      { key: "systemPrompt", tokens: 100 },
      { key: "tools", tokens: 200 },
      { key: "skills", tokens: 300 },
      { key: "runtimeAndToolLogs", tokens: 400 },
      { key: "conversation", tokens: 234 },
      { key: "other", tokens: 0 },
    ],
    messageCount: 7,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("isContextUsageSnapshot", () => {
  it("accepts preRequest and terminal snapshots", () => {
    expect(isContextUsageSnapshot(snapshot())).toBe(true);
    expect(isContextUsageSnapshot(snapshot({ phase: "terminal" }))).toBe(true);
  });

  it("accepts optional run metadata and an empty category list", () => {
    expect(isContextUsageSnapshot(snapshot({ runId: "run-1", round: 0, categories: [] }))).toBe(true);
    expect(isContextUsageSnapshot(snapshot({ categories: [] }))).toBe(true);
  });

  it("accepts the legacy toolDefinitions category key", () => {
    expect(isContextUsageSnapshot(snapshot({ categories: [{ key: "toolDefinitions", tokens: 12 }] }))).toBe(true);
  });

  it.each([
    ["negative context window", { contextWindowTokens: -1 }],
    ["zero context window", { contextWindowTokens: 0 }],
    ["fractional total", { totalTokens: 1.5 }],
    ["negative total", { totalTokens: -1 }],
    ["negative message count", { messageCount: -2 }],
    ["fractional message count", { messageCount: 2.5 }],
    ["negative category tokens", { categories: [{ key: "other", tokens: -3 }] }],
    ["fractional category tokens", { categories: [{ key: "other", tokens: 0.5 }] }],
  ])("rejects malformed counters: %s", (_label, overrides) => {
    expect(isContextUsageSnapshot(snapshot(overrides as Partial<ContextUsageSnapshot>))).toBe(false);
  });

  it.each([null, undefined, 0, 1, "", "snapshot", true, []])("rejects non-object payload %j", (value) => {
    expect(isContextUsageSnapshot(value)).toBe(false);
  });

  it.each([
    ["missing phase", { phase: undefined }],
    ["unknown phase", { phase: "final" }],
    ["phase wrong case", { phase: "PreRequest" }],
  ])("rejects %s", (_label, overrides) => {
    expect(isContextUsageSnapshot(snapshot(overrides as Partial<ContextUsageSnapshot>))).toBe(false);
  });

  it.each([
    ["contextWindowTokens", { contextWindowTokens: undefined }],
    ["contextWindowTokens string", { contextWindowTokens: "200000" }],
    ["contextWindowTokens NaN", { contextWindowTokens: Number.NaN }],
    ["contextWindowTokens Infinity", { contextWindowTokens: Number.POSITIVE_INFINITY }],
    ["totalTokens", { totalTokens: undefined }],
    ["totalTokens string", { totalTokens: "12" }],
    ["totalTokens NaN", { totalTokens: Number.NaN }],
    ["messageCount", { messageCount: undefined }],
    ["messageCount NaN", { messageCount: Number.NaN }],
    ["updatedAt", { updatedAt: undefined }],
    ["updatedAt Infinity", { updatedAt: Number.POSITIVE_INFINITY }],
  ])("rejects invalid numeric field: %s", (_label, overrides) => {
    expect(isContextUsageSnapshot(snapshot(overrides as Partial<ContextUsageSnapshot>))).toBe(false);
  });

  it.each([
    ["missing categories", { categories: undefined }],
    ["categories object", { categories: {} }],
    ["category null", { categories: [null] }],
    ["category string", { categories: ["tools"] }],
    ["unknown category key", { categories: [{ key: "unknown", tokens: 1 }] }],
    ["missing category key", { categories: [{ tokens: 1 }] }],
    ["missing category tokens", { categories: [{ key: "tools" }] }],
    ["category tokens string", { categories: [{ key: "tools", tokens: "1" }] }],
    ["category tokens NaN", { categories: [{ key: "tools", tokens: Number.NaN }] }],
    ["one invalid category among valid ones", {
      categories: [{ key: "tools", tokens: 1 }, { key: "nope", tokens: 2 }],
    }],
  ])("rejects invalid categories: %s", (_label, overrides) => {
    expect(isContextUsageSnapshot(snapshot(overrides as Partial<ContextUsageSnapshot>))).toBe(false);
  });

  it("ignores extra fields on the snapshot and on categories", () => {
    const value = {
      ...snapshot({ categories: [{ key: "tools", tokens: 1, extra: true } as never] }),
      extra: "ignored",
    };
    expect(isContextUsageSnapshot(value)).toBe(true);
  });
});
