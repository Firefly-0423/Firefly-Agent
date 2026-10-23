import { describe, expect, it } from "vitest";
import {
  normalizeReasoningLevels,
  resolveEffectiveReasoning,
  resolveReasoningCapability,
} from "./reasoning";

describe("normalizeReasoningLevels", () => {
  it("treats a missing or non-object value as 'not declared'", () => {
    for (const input of [undefined, null, "high", 3, true]) expect(normalizeReasoningLevels(input)).toBeUndefined();
  });

  it("keeps known efforts once, ordered from weakest to strongest", () => {
    expect(normalizeReasoningLevels({ efforts: ["max", "low", "low", "bogus", "high"] })).toEqual({ efforts: ["low", "high", "max"] });
  });

  it("accepts an API that only has an on/off switch", () => {
    expect(normalizeReasoningLevels({ efforts: [], allowOff: true })).toEqual({ efforts: [], allowOff: true });
    expect(normalizeReasoningLevels({})).toEqual({ efforts: [] });
  });

  it("only honours explicit true for the flags", () => {
    expect(normalizeReasoningLevels({ efforts: ["low"], allowOff: "yes" })).toEqual({ efforts: ["low"] });
    expect(normalizeReasoningLevels({ efforts: ["low"], allowOff: true, pro: true })).toEqual({ efforts: ["low"], allowOff: true });
  });
});

describe("resolveReasoningCapability with a declared level set", () => {
  it("falls back to the model-name table when nothing is declared", () => {
    const cap = resolveReasoningCapability("chatgpt", "gpt-6-astra");
    expect(cap.supportedEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("lets the API profile narrow a known model", () => {
    const cap = resolveReasoningCapability("chatgpt", "gpt-6-astra", { efforts: ["low", "high"] });
    expect(cap.control).toBe("effort");
    expect(cap.supportedEfforts).toEqual(["low", "high"]);
    expect(cap.supportsDisable).toBe(false);
    expect(cap.requestStyle).toBe("openai-effort");
  });

  it("makes an unknown model on a custom endpoint controllable and actually sends the field", () => {
    const unknown = resolveReasoningCapability("custom", "my-proxy-model");
    expect(unknown.control).toBe("none");
    expect(unknown.requestStyle).toBe("none");

    const cap = resolveReasoningCapability("custom", "my-proxy-model", { efforts: ["low", "medium", "high"], allowOff: true });
    expect(cap.control).toBe("effort");
    expect(cap.requestStyle).toBe("openai-effort");
    expect(cap.supportsDisable).toBe(true);
    expect(cap.defaultEffort).toBe("medium");
  });

  it("uses the adapter's own wire style as the fallback for unknown models", () => {
    const cap = resolveReasoningCapability("custom", "my-proxy-model", { efforts: ["high"] }, "anthropic-adaptive");
    expect(cap.requestStyle).toBe("anthropic-adaptive");
  });

  it("an empty effort list becomes a plain on/off toggle", () => {
    const cap = resolveReasoningCapability("custom", "m", { efforts: [], allowOff: true });
    expect(cap.control).toBe("toggle");
    expect(cap.supportedEfforts).toBeUndefined();
    expect(cap.defaultEffort).toBeUndefined();
  });

  it("an effort-less OpenAI-style API without 'can turn off' exposes no control, since both sides would send the same body", () => {
    expect(resolveReasoningCapability("custom", "m", { efforts: [] }).control).toBe("none");
    expect(resolveReasoningCapability("custom", "m", { efforts: [] }, "anthropic-adaptive").control).toBe("toggle");
    expect(resolveReasoningCapability("custom", "m", { efforts: [], allowOff: true }).control).toBe("toggle");
  });

  it("clamps a saved effort the API does not declare to the declared default", () => {
    const cap = resolveReasoningCapability("chatgpt", "gpt-6-astra", { efforts: ["low", "medium"] });
    expect(resolveEffectiveReasoning({ mode: "on", effort: "max" }, cap)).toEqual({ mode: "on", effort: "medium" });
    expect(resolveEffectiveReasoning({ mode: "on", effort: "low" }, cap)).toEqual({ mode: "on", effort: "low" });
  });

  it("never exposes PRO: effort is clamped to the declared levels only", () => {
    const base = resolveReasoningCapability("chatgpt", "gpt-6-astra");
    expect(resolveEffectiveReasoning({ mode: "on", effort: "max" }, base)).toEqual({ mode: "on", effort: "max" });
    const narrowed = resolveReasoningCapability("chatgpt", "gpt-6-astra", { efforts: ["low"] });
    expect(resolveEffectiveReasoning({ mode: "on", effort: "max" }, narrowed)).toEqual({ mode: "on", effort: "low" });
  });
});
