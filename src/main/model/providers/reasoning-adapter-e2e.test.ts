import { describe, it, expect } from "vitest";
import { OpenAICompatAdapter } from "./openai-adapter";
import { AnthropicAdapter } from "./anthropic-adapter";
import type { ProviderCapability, ChatRequest, Transport } from "./types";
import type { ReasoningPreference } from "../../../shared/reasoning";

function request(provider: string, model: string, reasoning: ReasoningPreference, transport: Transport = "openai", additions: Partial<ChatRequest> = {}) {
  const cap: ProviderCapability = { id: provider, displayName: "Calendar " + provider, transport, baseUrl: "https://calendar.invalid/v1", authStyle: transport === "anthropic" ? "x-api-key" : "bearer", defaultModel: model, supportsTools: true, supportsThinking: true, thinkingField: transport === "anthropic" ? "thinking" : "reasoning_content", cacheStrategy: transport === "anthropic" ? "cache_control" : "auto", testStrategy: "text" };
  const adapter = transport === "anthropic" ? new AnthropicAdapter(provider, cap) : new OpenAICompatAdapter(provider, cap);
  return JSON.parse(adapter.buildRequest({ model, messages: [{ role: "user", content: "Review the calendar" }], ...(transport === "anthropic" ? { maxTokens: 128 } : {}), ...additions }, { model, reasoning, provider: cap.displayName, baseUrl: cap.baseUrl, apiKey: "agenda-reasoning-key" }).body);
}
const tool = { name: "calendar_read", description: "Read scheduled appointments", parameters: { type: "object" } };

describe("Reasoning preferences in real adapter request bodies", () => {
  it.each([
    ["chatgpt", "gpt-5.6", { mode: "on", effort: "high" }, "high"],
    ["chatgpt", "gpt-5", { mode: "on", effort: "medium" }, "medium"],
    ["chatgpt", "gpt-5", { mode: "off" }, "none"],
    ["chatgpt", "gpt-6-astra", { mode: "on", effort: "xhigh" }, "xhigh"],
  ] as const)("sets the effort for %s/%s with %j", (provider, model, pref, expected) => {
    expect(request(provider, model, pref).reasoning_effort).toEqual(expected);
  });

  it("folds GPT-6 Astra off into medium and omits effort for a nonreasoning model", () => {
    const astra = request("chatgpt", "gpt-6-astra", { mode: "off" });
    expect(astra.reasoning_effort).toEqual("medium"); expect(astra.reasoning_effort).not.toBe("none");
    expect(request("chatgpt", "gpt-4o", { mode: "on", effort: "high" })).not.toHaveProperty("reasoning_effort");
  });

  it("uses adaptive Claude thinking and merges existing output configuration", () => {
    expect(request("claude", "claude-sonnet-5", { mode: "on", effort: "xhigh" }, "anthropic")).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "xhigh" } });
    const merged = request("claude", "claude-sonnet-5", { mode: "on", effort: "high" }, "anthropic", { extraBody: { output_config: { format: "json" } } });
    expect(merged.output_config).toEqual({ format: "json", effort: "high" });
  });

  it("selects the supported DeepSeek and GLM fields", () => {
    expect(request("deepseek", "deepseek-v4-pro", { mode: "on", effort: "max" })).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "max" });
    expect(request("glm", "glm-5.2", { mode: "on", effort: "high" })).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "high" });
    const earlier = request("glm", "glm-4.7", { mode: "on" });
    expect(earlier.thinking.type).toEqual("enabled"); expect(earlier).not.toHaveProperty("reasoning_effort");
  });

  it("uses Qwen's enable flag only for toggleable models", () => {
    const toggle = request("qwen", "qwen3-max", { mode: "on" });
    expect(toggle.enable_thinking).toEqual(true); expect(toggle).not.toHaveProperty("thinking");
    const mandatory = request("qwen", "qwen-max-thinking", { mode: "off" });
    expect(mandatory).not.toHaveProperty("thinking"); expect(mandatory).not.toHaveProperty("enable_thinking");
  });

  it("retains Kimi tool thinking only for the supported model generation", () => {
    expect(request("kimi", "kimi-k2.6", { mode: "on" }, "openai", { tools: [tool] }).thinking).toEqual({ type: "enabled", keep: "all" });
    expect(request("kimi", "kimi-k2.5", { mode: "on" }, "openai", { tools: [tool] }).thinking).toEqual({ type: "enabled" });
    for (const [model, mode] of [["kimi-k2.7-code", "on"], ["kimi-k2.7-code", "off"], ["kimi-k2.7-code-highspeed", "off"]] as const) expect(request("kimi", model, { mode })).not.toHaveProperty("thinking");
  });

  it("maps MiniMax's adaptive toggle and avoids unsupported fields on fixed-thinking models", () => {
    expect(request("minimax", "MiniMax-M3", { mode: "off" }, "anthropic").thinking.type).toEqual("disabled");
    expect(request("minimax", "MiniMax-M3", { mode: "on" }, "anthropic").thinking.type).toEqual("adaptive");
    expect(request("minimax", "MiniMax-M2.7", { mode: "off" }, "anthropic")).not.toHaveProperty("thinking");
  });

  it.each(["openai", "anthropic"] as const)("keeps MiMo thinking enabled on %s", (transport) => {
    expect(request("mimo", "mimo-v2.5-pro", { mode: "on" }, transport).thinking.type).toEqual("enabled");
  });

  it("omits all reasoning control for an unknown model", () => {
    const result = request("unknown", "calendar-unlisted-model", { mode: "on" });
    expect(result).not.toHaveProperty("reasoning_effort"); expect(result).not.toHaveProperty("thinking");
  });
});
