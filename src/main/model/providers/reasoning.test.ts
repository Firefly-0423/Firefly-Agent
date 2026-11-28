import { it, expect, describe } from "vitest";
import { applyReasoningPreference as apply } from "./reasoning";
import type { ReasoningCapability as Capability, ReasoningPreference as Preference } from "../../../shared/reasoning";

const context = { providerId: "calendar-provider", model: "calendar-model", hasTools: false };
const capability = (control: Capability["control"], requestStyle: Capability["requestStyle"], extra: Partial<Capability> = {}): Capability => ({ control, requestStyle, supportsDisable: true, ...extra });
function wire(cap: Capability, pref: Preference, body: Record<string, unknown> = {}, hasTools = false) { return apply(body, pref, cap, { ...context, hasTools }); }

describe("Reasoning control translated into request fields", () => {
  it("leaves unsupported, dynamic and undecided controls unchanged without mutating the input", () => {
    const input = { model: "agenda-model", messages: [{ role: "user", content: "Read my calendar" }] };
    const before = structuredClone(input);
    for (const control of ["none", "dynamic"] as const) for (const mode of ["on", "off"] as const) expect(wire(capability(control, "none", { supportsDisable: false }), { mode }, input)).toEqual(input);
    for (const cap of [capability("none", "none"), capability("toggle", "qwen-enable-thinking"), capability("toggle", "anthropic-adaptive")]) expect(wire(cap, { mode: "auto" }, input)).toEqual(input);
    const enabled = wire(capability("toggle", "anthropic-adaptive"), { mode: "on" }, input);
    expect(enabled.model).toEqual("agenda-model");
    expect(enabled.messages).toEqual([{ role: "user", content: "Read my calendar" }]);
    expect(enabled.thinking).toEqual({ type: "adaptive" });
    expect(input).toEqual(before);
  });

  it.each([
    ["thinking-type", "off", { thinking: { type: "enabled" } }],
    ["none", "off", {}],
    ["anthropic-adaptive", "auto", { thinking: { type: "adaptive" } }],
    ["anthropic-adaptive", "on", { thinking: { type: "adaptive" } }],
    ["openrouter-reasoning", "on", {}],
  ] as const)("keeps fixed-on %s active for preference %s", (style, mode, expected) => {
    expect(wire(capability("fixed-on", style, { supportsDisable: false }), { mode })).toEqual(expected);
  });

  it.each([
    ["qwen-enable-thinking", "on", { enable_thinking: true }],
    ["qwen-enable-thinking", "off", { enable_thinking: false }],
    ["thinking-type", "on", { thinking: { type: "enabled" } }],
    ["thinking-type", "off", { thinking: { type: "disabled" } }],
    ["anthropic-adaptive", "on", { thinking: { type: "adaptive" } }],
    ["anthropic-adaptive", "off", { thinking: { type: "disabled" } }],
  ] as const)("maps toggle style %s and preference %s", (style, mode, expected) => {
    expect(wire(capability("toggle", style), { mode })).toEqual(expected);
  });

  it("keeps thinking with tools only when that capability explicitly allows it", () => {
    expect(wire(capability("toggle", "thinking-type", { keepOnTools: true }), { mode: "on" }, {}, true)).toEqual({ thinking: { type: "enabled", keep: "all" } });
    expect(wire(capability("toggle", "thinking-type", { keepOnTools: false }), { mode: "on" }, {}, true)).toEqual({ thinking: { type: "enabled" } });
  });

  it("uses supported efforts, defaults, and an explicit disable only when supported", () => {
    const cap = capability("effort", "openai-effort", { supportedEfforts: ["high", "max"], defaultEffort: "high" });
    expect(wire(cap, { mode: "on", effort: "max" })).toEqual({ reasoning_effort: "max" });
    expect(wire(cap, { mode: "on", effort: "high" })).toEqual({ reasoning_effort: "high" });
    expect(wire(cap, { mode: "off" })).toEqual({ reasoning_effort: "none" });
    expect(wire({ ...cap, supportsDisable: false }, { mode: "off" })).toEqual({ reasoning_effort: "high" });
  });

  it.each(["thinking-type", "openai-effort"] as const)("maps auto effort and folds off into a safe default for mandatory %s", (style) => {
    const cap = capability(style === "thinking-type" ? "toggle-effort" : "effort", style, { supportsDisable: false, supportedEfforts: ["low", "high", "max"], defaultEffort: "high", autoEffort: "high" });
    const enabled = style === "thinking-type" ? { thinking: { type: "enabled" } } : {};
    expect(wire(cap, { mode: "auto" })).toEqual({ ...enabled, reasoning_effort: "high" });
    expect(wire(cap, { mode: "off" })).toEqual({ ...enabled, reasoning_effort: "high" });
    const effort = style === "thinking-type" ? "low" : "max";
    expect(wire(cap, { mode: "on", effort })).toEqual({ ...enabled, reasoning_effort: effort });
    if (style === "openai-effort") expect(wire(cap, { mode: "auto" })).not.toHaveProperty("thinking");
  });

  it("merges adaptive effort into existing output configuration and preserves unrelated fields", () => {
    const cap = capability("toggle-effort", "anthropic-adaptive", { supportedEfforts: ["low", "medium", "high"], defaultEffort: "high" });
    expect(wire(cap, { mode: "auto" }, { model: "agenda-model" })).toEqual({ model: "agenda-model" });
    expect(wire(cap, { mode: "on", effort: "high" }, { output_config: { metadata: "calendar" } })).toEqual({ output_config: { metadata: "calendar", effort: "high" }, thinking: { type: "adaptive" } });
    for (const effort of ["xhigh", "high"] as const) expect(wire(cap, { mode: "on", effort })).toEqual({ output_config: { effort: "high" }, thinking: { type: "adaptive" } });
    expect(wire(cap, { mode: "off" })).toEqual({ thinking: { type: "disabled" } });
    const merged = wire(cap, { mode: "on", effort: "high" }, { output_config: { format: "json", effort: "previous" } }).output_config as Record<string, unknown>;
    expect(merged.format).toEqual("json"); expect(merged.effort).toEqual("high");
    expect(wire(capability("toggle-effort", "thinking-type", { supportedEfforts: ["high", "max"], defaultEffort: "high" }), { mode: "on", effort: "max" })).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "max" });
  });

  it("distinguishes a declared OpenAI toggle's off state from its server-default on state", () => {
    const cap = capability("toggle", "openai-effort"), input = { model: "agenda-model" };
    const disabled = wire(cap, { mode: "off" }, input), enabled = wire(cap, { mode: "on" }, input);
    expect(disabled.reasoning_effort).toEqual("none");
    expect(enabled.reasoning_effort).toBeUndefined();
    expect(disabled).not.toEqual(enabled);
  });
});

describe("OpenRouter's nested reasoning contract", () => {
  const router = capability("effort", "openrouter-reasoning", { supportedEfforts: ["low", "medium", "high", "max"], defaultEffort: "medium" });
  it.each([
    [{ mode: "on", effort: "high" }, { reasoning: { effort: "high" } }],
    [{ mode: "on", effort: "max" }, { reasoning: { effort: "xhigh" } }],
    [{ mode: "on" }, { reasoning: { effort: "medium" } }],
    [{ mode: "off" }, { reasoning: { effort: "none" } }],
    [{ mode: "auto" }, {}],
  ] as const)("serializes router preference %j", (pref, expected) => {
    const result = wire(router, pref);
    expect(result).toEqual(expected); expect(result).not.toHaveProperty("reasoning_effort");
  });

  it("preserves input fields, folds unsupported off, and handles toggle variants", () => {
    expect(wire({ ...router, supportsDisable: false }, { mode: "off" })).toEqual({ reasoning: { effort: "medium" } });
    const input = { model: "calendar/router-model", messages: [] };
    expect(wire(router, { mode: "on", effort: "low" }, input)).toEqual({ ...input, reasoning: { effort: "low" } });
    expect(input).toEqual({ model: "calendar/router-model", messages: [] });
    const toggle = capability("toggle", "openrouter-reasoning");
    expect(wire(toggle, { mode: "on" })).toEqual({});
    expect(wire(toggle, { mode: "off" })).toEqual({ reasoning: { effort: "none" } });
    const combined = capability("toggle-effort", "openrouter-reasoning", { supportedEfforts: ["low", "high"], defaultEffort: "high" });
    expect(wire(combined, { mode: "on", effort: "low" })).toEqual({ reasoning: { effort: "low" } });
    expect(wire(combined, { mode: "off" })).toEqual({ reasoning: { effort: "none" } });
  });
});
