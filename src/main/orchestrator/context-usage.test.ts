import { it, describe, expect } from "vitest";
import { buildContextUsageSnapshot, type ContextUsageSnapshotInput } from "./context-usage";
import { estimateTokens as cost } from "./context-manager";
import { buildCompactionCheckpoint } from "./harness/compaction";

describe("Context usage presented for a model turn", () => {
  const measure = (options: Partial<ContextUsageSnapshotInput> = {}) => buildContextUsageSnapshot({
    messages: [], personaContent: "Act as a desktop assistant.", contextWindowTokens: 96_000, phase: "preRequest", ...options,
  });
  const buckets = (options: Partial<ContextUsageSnapshotInput> = {}) => Object.fromEntries(measure(options).categories.map(({ key, tokens }) => [key, tokens]));

  it("separates skills and schemas while preserving the tool-layer charge", () => {
    const schema = { name: "calendar_lookup", description: "Find scheduled items", parameters: { type: "object", properties: { day: { type: "string" } } } };
    const skill = "## Calendar skills\nRead and compare events";
    const layer = "Tool access instructions\n\n---\n\n" + skill + "\n\nWorkspace: E:/Calendar";
    const values = buckets({ toolLayerContent: layer, skillLayerContent: skill, toolSpecs: [schema] });
    const schemaCost = cost(schema.name + schema.description + JSON.stringify(schema.parameters));
    expect(values.skills).toEqual(cost(skill));
    expect(values.tools).toEqual(cost(layer) - cost(skill) + schemaCost);
    expect(values.tools + values.skills).toEqual(cost(layer) + schemaCost);
    expect(buckets({ toolLayerContent: layer })).toMatchObject({ skills: 0, tools: cost(layer) });
  });

  it("classifies checkpoints before internal visibility and tools as runtime logs", () => {
    const checkpoint = buildCompactionCheckpoint("The user selected the morning appointment.");
    const result = measure({ messages: [
      { role: "assistant", content: "Checking the calendar" },
      { role: "user", content: "List tomorrow's events" },
      { role: "tool", name: "calendar_lookup", toolCallId: "agenda-call", content: "09:30 dentist" },
      { role: "user", visibility: "internal", content: "Timezone is UTC" }, checkpoint,
    ] });
    expect(result.messageCount).toBe(5);
    expect(Object.fromEntries(result.categories.map(({ key, tokens }) => [key, tokens]))).toEqual({
      systemPrompt: cost("Act as a desktop assistant."), tools: 0, skills: 0,
      runtimeAndToolLogs: cost("09:30 dentist") + cost("Timezone is UTC") + 8,
      conversation: cost("Checking the calendar") + cost("List tomorrow's events") + cost(checkpoint.content as string) + 12,
      other: 0,
    });
    expect(buckets({ messages: [{ ...checkpoint, visibility: "internal" }] })).toMatchObject({ conversation: cost(checkpoint.content as string) + 4, runtimeAndToolLogs: 0 });
    expect(buckets({ messages: [{ role: "tool", visibility: "internal", toolCallId: "agenda-call", content: "available" }] })).toMatchObject({ conversation: 0, runtimeAndToolLogs: cost("available") + 4 });
  });

  it("charges a trimmed runtime envelope once without changing conversation accounting", () => {
    const values = buckets({ messages: [{ role: "user", content: "Open my agenda" }], runtimeContext: "  desktop: ready\nlocale: en-GB  " });
    expect(values.runtimeAndToolLogs).toBe(cost("<runtime_context>\ndesktop: ready\nlocale: en-GB\n</runtime_context>"));
    expect(values.conversation).toBe(cost("Open my agenda") + 4);
  });

  it("reports an additive total for empty history and carries run coordinates", () => {
    const empty = measure();
    expect(empty.messageCount).toEqual(0);
    expect(empty.categories[0]).toEqual({ key: "systemPrompt", tokens: cost("Act as a desktop assistant.") });
    expect(empty.totalTokens).toBe(empty.categories.reduce((total, entry) => total + entry.tokens, 0));
    expect(measure({ phase: "terminal", runId: "calendar-run", round: 7 })).toMatchObject({ phase: "terminal", runId: "calendar-run", round: 7, contextWindowTokens: 96_000 });
    expect(empty).not.toHaveProperty("measured");
  });

  describe("with the provider's reported usage", () => {
    const messages = [{ role: "user" as const, content: "列出待办" }, { role: "assistant" as const, content: "好的" }, { role: "tool" as const, content: "x".repeat(400) }];
    it("totals what the request carried, its reply and the messages added since, and shows what the estimate missed", () => {
      const snapshot = measure({ messages, measured: { inputTokens: 5_000, outputTokens: 40, messageCount: 1 } });
      const since = cost("x".repeat(400)) + 4;
      expect(snapshot).toMatchObject({ measured: true, totalTokens: 5_040 + since });
      const parts = snapshot.categories.filter(part => part.key !== "retrieved").reduce((sum, part) => sum + part.tokens, 0);
      expect(snapshot.categories.find(part => part.key === "retrieved")?.tokens).toBe(5_040 + since - parts);
      expect(snapshot.categories.reduce((sum, part) => sum + part.tokens, 0)).toBe(snapshot.totalTokens);
    });
    it("scales an estimate that overshoots down to the reported total", () => {
      const snapshot = measure({ messages, personaContent: "persona ".repeat(2_000), measured: { inputTokens: 300, outputTokens: 0, messageCount: 3 } });
      expect(snapshot.totalTokens).toBe(300);
      expect(snapshot.categories.reduce((sum, part) => sum + part.tokens, 0)).toBe(300);
      expect(snapshot.categories.some(part => part.key === "retrieved")).toBe(false);
    });
    it("falls back to the estimate when the provider reported nothing usable", () => {
      expect(measure({ measured: { inputTokens: 0, outputTokens: 0, messageCount: 0 } })).not.toHaveProperty("measured");
    });
  });
});
