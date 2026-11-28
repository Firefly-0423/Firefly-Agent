import { describe, it, expect } from "vitest";
import { resolveTransport } from "./transport-detector";

describe("Transport selection from explicit configuration", () => {
  it.each([
    ["MiniMax（稀宇科技）", "https://gateway.invalid/v1", "anthropic"],
    ["MiniMax（稀宇科技）", "https://gateway.invalid/anthropic", "openai"],
    ["DeepSeek（深度求索）", "https://api.deepseek.com", "responses"],
    ["ChatGPT（OpenAI）", "https://api.openai.com/v1", "responses"],
  ] as const)("honors %s's explicitly selected %s endpoint protocol %s", (provider, baseUrl, protocol) => {
    expect(resolveTransport({ provider, baseUrl, explicitTransport: protocol })).toEqual(protocol);
  });

  it.each([
    ["Claude（Anthropic）", "https://gateway.invalid/v1", "anthropic"],
    ["MiniMax（稀宇科技）", "https://api.minimaxi.com/anthropic", "anthropic"],
    ["DeepSeek（深度求索）", "https://api.deepseek.com", "openai"],
  ] as const)("uses the registered default for %s without URL inference", (provider, baseUrl, expected) => {
    expect(resolveTransport({ baseUrl, provider })).toEqual(expected);
  });
});
