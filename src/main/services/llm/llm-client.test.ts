import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  events: [] as Array<{ chunk: unknown }>,
  adapter: null as unknown as {
    buildStreamRequest: ReturnType<typeof vi.fn>;
    buildRequest: ReturnType<typeof vi.fn>;
    parseStreamEvent: ReturnType<typeof vi.fn>;
    parseResponse: ReturnType<typeof vi.fn>;
  },
}));

vi.mock("../../orchestrator/vendors", () => ({
  getAdapterForConfig: vi.fn(() => mocks.adapter),
  createSseReader: vi.fn(async function* () {
    for (const event of mocks.events) yield event;
  }),
}));
vi.mock("../../token-usage-store", () => ({ recordRequest: vi.fn(), recordUsage: vi.fn() }));
vi.mock("../../chat/chat-api-utils", () => ({ appendApiLog: vi.fn() }));

import { createLlmClient } from "./llm-client";
import { recordRequest, recordUsage } from "../../token-usage-store";
import { appendApiLog } from "../../chat/chat-api-utils";
import type { ModelSettings } from "../../settings/model-settings";

const settings = {
  provider: "synthetic",
  baseUrl: "https://example.test",
  model: "test-model",
  apiKey: "key",
  explicitTransport: "openai",
  reasoning: "auto",
} as unknown as ModelSettings;
const messages = [
  { role: "system" as const, content: "you are helpful" },
  { role: "user" as const, content: "hello" },
];

function response(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    body: {},
    json: async () => ({}),
    ...overrides,
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events = [];
  mocks.adapter = {
    buildStreamRequest: vi.fn(() => ({ url: "https://example.test/stream", headers: { "x-key": "key" }, body: "stream-body" })),
    buildRequest: vi.fn(() => ({ url: "https://example.test/chat", headers: { "x-key": "key" }, body: "chat-body" })),
    parseStreamEvent: vi.fn((event: { chunk: unknown }) => event.chunk),
    parseResponse: vi.fn((json: unknown) => json),
  };
  vi.stubGlobal("fetch", vi.fn(async () => response()));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createLlmClient.stream", () => {
  it("streams text, flushes the visible filter and returns think-stripped text", async () => {
    mocks.events = [
      { chunk: { deltaText: "<think>internal</think>Hello " } },
      { chunk: { deltaText: "world" } },
      { chunk: { done: true } },
    ];
    const chunks: string[] = [];
    const client = createLlmClient();
    const result = await client.stream(settings, messages, 0.2, 5_000, "unit", (text) => chunks.push(text));

    expect(result).toBe("Hello world");
    expect(chunks.join("")).toBe("Hello world");
    expect(recordRequest).toHaveBeenCalledWith("test-model");
    expect(appendApiLog).toHaveBeenCalledWith("unit", messages, "<think>internal</think>Hello world", "Hello world");
    expect(mocks.adapter.buildStreamRequest).toHaveBeenCalledWith(
      { model: "test-model", messages, temperature: 0.2, stream: true },
      expect.objectContaining({ model: "test-model", apiKey: "key" }),
    );
  });

  it("merges usage across events with maxima and records one aggregated usage", async () => {
    mocks.events = [
      { chunk: { deltaText: "A", usage: { input: 10, output: 5, cachedInput: 2, cacheCreation: 1 } } },
      { chunk: { deltaText: "B", usage: { input: 12, output: 4, cachedInput: 1, cacheCreation: 3 } } },
      { chunk: { done: true } },
    ];
    const client = createLlmClient();
    expect(await client.stream(settings, messages, undefined, 5_000, "unit", () => {})).toBe("AB");
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(12, 5, 1, 2, "test-model", 3);
    expect(mocks.adapter.buildStreamRequest).toHaveBeenCalledWith(
      { model: "test-model", messages, stream: true },
      expect.any(Object),
    );
  });

  it("skips null chunks and does not record usage when none was reported", async () => {
    mocks.events = [{ chunk: null }, { chunk: { deltaText: "ok" } }, { chunk: { done: true } }];
    const client = createLlmClient();
    expect(await client.stream(settings, messages, undefined, 5_000, "unit", () => {})).toBe("ok");
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("surfaces the provider error message from a failed HTTP response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ ok: false, status: 401, json: async () => ({ error: { message: "bad key" } }) }));
    await expect(createLlmClient().stream(settings, messages, undefined, 5_000, "unit", () => {}))
      .rejects.toThrow("bad key");
    expect(recordRequest).not.toHaveBeenCalled();
  });

  it("falls back to the HTTP status when the error body is unreadable", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ ok: false, status: 503, json: async () => { throw new Error("not json"); } }));
    await expect(createLlmClient().stream(settings, messages, undefined, 5_000, "unit", () => {}))
      .rejects.toThrow("模型请求失败：HTTP 503");
  });

  it("rejects a successful response without a stream body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ body: null }));
    await expect(createLlmClient().stream(settings, messages, undefined, 5_000, "unit", () => {}))
      .rejects.toThrow("响应体为空，不支持流式读取");
  });

  it("translates an abort into the timeout message", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await expect(createLlmClient().stream(settings, messages, undefined, 5_000, "unit", () => {}))
      .rejects.toThrow("模型请求超时，请稍后重试。");
  });

  it("rethrows non-abort failures unchanged", async () => {
    vi.mocked(fetch).mockRejectedValueOnce("network down");
    await expect(createLlmClient().stream(settings, messages, undefined, 5_000, "unit", () => {}))
      .rejects.toBe("network down");
  });

  it("suppresses timing logs when logTiming is false", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.events = [{ chunk: { done: true } }];
    await createLlmClient().stream(settings, messages, undefined, 5_000, "unit", () => {}, false);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("createLlmClient.chat", () => {
  it("delegates to the streaming path and returns the cleaned text", async () => {
    mocks.events = [{ chunk: { deltaText: "plain answer" } }, { chunk: { done: true } }];
    await expect(createLlmClient().chat(settings, messages, undefined, 5_000, "unit")).resolves.toBe("plain answer");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(recordRequest).toHaveBeenCalledWith("test-model");
  });
});

describe("createLlmClient.chatNonStream", () => {
  it("returns the parsed response and records usage and request counts", async () => {
    mocks.adapter.parseResponse.mockReturnValueOnce({
      text: "non-stream answer",
      thinking: "thinking",
      finishReason: "stop",
      refusal: "no",
      structuredValue: { ok: true },
      usage: { input: 7, output: 3, cachedInput: 1, cacheCreation: 2 },
    });
    vi.mocked(fetch).mockResolvedValueOnce(response({ json: async () => ({ raw: true }) }));

    const options = {
      structuredOutput: { mode: "json_object" as const, schema: { type: "object" } },
      maxTokens: 123,
      extraBody: { top_p: 0.9 },
    };
    const result = await createLlmClient().chatNonStream(
      settings, messages, undefined, 5_000, "unit", "high" as never, options,
    );

    expect(result).toEqual({
      text: "non-stream answer",
      thinking: "thinking",
      finishReason: "stop",
      refusal: "no",
      structuredValue: { ok: true },
    });
    expect(recordRequest).toHaveBeenCalledWith("test-model");
    expect(recordUsage).toHaveBeenCalledWith(7, 3, 1, 1, "test-model", 2);
    expect(mocks.adapter.buildRequest).toHaveBeenCalledWith(
      {
        model: "test-model",
        messages,
        stream: false,
        structuredOutput: options.structuredOutput,
        maxTokens: 123,
        extraBody: { top_p: 0.9 },
      },
      expect.objectContaining({ reasoning: "high" }),
    );
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://example.test/chat");
  });

  it("keeps temperature when provided and drops optional request sections when absent", async () => {
    mocks.adapter.parseResponse.mockReturnValueOnce({ text: "", finishReason: "stop" });
    await createLlmClient().chatNonStream(settings, messages, 0.7, 5_000, "unit");
    const request = mocks.adapter.buildRequest.mock.calls[0][0] as Record<string, unknown>;
    expect(request.temperature).toBe(0.7);
    expect("structuredOutput" in request).toBe(false);
    expect("maxTokens" in request).toBe(false);
    expect("extraBody" in request).toBe(false);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("surfaces provider errors without recording a request", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ ok: false, status: 429, json: async () => ({ error: { message: "rate limited" } }) }));
    await expect(createLlmClient().chatNonStream(settings, messages, undefined, 5_000, "unit"))
      .rejects.toThrow("rate limited");
    expect(recordRequest).not.toHaveBeenCalled();
  });

  it("falls back to the HTTP status when the error body is unreadable", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ ok: false, status: 500, json: async () => { throw new Error("bad body"); } }));
    await expect(createLlmClient().chatNonStream(settings, messages, undefined, 5_000, "unit"))
      .rejects.toThrow("模型请求失败：HTTP 500");
  });

  it("propagates an external abort signal to fetch and rethrows the abort error", async () => {
    vi.mocked(fetch).mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }) as Promise<Response>);
    const controller = new AbortController();
    const pending = createLlmClient().chatNonStream(settings, messages, undefined, 5_000, "unit", undefined, undefined, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
