import { describe, expect, it } from "vitest";
import { classifyStructuredOutputEndpoint, resolveStructuredOutputProfile } from "./profiles";
import type { StructuredOutputProfileContext } from "./types";

const official = (provider: string, model: string, transport: StructuredOutputProfileContext["transport"] = "openai") =>
  resolveStructuredOutputProfile({ provider, model, transport, endpointKind: "official" });

describe("Model-specific structured response contracts", () => {
  it("recognizes schema-capable and object-capable providers on their declared transports", () => {
    const cases = [
      ["kimi", "kimi-for-coding", "openai", "provider_json_schema"], ["kimi", "kimi-k3", "openai", "provider_json_schema"],
      ["claude", "claude-sonnet-4-6", "anthropic", "provider_json_schema"],
      ["chatgpt", "gpt-5.6", "openai", "provider_json_schema"], ["chatgpt", "gpt-6-astra", "openai", "provider_json_schema"],
      ["glm", "glm-5.1", "openai", "provider_json_object"], ["glm", "glm-5.2", "openai", "provider_json_object"],
      ["glm", "glm-5.3", "openai", "provider_json_object"], ["mimo", "mimo-v2.5-pro", "openai", "provider_json_object"],
      ["qwen", "qwen3.7-plus", "openai", "provider_json_object"],
      ["deepseek", "deepseek-v4-pro", "openai", "provider_json_object"], ["deepseek", "deepseek-flash", "openai", "provider_json_object"],
      ["minimax", "MiniMax-M3", "openai", "prompt_json"],
    ] as const;
    expect(cases.map(([provider, model, transport]) => official(provider, model, transport).mode)).toEqual(cases.map(row => row[3]));
  });

  it("requires a hyphen boundary for optional Qwen deployment names", () => {
    expect(["qwen3.7-max-2026-06-08", "qwen3.7-plus-2026-05-26", "qwen3.6-plus-deployment", "qwen3.5-plus-deployment"].map(
      model => { const profile = official("qwen", model); return [profile.tier, profile.mode]; },
    )).toEqual(Array.from({ length: 4 }, () => ["B", "provider_json_object"]));
    expect(official("qwen", "qwen3.7-maximus").mode).toEqual("prompt_json");
  });

  it("falls back for unknown models, incompatible transports and nonofficial endpoints", () => {
    expect(official("chatgpt", "unlisted-model").mode).toEqual("prompt_json");
    expect(official("claude", "claude-sonnet-4-6", "openai").mode).toEqual("prompt_json");
    for (const provider of ["local", "custom", "unknown", "chatgpt"]) {
      const fallback = resolveStructuredOutputProfile({ provider, model: "gpt-5.6", transport: "openai", endpointKind: provider === "local" ? "local" : "custom" });
      expect(fallback).toMatchObject({
        id: "prompt-json-fallback", tier: "D", mode: "prompt_json", verification: "contract_required",
        allowCapabilityPromotion: false, requestHints: { reasoningSplit: false, sendJsonObject: false },
      });
    }
  });

  it("exposes independent A, B and MiniMax router time budgets with fixed repair limits", () => {
    const profiles = [official("chatgpt", "gpt-5.6"), official("glm", "glm-4.7"), official("minimax", "MiniMax-M3")];
    expect(profiles.map(p => [p.tier, p.repair.task_router])).toEqual([
      ["A", { maxAttempts: 2, totalBudgetMs: 25000, perAttemptTimeoutMs: 12500, minimumRemainingBudgetMs: 800 }],
      ["B", { maxAttempts: 2, totalBudgetMs: 20000, perAttemptTimeoutMs: 10000, minimumRemainingBudgetMs: 800 }],
      ["M", { maxAttempts: 2, totalBudgetMs: 12000, perAttemptTimeoutMs: 7000, minimumRemainingBudgetMs: 800 }],
    ]);
    expect(profiles[2]).toMatchObject({
      id: "minimax-m3-adapter", mode: "prompt_json", requestHints: { reasoningSplit: true, sendJsonObject: true },
    });
  });

  it("classifies official URLs, proxies and loopback addresses, including the Kimi coding endpoint", () => {
    const classify = (configuredBaseUrl: string, providerId = "chatgpt", officialBaseUrl = "https://api.openai.com/v1") =>
      classifyStructuredOutputEndpoint({ configuredBaseUrl, providerId, officialBaseUrl });
    expect([classify("https://api.openai.com/v1/"), classify("https://gateway.invalid/v1"), classify("http://127.0.0.1:11434/v1")]).toEqual(["official", "custom", "local"]);
    expect(classify("https://api.kimi.com/coding/v1", "kimi", "https://api.moonshot.cn/v1")).toEqual("official");
  });
});
