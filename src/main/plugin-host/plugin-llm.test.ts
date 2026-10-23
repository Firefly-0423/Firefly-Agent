import { expect, it, vi } from "vitest";
import { pluginGenerateText, type EnqueuePluginLlmTask } from "./plugin-llm";
import type { ModelSettings } from "../settings/model-settings";
import type { LlmClient } from "../services/llm/llm-client";

const profile = (apiKey = "test-credential"): ModelSettings => ({
  apiKey, model: "orchid-small", provider: "OpenAI", baseUrl: "https://llm.invalid/v1", mode: "auto",
  explicitTransport: "openai", perProvider: {}, stickerEnabled: false, stickerSize: "standard",
  stickerSimilarityThreshold: 0.61, chatRequestTimeoutSec: 60, rerankerMode: "none",
  embeddingModel: "bgem3", multimodal: false, contextWindowTokens: 64000,
});
it("submits a queued nonstream request with the caller's limits and returns text", async () => {
  const nonstream = vi.fn().mockResolvedValue({ text: "  A gentle hello.  ", finishReason: "stop" });
  const queue = vi.fn<EnqueuePluginLlmTask>(async (_label, operation) => operation());
  const selected = profile();
  const messages = [{ role: "user" as const, content: "Greet a visitor" }];
  const reply = await pluginGenerateText(messages, selected, { chatNonStream: nonstream } as unknown as LlmClient,
    queue, { purpose: "garden:welcome", timeoutMs: 7000, maxTokens: 1536 });
  expect(reply).toBe("A gentle hello.");
  expect(queue).toHaveBeenCalledExactlyOnceWith("plugin:garden:welcome", expect.any(Function), { retryRateLimit: true });
  expect(nonstream).toHaveBeenCalledExactlyOnceWith(selected, messages, undefined, 7000,
    "plugin:garden:welcome", undefined, { maxTokens: 1536 }, undefined);
});
it.each([
  ["missing credentials", "", {}, /API Key/],
  ["excess output allowance", "test-credential", { maxTokens: 9000 }, /maxTokens/],
] as const)("rejects %s before enqueuing work", async (_description, key, options, message) => {
  const queue = vi.fn<EnqueuePluginLlmTask>(async (_label, operation) => operation());
  const nonstream = vi.fn();
  await expect(pluginGenerateText([{ role: "user", content: "Summarize the garden" }], profile(key),
    { chatNonStream: nonstream } as unknown as LlmClient, queue, options)).rejects.toThrow(message);
  expect(queue).not.toHaveBeenCalled();
  expect(nonstream).not.toHaveBeenCalled();
});
