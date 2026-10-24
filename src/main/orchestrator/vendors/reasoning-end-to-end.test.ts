import { it, describe, expect } from "vitest";
import { AnthropicAdapter } from "./anthropic-adapter";
import { OpenAICompatAdapter } from "./openai-adapter";
import type { ChatRequest, ProviderCapability } from "./types";
import type { ReasoningPreference } from "../../../shared/reasoning";

const probe = (id: string, model: string, anthropic = false, reasoning?: ReasoningPreference, tools = false) => {
  const provider: ProviderCapability = {
    id, displayName: "Agenda gateway " + id, transport: anthropic ? "anthropic" : "openai", baseUrl: "https://agenda.invalid/v1",
    authStyle: anthropic ? "x-api-key" : "bearer", defaultModel: model, supportsTools: true, supportsThinking: true,
    thinkingField: anthropic ? "thinking" : "reasoning_content", cacheStrategy: anthropic ? "cache_control" : "auto", testStrategy: "text",
  };
  const adapter = anthropic ? new AnthropicAdapter(id, provider) : new OpenAICompatAdapter(id, provider);
  const input: ChatRequest = { model, messages: [{ role: "user", content: "Find the next free calendar slot" }], ...(anthropic ? { maxTokens: 160 } : {}), ...(tools ? { tools: [{ name: "agenda_find", description: "Find an appointment", parameters: { type: "object" } }] } : {}) };
  return JSON.parse(adapter.buildRequest(input, { model, provider: provider.displayName, apiKey: "agenda-wire-key", baseUrl: provider.baseUrl, ...(reasoning ? { reasoning } : {}) }).body);
};

describe("Selected configuration reaching the request serializer", () => {
  it("uses configured effort for GPT and preserves absence for automatic or nonreasoning requests", () => {
    expect(probe("chatgpt", "gpt-5.6", false, { mode: "on", effort: "high" }).reasoning_effort).toEqual("high");
    expect(probe("chatgpt", "gpt-5.6", false, { mode: "auto" })).not.toHaveProperty("reasoning_effort");
    expect(probe("chatgpt", "gpt-4o", false, { mode: "auto" })).not.toHaveProperty("reasoning_effort");
  });

  it("transmits Claude adaptive effort and treats missing MiMo reasoning as automatic", () => {
    const claude = probe("claude", "claude-sonnet-5", true, { mode: "on", effort: "xhigh" });
    expect(claude.output_config.effort).toEqual("xhigh"); expect(claude.thinking.type).toEqual("adaptive");
    const mimo = probe("mimo", "mimo-v2.5-pro");
    expect(mimo).not.toHaveProperty("thinking"); expect(mimo).not.toHaveProperty("enable_thinking");
  });

  it("changes MiniMax and DeepSeek wire bodies when the user changes reasoning preference", () => {
    const auto = probe("minimax", "MiniMax-M3", true, { mode: "auto" });
    const on = probe("minimax", "MiniMax-M3", true, { mode: "on" });
    const off = probe("minimax", "MiniMax-M3", true, { mode: "off" });
    expect(auto).not.toHaveProperty("thinking");
    expect(on.thinking.type).toEqual("adaptive"); expect(off.thinking.type).toEqual("disabled");
    const enabled = probe("deepseek", "deepseek-v4-pro", false, { mode: "on", effort: "max" });
    expect(enabled.thinking.type).toEqual("enabled"); expect(enabled.reasoning_effort).toEqual("max");
    expect(probe("deepseek", "deepseek-v4-pro", false, { mode: "off" }).thinking.type).toEqual("disabled");
  });

  it("respects fixed-on Kimi models, tool retention and Qwen's distinct toggle field", () => {
    expect(probe("kimi", "kimi-k2.7-code", false, { mode: "on" })).not.toHaveProperty("thinking");
    expect(probe("kimi", "kimi-k2.6", false, { mode: "on" }, true).thinking).toEqual({ type: "enabled", keep: "all" });
    const qwen = probe("qwen", "qwen3-max", false, { mode: "on" });
    expect(qwen.enable_thinking).toEqual(true); expect(qwen).not.toHaveProperty("thinking");
  });
});
