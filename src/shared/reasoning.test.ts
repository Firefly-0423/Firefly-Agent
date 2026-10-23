import { describe, expect, it } from "vitest";
import { MODEL_REASONING_RULES, normalizeReasoningPreference, foldReasoning, resolveEffectiveReasoning,
  resolveReasoningCapability, type ReasoningCapability, type ReasoningPreference, type ReasoningEffort } from "./reasoning";

describe("model reasoning contracts", () => {
  const effortLevels = ["low", "medium", "high", "xhigh", "max"];
  it.each<[string, string, Partial<ReasoningCapability>]>([
    ["kimi", "kimi-k3", { control: "effort", requestStyle: "openai-effort", supportedEfforts: ["low", "high", "max"], defaultEffort: "high", supportsDisable: false, autoEffort: "high" }],
    ["chatgpt", "gpt-6-astra", { control: "effort", requestStyle: "openai-effort", supportedEfforts: effortLevels as ReasoningEffort[], supportsDisable: false }],
    ["chatgpt", "gpt-5.6", { control: "effort", requestStyle: "openai-effort", supportedEfforts: effortLevels as ReasoningEffort[], supportsDisable: true }],
    ["chatgpt", "gpt-5", { supportedEfforts: ["minimal", "low", "medium", "high"] }],
    ["chatgpt", "o4", { control: "effort" }],
    ["chatgpt", "o3-mini", { control: "effort" }],
    ["chatgpt", "o1-preview", { control: "effort" }],
    ["claude", "claude-sonnet-5", { control: "toggle-effort", requestStyle: "anthropic-adaptive" }],
    ["claude", "claude-fable-5", { control: "toggle-effort", requestStyle: "anthropic-adaptive", supportedEfforts: effortLevels as ReasoningEffort[] }],
    ["deepseek", "deepseek-flash", { control: "toggle-effort", requestStyle: "thinking-type", supportedEfforts: ["high", "max"], autoEffort: "high", supportsDisable: true }],
    ["deepseek", "deepseek-v4-pro", { control: "toggle-effort", supportedEfforts: ["high", "max"], autoEffort: "high" }],
    ["deepseek", "deepseek-v4-flash-vision-exp", { control: "toggle-effort", requestStyle: "thinking-type", supportedEfforts: ["high", "max"], autoEffort: "high" }],
    ["glm", "glm-5.2", { control: "toggle-effort", supportedEfforts: effortLevels as ReasoningEffort[], supportsDisable: true, autoEffort: "high" }],
    ["glm", "glm-5.3", { control: "toggle-effort", supportedEfforts: ["low", "high", "max"], supportsDisable: false, autoEffort: "high" }],
    ["glm", "glm-5.3-flash", { control: "toggle-effort", requestStyle: "thinking-type", supportedEfforts: ["low", "high", "max"], supportsDisable: false, autoEffort: "high" }],
    ["glm", "glm-4.7", { control: "toggle" }],
    ["qwen", "qwen3.8-2.4t-a95b", { control: "toggle", requestStyle: "qwen-enable-thinking", supportsDisable: true }],
    ["qwen", "qwen3.8-flash", { control: "toggle", requestStyle: "qwen-enable-thinking", supportsDisable: true }],
    ["qwen", "qwen3.8-max", { control: "toggle", requestStyle: "qwen-enable-thinking", supportsDisable: true }],
    ["qwen", "qwen3-max", { control: "toggle", requestStyle: "qwen-enable-thinking" }],
    ["qwen", "qwen-max-thinking", { control: "fixed-on" }],
    ["qwen", "qwen3-max-thinking", { control: "fixed-on" }],
    ["qwen", "qwen3-thinking", { control: "fixed-on" }],
    ["kimi", "kimi-k2.6", { control: "toggle", keepOnTools: true }],
    ["kimi", "kimi-k2.5", { control: "toggle", keepOnTools: false }],
    ["kimi", "kimi-k2.7-code-highspeed", { control: "fixed-on", requestStyle: "none" }],
    ["kimi", "kimi-k2.7-code", { control: "fixed-on", requestStyle: "none" }],
    ["minimax", "MiniMax-M3", { control: "toggle", requestStyle: "anthropic-adaptive" }],
    ["minimax", "MiniMax-M2.7", { control: "fixed-on" }],
    ["mimo", "mimo-v2.5-pro", { control: "toggle", requestStyle: "thinking-type" }],
    ["chatgpt", "gpt-4o", { control: "none" }],
    ["unrecognized-provider", "unrecognized-model", { control: "none", requestStyle: "none", supportsDisable: false }],
  ])("resolves %s model %s", (provider, model, expected) => {
    expect(resolveReasoningCapability(provider, model)).toMatchObject(expected);
  });

  it("does not mistake Kimi's switchable 2.5 model for a fixed-thinking model", () => {
    expect(resolveReasoningCapability("kimi", "kimi-k2.5").control).not.toBe("fixed-on");
    expect(resolveReasoningCapability("glm", "glm-4.7").supportedEfforts).toBeUndefined();
  });

  it.each(["unrecognized-provider", "minimax"])("recovers GLM capabilities from a hosted model under %s", provider => {
    expect(resolveReasoningCapability(provider, "glm-5.3-flash")).toMatchObject({
      control: "toggle-effort", requestStyle: "thinking-type", supportedEfforts: ["low", "high", "max"], supportsDisable: false,
    });
    if (provider === "unrecognized-provider") {
      expect(resolveReasoningCapability(provider, "glm-5.3-flash").autoEffort).toEqual("high");
      expect(resolveReasoningCapability(provider, "glm-5.3").control).toEqual("toggle-effort");
    }
  });

  it.each([["unrecognized-provider", "custom-catalog-model"], ["glm", "custom-model-outside-glm"]])(
    "keeps unmatched %s/%s uncontrolled", (provider, model) => {
      expect(resolveReasoningCapability(provider, model)).toMatchObject({ requestStyle: "none", control: "none" });
    },
  );

  it("exports only supported provider names, boolean disable flags and stateless matchers", () => {
    const providers = new Set(["openrouter", "mimo", "minimax", "qwen", "kimi", "glm", "deepseek", "claude", "chatgpt"]);
    for (const rule of MODEL_REASONING_RULES) {
      expect(providers.has(rule.providerId)).toEqual(true);
      expect(typeof rule.capability.supportsDisable).toEqual("boolean");
      expect(rule.modelPattern.flags.includes("g")).toEqual(false);
    }
  });
});

describe("stored reasoning preferences", () => {
  it.each<ReasoningEffort>(["max", "xhigh", "high", "medium", "low", "minimal"])("retains supported effort %s", effort => {
    expect(normalizeReasoningPreference({ effort, mode: "on" })).toStrictEqual({ mode: "on", effort });
  });
  it.each([null, undefined, "enabled", { mode: "invalid", effort: "high" }, { effort: "high" }])(
    "rejects input without a valid mode: %j", raw => {
      expect(normalizeReasoningPreference(raw)).toBeUndefined();
    },
  );
  it.each([
    [{ mode: "on", effort: "unrecognized" }, { mode: "on" }],
    [{ mode: "auto" }, { mode: "auto" }],
    [{ mode: "off", effort: null }, { mode: "off" }],
    [{ mode: "on", effort: "pro" }, { mode: "on", effort: "max" }],
    [{ mode: "on", proMode: true }, { mode: "on", effort: "max" }],
    [{ mode: "on", effort: "high", proMode: true }, { mode: "on", effort: "high" }],
    [{ mode: "on", effort: "high", proMode: "enabled" }, { mode: "on", effort: "high" }],
    [{ mode: "on", proMode: null }, { mode: "on" }],
  ])("normalizes legacy and optional fields in %j", (raw, expected) => {
    expect(normalizeReasoningPreference(raw)).toStrictEqual(expected);
  });

  const saved: ReasoningPreference = { mode: "on", effort: "high" };
  it("distinguishes omitted input, an explicit clear and an invalid update", () => {
    expect(foldReasoning(undefined, saved, false)).toStrictEqual(saved);
    expect(foldReasoning(undefined, undefined, false)).toBeUndefined();
    for (const clear of [null, undefined]) expect(foldReasoning(clear, saved, true)).toBeUndefined();
    for (const invalid of [{ mode: "invalid" }, "scalar"]) expect(foldReasoning(invalid, saved, true)).toStrictEqual(saved);
    expect(foldReasoning({ mode: "auto" }, saved, true)).toStrictEqual({ mode: "auto" });
    expect(foldReasoning({ mode: "on", effort: "unrecognized" }, saved, true)).toStrictEqual({ mode: "on" });
  });

  it("folds the selected profile or top-level value without inventing precedence itself", () => {
    const prior: ReasoningPreference = { mode: "auto" };
    expect(foldReasoning({ mode: "off" }, prior, true)).toStrictEqual({ mode: "off" });
    expect(foldReasoning({ mode: "on", effort: "low" }, prior, true)).toStrictEqual({ mode: "on", effort: "low" });
    expect(foldReasoning(undefined, prior, false)).toStrictEqual(prior);
    expect(foldReasoning({ mode: "on", effort: "low" }, undefined, true)).toStrictEqual({ mode: "on", effort: "low" });
  });
});

describe("runtime reasoning projection", () => {
  const switchable: ReasoningCapability = { control: "toggle", requestStyle: "thinking-type", supportsDisable: true };
  const adjustable: ReasoningCapability = { ...switchable, control: "toggle-effort", supportedEfforts: ["high", "max"], defaultEffort: "high" };
  const fixed: ReasoningCapability = { control: "fixed-on", requestStyle: "none", supportsDisable: false };

  it.each(["none", "dynamic"] as const)("forces automatic reasoning for %s control", control => {
    expect(resolveEffectiveReasoning({ mode: "on" }, { control, requestStyle: "none", supportsDisable: false })).toStrictEqual({ mode: "auto" });
  });
  it.each(["on", "off", "auto"] as const)("forces fixed thinking on for saved mode %s", mode => {
    expect(resolveEffectiveReasoning({ mode }, fixed)).toStrictEqual({ mode: "on" });
  });
  it("discards effort for fixed thinking even when the saved mode is off", () => {
    const effective = resolveEffectiveReasoning({ mode: "off", effort: "high" }, fixed);
    expect(effective).toStrictEqual({ mode: "on" });
    expect(effective.effort).toBeUndefined();
  });
  it("keeps an off preference for non-fixed control even when disable support is false", () => {
    expect(resolveEffectiveReasoning({ mode: "off" }, { ...adjustable, supportsDisable: false })).toStrictEqual({ mode: "off" });
  });
  it("uses a default effort for omitted or unsupported effort while preserving supported choices", () => {
    const narrow: ReasoningCapability = { ...adjustable, supportedEfforts: ["high"] };
    expect(resolveEffectiveReasoning({ mode: "on", effort: "max" }, narrow)).toStrictEqual({ mode: "on", effort: "high" });
    expect(resolveEffectiveReasoning({ mode: "on" }, adjustable)).toStrictEqual({ mode: "on", effort: "high" });
    expect(resolveEffectiveReasoning({ mode: "on", effort: "xhigh" }, { ...adjustable, supportedEfforts: ["high", "max", "xhigh"] }))
      .toStrictEqual({ mode: "on", effort: "xhigh" });
  });
  it.each(["auto", "off"] as const)("removes effort from runtime mode %s", mode => {
    expect(resolveEffectiveReasoning({ mode, effort: "high" }, switchable)).toStrictEqual({ mode });
  });
  it("defaults absent preferences to automatic without mutating saved preferences during fallback", () => {
    expect(resolveEffectiveReasoning(undefined, switchable)).toStrictEqual({ mode: "auto" });
    const saved: ReasoningPreference = { mode: "on", effort: "max" };
    expect(resolveEffectiveReasoning(saved, { ...adjustable, supportedEfforts: ["high"] })).toStrictEqual({ mode: "on", effort: "high" });
    expect(saved).toStrictEqual({ mode: "on", effort: "max" });
  });
});

describe("aggregator reasoning controls", () => {
  it.each(["openai/gpt-5.6", "anthropic/claude-sonnet-4.6", "unlisted/catalog-model"])("provides generic effort controls for %s", model => {
    const capability = resolveReasoningCapability("openrouter", model);
    expect(capability).toMatchObject({
      supportedEfforts: ["low", "medium", "high", "max"], defaultEffort: "medium",
      requestStyle: "openrouter-reasoning", control: "effort", supportsDisable: true,
    });
    expect(capability.autoEffort).toBeUndefined();
  });
  it("retains max and falls back from unsupported xhigh to medium", () => {
    const capability = resolveReasoningCapability("openrouter", "openai/gpt-5.6");
    expect(resolveEffectiveReasoning({ mode: "on", effort: "max" }, capability)).toStrictEqual({ mode: "on", effort: "max" });
    expect(resolveEffectiveReasoning({ mode: "on", effort: "xhigh" }, capability)).toStrictEqual({ mode: "on", effort: "medium" });
  });
  it("respects profile-declared effort levels while preserving the aggregator wire style", () => {
    expect(resolveReasoningCapability("openrouter", "openai/o3", { efforts: ["low", "high"] })).toMatchObject({
      control: "effort", requestStyle: "openrouter-reasoning", supportedEfforts: ["low", "high"], defaultEffort: "high",
    });
    expect(resolveReasoningCapability("openrouter", "catalog/model", { efforts: [], allowOff: true })).toMatchObject({
      control: "toggle", requestStyle: "openrouter-reasoning", supportsDisable: true,
    });
    expect(resolveReasoningCapability("openrouter", "catalog/model", { efforts: [] }).control).toEqual("none");
  });
  it("does not apply aggregator defaults to unrelated providers", () => {
    for (const [provider, model] of [["unrecognized-provider", "openai/gpt-5.6"], ["deepseek", "custom-catalog"], ["kimi", "custom-catalog"]]) {
      expect(resolveReasoningCapability(provider, model).control).toEqual("none");
    }
  });
});
