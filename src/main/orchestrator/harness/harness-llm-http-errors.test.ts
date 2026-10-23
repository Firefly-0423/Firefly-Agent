import { afterEach, describe, expect, it, vi } from "vitest";

const vendors = vi.hoisted(() => ({ streamChatWithSdk: vi.fn() }));
vi.mock("../../token-usage-store", () => ({ recordUsage: vi.fn(), recordRequest: vi.fn(), recordModelCall: vi.fn() }));
vi.mock("../vendors", () => ({
  ...vendors,
  resolveTransport: () => "openai",
  getAdapterForConfig: () => ({ buildRequest: () => ({ url: "https://model.example.test/chat", headers: {}, body: "{}" }) }),
}));
import { callLLM } from "./harness-llm";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("non-streaming fallback HTTP errors", () => {
  it.each([
    ["<html>Bad gateway</html>", "模型请求失败：HTTP 502"],
    ["null", "模型请求失败：HTTP 502"],
    ['{"error":{"message":{"detail":"bad gateway"}}}', "模型请求失败：HTTP 502"],
    ['{"error":{"message":"Provider unavailable"}}', "Provider unavailable"],
  ])("preserves an actionable HTTP error for response %s", async (body, expected) => {
    vendors.streamChatWithSdk.mockRejectedValue(new Error("streaming not supported"));
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(callLLM(
      { provider: "fixture", model: "fixture", baseUrl: "https://model.example.test", apiKey: "public-fixture" } as never,
      { stablePrefix: "system" }, [], [], { modelRequestTimeoutMs: 0 } as never,
    )).rejects.toThrow(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
