import { afterEach, beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ stream: vi.fn(), build: vi.fn(), parse: vi.fn(), hints: vi.fn(), transport: vi.fn(), recordUsage: vi.fn(), recordRequest: vi.fn(), recordModelCall: vi.fn() }));
vi.mock("../vendors", () => ({ getAdapterForConfig: () => ({ buildRequest: deps.build, parseResponse: deps.parse, applyCacheHints: deps.hints }), resolveTransport: deps.transport, streamChatWithSdk: deps.stream }));
vi.mock("../../token-usage-store", () => deps);
import { callLLM, summarizeHistory } from "./harness-llm";
const vendor = { provider: "test", baseUrl: "https://example.test", model: "m", apiKey: "test" }, config = { modelRequestTimeoutMs: 0 } as never;
const layers = { stablePrefix: "system" }, response = { text: "answer", assistantMessage: { role: "assistant", content: "answer" } };
const fetchMock = vi.fn();
beforeEach(() => { vi.resetAllMocks(); deps.transport.mockReturnValue("openai"); deps.hints.mockImplementation(r => r); deps.stream.mockResolvedValue(response); deps.build.mockReturnValue({ url: "https://example.test", headers: {}, body: "{}" }); deps.parse.mockReturnValue(response); fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) }); vi.stubGlobal("fetch", fetchMock); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it.each(["openai", "responses", "anthropic"])("streams with %s output limits and records successful requests", async transport => {
  deps.transport.mockReturnValue(transport); expect(await callLLM(vendor, layers, [], [], config)).toBe(response); const input = deps.stream.mock.calls[0][0]; expect(input.request).toMatchObject({ model: "m", stream: true }); if (transport === "anthropic") expect(input.request.maxTokens).toBe(32768); else expect(input.request).not.toHaveProperty("maxTokens"); expect(deps.recordRequest).toHaveBeenCalledWith("m"); expect(deps.recordUsage).not.toHaveBeenCalled();
});
it("forwards deltas and accounts for provider usage", async () => {
  const reasoning = vi.fn(), text = vi.fn(); deps.stream.mockImplementation(async ({ onDelta }) => { onDelta({ type: "usage" }); onDelta({ type: "reasoning_delta", delta: "think" }); onDelta({ type: "text_delta", delta: "" }); onDelta({ type: "text_delta", delta: "answer" }); return { ...response, usage: { input: 10, output: 3, cachedInput: 2, cacheCreation: 1 } }; });
  await callLLM(vendor, layers, [], [], config, undefined, reasoning, text); expect(reasoning).toHaveBeenCalledExactlyOnceWith("think"); expect(text).toHaveBeenCalledExactlyOnceWith("answer"); expect(deps.recordUsage).toHaveBeenCalledWith(10, 3, 1, 2, "m", 1);
});
it("falls back only after an explicit unsupported-stream error and preserves cache hints", async () => {
  deps.hints.mockImplementation(r => ({ ...r, cacheKey: "route" })); deps.stream.mockRejectedValue(Error("stream not supported"));
  expect(await callLLM(vendor, layers, [], [], config)).toBe(response); expect(deps.build.mock.calls[0][0]).toMatchObject({ stream: false, cacheKey: "route" }); expect(deps.recordRequest).toHaveBeenCalledOnce();
});
it.each(["text_delta", "reasoning_delta"])("never retries after a nonempty %s", async type => {
  const error = Error("stream not supported"); deps.stream.mockImplementation(async ({ onDelta }) => { onDelta({ type, delta: "partial" }); throw error; }); await expect(callLLM(vendor, layers, [], [], config)).rejects.toBe(error); expect(fetchMock).not.toHaveBeenCalled(); expect(deps.recordRequest).not.toHaveBeenCalled();
});
it("does not retry unrelated errors", async () => { const error = Error("offline"); deps.stream.mockRejectedValue(error); await expect(callLLM(vendor, layers, [], [], config)).rejects.toBe(error); expect(fetchMock).not.toHaveBeenCalled(); });
it.each(["denied", ""])("reports provider fallback HTTP failures %j", async message => {
  deps.stream.mockRejectedValue(Error("stream not supported")); fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => message ? JSON.stringify({ error: { message } }) : "" }); await expect(callLLM(vendor, layers, [], [], config)).rejects.toThrow(new RegExp(`^${message || "模型请求失败：HTTP 403"}$`));
});
it("recaptures a fresh non-stream request through the memory runtime", async () => {
  const call = vi.fn().mockRejectedValueOnce(Error("MEMORY_CONTEXT_STREAM_UNSUPPORTED")).mockResolvedValueOnce(response); expect(await callLLM(vendor, layers, [], [], config, undefined, undefined, undefined, { call } as never)).toBe(response); expect(call.mock.calls.map(c => c[0].request.stream)).toEqual([true, false]); expect(deps.stream).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
});
it("summarizes history in system/history/compaction order", async () => {
  deps.transport.mockReturnValue("anthropic"); const history = [{ role: "user" as const, content: "old" }], signal = new AbortController().signal; expect(await summarizeHistory(vendor, "instructions", history, [], signal)).toBe("answer");
  const request = deps.build.mock.calls[0][0]; expect(request).toMatchObject({ stream: false, maxTokens: 32768, model: "m" }); expect(request.messages.slice(0, 2)).toEqual([{ role: "system", content: "instructions" }, ...history]); expect(request.messages.at(-1).role).toBe("user"); expect(history).toHaveLength(1); expect(fetchMock.mock.calls[0][1].signal).toBe(signal);
});
it("reports summary HTTP failures", async () => { fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "private" }); await expect(summarizeHistory(vendor, "", [], [])).rejects.toThrow(/^摘要请求失败：HTTP 500$/); });
