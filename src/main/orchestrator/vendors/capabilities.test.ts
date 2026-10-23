import { describe, it, expect } from "vitest";
import { PROVIDER_CAPABILITIES as catalogue, getCapability } from "./capabilities";
import { getAdapterForConfig } from "./index";

describe("Provider catalogue exposed to the desktop runtime", () => {
  it("assigns nonempty unique identities and includes all supported display names", () => {
    catalogue.forEach(({ id, displayName }) => { expect(id).toBeTruthy(); expect(displayName).toBeTruthy(); });
    expect(new Set(catalogue.map(({ id }) => id)).size).toEqual(catalogue.length);
    expect(new Set(catalogue.map(({ displayName }) => displayName)).size).toEqual(catalogue.length);
    const available = catalogue.map(({ displayName }) => displayName);
    for (const displayName of ["MiMo（小米）", "Claude（Anthropic）", "ChatGPT（OpenAI）", "Qwen（通义千问）", "Kimi（月之暗面）", "GLM（智谱）", "DeepSeek（深度求索）", "MiniMax（稀宇科技）"]) {
      expect(available).toContain(displayName);
    }
    expect(getCapability("MiMo（小米）")).toBeDefined();
    expect(getCapability("MiMo（小米）")).toMatchObject({ id: "mimo", displayName: "MiMo（小米）" });
  });

  it("advertises MiniMax's Anthropic default and per-transport authentication", () => {
    expect(getCapability("MiniMax（稀宇科技）")).toMatchObject({
      transport: "anthropic", authStyle: "bearer", anthropicAuthStyle: "x-api-key", baseUrl: "https://api.minimaxi.com/anthropic",
    });
    const config = { provider: "MiniMax（稀宇科技）", model: "MiniMax-M3", baseUrl: "https://api.minimaxi.com/anthropic", apiKey: "agenda-key", explicitTransport: "anthropic" as const };
    const adapter = getAdapterForConfig(config);
    const http = adapter.buildRequest({ model: config.model, messages: [{ role: "user", content: "Verify calendar access" }] }, config);
    expect(adapter.transport).toEqual("anthropic");
    expect(http.url).toEqual("https://api.minimaxi.com/anthropic/v1/messages");
    expect(http.headers["x-api-key"]).toEqual("agenda-key");
    expect(http.headers.Authorization).toBeUndefined();
  });

  it.each([
    ["DeepSeek（深度求索）", "https://api.deepseek.com/anthropic", "deepseek-v4-pro"],
    ["MiniMax（稀宇科技）", "https://api.minimaxi.com/anthropic", "MiniMax-M3"],
  ])("sends %s's Anthropic streams to messages with API-key headers", (provider, baseUrl, model) => {
    const config = { provider, baseUrl, model, apiKey: "agenda-stream-key", explicitTransport: "anthropic" as const };
    const http = getAdapterForConfig(config).buildStreamRequest({ model, stream: true, messages: [{ role: "user", content: "Stream calendar access check" }] }, config);
    expect(http.url).toEqual(baseUrl + "/v1/messages");
    expect(http.headers["x-api-key"]).toEqual("agenda-stream-key");
    expect(http.headers.Authorization).toBeUndefined();
    expect(JSON.parse(http.body)).toMatchObject({ stream: true });
  });

  it("keeps OpenRouter on bearer-authenticated Chat Completions without a default model", () => {
    expect(getCapability("OpenRouter")).toMatchObject({ displayName: "OpenRouter", id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", transport: "openai", authStyle: "bearer", defaultModel: "", supportedTransports: ["openai"] });
    const config = { provider: "OpenRouter", model: "openai/gpt-5.6", apiKey: "router-agenda-key", baseUrl: "https://openrouter.ai/api/v1", explicitTransport: "openai" as const };
    const adapter = getAdapterForConfig(config);
    const http = adapter.buildStreamRequest({ model: config.model, messages: [{ role: "user", content: "Check appointments" }], stream: true }, config);
    expect(http.url).toEqual("https://openrouter.ai/api/v1/chat/completions");
    expect(adapter.transport).toEqual("openai");
    expect(http.headers.Authorization).toEqual("Bearer router-agenda-key");
    expect(http.headers["x-api-key"]).toBeUndefined();
  });
});
