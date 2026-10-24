import { describe, it, expect } from "vitest";
import { resolveAutomaticToolChoicePolicy as automatic, resolveToolChoicePolicy as required, type ToolChoicePolicyInput } from "./tool-choice-policy";

const selection = (patch: Partial<ToolChoicePolicyInput>) => required({
  providerId: "qwen", model: "qwen3-7b", transport: "openai", reasoning: { mode: "off" }, requestedToolName: "agenda_find", ...patch,
});

describe("Tool intent translated to provider policy", () => {
  it.each([
    [{ providerId: "minimax", model: "MiniMax-M3", reasoning: { mode: "on" } }, { kind: "auto" }],
    [{ providerId: "deepseek", model: "deepseek-v4-pro", reasoning: { mode: "on", effort: "high" } }, { kind: "omit" }],
    [{ providerId: "deepseek", model: "deepseek-v4-pro" }, { kind: "named", name: "agenda_find" }],
    [{ providerId: "kimi", model: "kimi-k2.7-code" }, { kind: "auto" }],
    [{ providerId: "claude", model: "claude-sonnet-4-6", transport: "anthropic", reasoning: { mode: "on", effort: "high" } }, { kind: "auto" }],
  ] as const)("uses the compatible policy for %j", (input, expected) => {
    expect(selection(input)).toStrictEqual(expected);
  });

  it("allows named selection only when an unknown model declares thinking can be disabled", () => {
    const proxy = { providerId: "custom", model: "agenda-proxy" };
    expect(selection(proxy)).toEqual({ kind: "auto" });
    expect(selection({ ...proxy, reasoningLevels: { efforts: ["low", "high"], allowOff: true } })).toEqual({ kind: "named", name: "agenda_find" });
    expect(automatic({ providerId: "deepseek", model: "agenda-proxy", transport: "openai", reasoning: { mode: "off" }, reasoningLevels: { efforts: [], allowOff: true } })).toBe("auto");
  });

  it.each([
    ["required-only", ["required"], { kind: "required" }],
    ["qwen", ["required", "auto"], { kind: "required" }],
    ["qwen", ["omit"], { kind: "omit" }],
  ] as const)("chooses the strongest offered policy for %s from %j", (providerId, supportedModes, expected) => {
    expect(selection({ providerId, supportedModes })).toStrictEqual(expected);
  });

  it("keeps optional calls automatic except for thinking modes that reject tool_choice", () => {
    expect(automatic({ providerId: "openai", model: "gpt", transport: "openai", reasoning: { mode: "off" } })).toEqual("auto");
    expect(automatic({ providerId: "deepseek", model: "deepseek-v4-pro", transport: "openai", reasoning: { mode: "on" } })).toEqual("omit");
  });
});
