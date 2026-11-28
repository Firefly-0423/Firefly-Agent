import { describe, expect, it } from "vitest";
import { applyReasoningPreference } from "./reasoning";
import { resolveReasoningCapability, type ReasoningLevelsConfig, type ReasoningPreference } from "../../../shared/reasoning";

// The Claude 5 family's thinking rules (Anthropic Claude API docs, checked 2026-11-08):
// - Sonnet 5.5: thinking {type: "disabled"} is a 400; "off" is {type: "between_tools"}, only at effort high or below.
// - Opus 5.5, Fable 5 and Fable 5.1: thinking cannot be turned off ("disabled" is a 400); lower the effort instead.
// - Opus 5 and Haiku 5.5: "disabled" is accepted at effort high or below (their defaults, so an off request sends no effort).
// - Sonnet 5: "disabled" is accepted.
function request(model: string, preference: ReasoningPreference, levels?: ReasoningLevelsConfig): Record<string, unknown> {
  const capability = resolveReasoningCapability("claude", model, levels, "anthropic-adaptive");
  return applyReasoningPreference({ model }, preference, capability, { model, providerId: "claude", hasTools: true });
}

describe("Claude 5 family thinking requests", () => {
  it("turns Sonnet 5.5 thinking off with between_tools and no effort, never with disabled", () => {
    const wire = request("claude-sonnet-5-5", { mode: "off" });
    expect(wire.thinking).toEqual({ type: "between_tools" });
    expect(wire.output_config).toBeUndefined();
  });

  it("keeps Sonnet 5 on disabled, which it accepts", () => {
    expect(request("claude-sonnet-5", { mode: "off" }).thinking).toEqual({ type: "disabled" });
  });

  it.each(["claude-opus-5-5", "claude-fable-5-1", "claude-fable-5"])("never sends disabled to %s, which rejects it", model => {
    expect(resolveReasoningCapability("claude", model).supportsDisable).toBe(false);
    const wire = request(model, { mode: "off" });
    expect(wire.thinking).toEqual({ type: "adaptive" });
  });

  it("gives Opus 5.5 its own levels with medium as the default", () => {
    const capability = resolveReasoningCapability("claude", "claude-opus-5-5");
    expect(capability.supportedEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(capability.defaultEffort).toBe("medium");
    expect(request("claude-opus-5-5", { mode: "on", effort: "low" })).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "low" } });
  });

  it.each(["claude-opus-5", "claude-haiku-5-5"])("lets %s turn thinking off without raising the effort above its default", model => {
    const wire = request(model, { mode: "off" });
    expect(wire.thinking).toEqual({ type: "disabled" });
    expect(wire.output_config).toBeUndefined();
    expect(request(model, { mode: "on", effort: "max" })).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "max" } });
  });

  it("sends a declared level as output_config.effort, never OpenAI's reasoning_effort", () => {
    const wire = request("claude-sonnet-5-5", { mode: "on", effort: "low" }, { efforts: ["low", "high"] });
    expect(wire).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "low" } });
    expect(wire).not.toHaveProperty("reasoning_effort");
  });

  it("does not let declared levels re-enable an off switch the API rejects", () => {
    const declared: ReasoningLevelsConfig = { efforts: ["low", "high"], allowOff: true };
    expect(request("claude-opus-5-5", { mode: "off" }, declared).thinking).toEqual({ type: "adaptive" });
    expect(request("claude-sonnet-5-5", { mode: "off" }, declared).thinking).toEqual({ type: "between_tools" });
    expect(request("claude-sonnet-5", { mode: "off" }, declared).thinking).toEqual({ type: "disabled" });
  });
});
