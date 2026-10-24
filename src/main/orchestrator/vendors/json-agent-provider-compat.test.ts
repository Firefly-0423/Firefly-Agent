import { it, expect, describe } from "vitest";
import { getCapability, getAdapterForConfig } from "./index";

describe("Native function calling on supported gateways", () => {
  it.each([
    { provider: "DeepSeek（深度求索）", model: "deepseek-v4-pro", choice: undefined },
    { provider: "Kimi（月之暗面）", model: "kimi-k2.7-code", choice: "auto" },
    { provider: "MiniMax（稀宇科技）", model: "MiniMax-M3", choice: "auto" },
  ])("retains tools and the thinking-compatible selection policy for $provider", ({ provider, model, choice }) => {
    const configuration = { provider, model, baseUrl: getCapability(provider)!.baseUrl, apiKey: "agenda-access", explicitTransport: "openai" as const, reasoning: { mode: "on" as const, effort: "medium" as const } };
    const http = getAdapterForConfig(configuration).buildRequest({
      model, messages: [{ role: "user", content: "Find my next appointment" }],
      tools: [{ name: "agenda_find", description: "Look up scheduled events", parameters: { type: "object" } }],
      toolChoiceIntent: { mode: "must_call", toolName: "agenda_find" },
    }, configuration);
    const payload = JSON.parse(http.body);
    expect(payload.tools).toBeDefined();
    expect(payload.tool_choice).toBe(choice);
  });
});
