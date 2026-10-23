import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ recordUsage: vi.fn(), recordRequest: vi.fn(), recordModelCall: vi.fn() }));
vi.mock("../../token-usage-store", () => store);
vi.mock("../vendors", () => ({
  getAdapterForConfig: () => ({}),
  streamChatWithSdk: vi.fn(),
  resolveTransport: () => "openai",
}));

import { callLLM } from "./harness-llm";

const vendor = { provider: "p", baseUrl: "http://x", model: "m", apiKey: "k" } as never;
const layers = { stablePrefix: "system" };
const config = { modelRequestTimeoutMs: 0 } as never;
const response = { text: "hi", usage: { input: 100, output: 300 }, assistantMessage: { role: "assistant", content: "hi" } };

describe("callLLM timing for the conversation stats", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    store.recordModelCall.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("reports the request time, the first-token delay and the streaming time with the output tokens", async () => {
    const memoryRun = {
      call: async ({ onDelta }: { onDelta: (delta: unknown) => void }) => {
        vi.advanceTimersByTime(1500);
        onDelta({ type: "usage" });
        onDelta({ type: "text_delta", delta: "" });
        vi.advanceTimersByTime(500);
        onDelta({ type: "reasoning_delta", delta: "thinking" });
        vi.advanceTimersByTime(3000);
        return response;
      },
    };
    await callLLM(vendor, layers, [], [], config, undefined, undefined, undefined, memoryRun as never);
    expect(store.recordModelCall).toHaveBeenCalledExactlyOnceWith({ durationMs: 5000, ttftMs: 2000, generationMs: 3000, outputTokens: 300 });
  });

  it("gives no first-token delay or speed when nothing streamed", async () => {
    const memoryRun = { call: async () => { vi.advanceTimersByTime(1200); return response; } };
    await callLLM(vendor, layers, [], [], config, undefined, undefined, undefined, memoryRun as never);
    const call = store.recordModelCall.mock.calls[0]![0];
    expect(call).toEqual({ durationMs: 1200, outputTokens: 300 });
    expect("ttftMs" in call).toBe(false);
  });

  it("records nothing for a request that fails", async () => {
    const memoryRun = { call: async () => { throw new Error("boom"); } };
    await expect(callLLM(vendor, layers, [], [], config, undefined, undefined, undefined, memoryRun as never)).rejects.toThrow("boom");
    expect(store.recordModelCall).not.toHaveBeenCalled();
  });
});
