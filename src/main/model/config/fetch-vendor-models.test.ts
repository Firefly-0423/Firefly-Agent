import { describe, expect, it, vi } from "vitest";
import { fetchVendorModels, parseModelList, resolveModelsUrl } from "./fetch-vendor-models";

const json = (body: unknown, init: { status?: number } = {}) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { "content-type": "application/json" } }));

describe("resolveModelsUrl", () => {
  it("appends /models for OpenAI-style endpoints and strips a pasted call path", () => {
    expect(resolveModelsUrl("https://api.openai.com/v1", "openai")).toBe("https://api.openai.com/v1/models");
    expect(resolveModelsUrl("https://proxy.test/v1/chat/completions/", "openai")).toBe("https://proxy.test/v1/models");
    expect(resolveModelsUrl("https://api.openai.com/v1/responses", "responses")).toBe("https://api.openai.com/v1/models");
  });

  it("uses /v1/models for Anthropic and does not double the version segment", () => {
    expect(resolveModelsUrl("https://api.anthropic.com", "anthropic")).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(resolveModelsUrl("https://api.example.test/anthropic/v1", "anthropic")).toBe("https://api.example.test/anthropic/v1/models?limit=1000");
    expect(resolveModelsUrl("https://api.example.test/anthropic/v1/messages", "anthropic")).toBe("https://api.example.test/anthropic/v1/models?limit=1000");
  });
});

describe("parseModelList", () => {
  it("reads the OpenAI/Anthropic data array, keeps display names, drops blanks and duplicates", () => {
    expect(parseModelList({ data: [{ id: "m-1" }, { id: "m-2", display_name: "Model Two" }, { id: "m-1" }, { id: " " }, { nope: 1 }] }))
      .toEqual([{ id: "m-1" }, { id: "m-2", name: "Model Two" }]);
  });

  it("accepts the looser shapes some compatible endpoints return", () => {
    expect(parseModelList({ models: [{ name: "a" }, "b"] })).toEqual([{ id: "a" }, { id: "b" }]);
    expect(parseModelList(["x", "y"])).toEqual([{ id: "x" }, { id: "y" }]);
    expect(parseModelList(null)).toEqual([]);
    expect(parseModelList({ data: "nope" })).toEqual([]);
  });
});

describe("parseModelList with a models map", () => {
  it("uses the property key as the request id and ignores non-object entries", () => {
    expect(parseModelList({ models: { "alias-1": { id: "canonical-1", name: "Alias One" }, "alias-2": { display_name: "Two" }, count: 2, status: "ok", list: [1] } }))
      .toEqual([{ id: "alias-1", name: "Alias One" }, { id: "alias-2", name: "Two" }]);
  });

  it("prefers the standard data array when both shapes are present", () => {
    expect(parseModelList({ data: [{ id: "d" }], models: { m: {} } })).toEqual([{ id: "d" }]);
  });

  it("falls back to the nested id when the key is blank", () => {
    expect(parseModelList({ models: { " ": { id: "inner" } } })).toEqual([{ id: "inner" }]);
  });
});

describe("fetchVendorModels", () => {
  it("asks the connected vendor with the profile's key and returns its models", async () => {
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) => json({ data: [{ id: "gpt-x" }, { id: "gpt-y" }] }));
    const result = await fetchVendorModels(
      { provider: "ChatGPT（OpenAI）", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test", explicitTransport: "responses" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result).toEqual({ ok: true, models: [{ id: "gpt-x" }, { id: "gpt-y" }] });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/models");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });

  it("sends the Anthropic version header on the Anthropic protocol", async () => {
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) => json({ data: [{ id: "claude-x", display_name: "Claude X" }] }));
    const result = await fetchVendorModels(
      { provider: "自定义", baseUrl: "https://api.example.test/anthropic", apiKey: "k", explicitTransport: "anthropic" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result).toEqual({ ok: true, models: [{ id: "claude-x", name: "Claude X" }] });
    const headers = fetchImpl.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["anthropic-version"]).toBeTruthy();
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.example.test/anthropic/v1/models?limit=1000");
  });

  it("reports what went wrong without touching the network when the profile is incomplete", async () => {
    const fetchImpl = vi.fn();
    expect(await fetchVendorModels({ provider: "p", baseUrl: "", apiKey: "k" }, { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ ok: false, error: "MISSING_BASE_URL" });
    expect(await fetchVendorModels({ provider: "p", baseUrl: "https://x.test", apiKey: " " }, { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ ok: false, error: "MISSING_API_KEY" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps HTTP, network and empty-answer failures to short codes that never echo the key", async () => {
    const base = { provider: "p", baseUrl: "https://x.test/v1", apiKey: "secret-key" };
    expect(await fetchVendorModels(base, { fetchImpl: (() => json({ error: "no" }, { status: 401 })) as unknown as typeof fetch })).toEqual({ ok: false, error: "HTTP_401" });
    expect(await fetchVendorModels(base, { fetchImpl: (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch })).toEqual({ ok: false, error: "NETWORK" });
    expect(await fetchVendorModels(base, { fetchImpl: (() => json({ data: [] })) as unknown as typeof fetch })).toEqual({ ok: false, error: "BAD_RESPONSE" });
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(await fetchVendorModels(base, { fetchImpl: (() => Promise.reject(abort)) as unknown as typeof fetch })).toEqual({ ok: false, error: "TIMEOUT" });
  });

  it("refuses a reply larger than the ceiling, whether declared or only discovered while reading", async () => {
    const base = { provider: "p", baseUrl: "https://x.test/v1", apiKey: "k" };
    const declared = () => Promise.resolve(new Response("{}", { headers: { "content-length": String(5 * 1024 * 1024) } }));
    expect(await fetchVendorModels(base, { fetchImpl: declared as unknown as typeof fetch })).toEqual({ ok: false, error: "BAD_RESPONSE" });
    const chunk = new Uint8Array(1024 * 1024);
    const streamed = () => Promise.resolve(new Response(new ReadableStream({
      start(controller) { for (let i = 0; i < 5; i++) controller.enqueue(chunk); controller.close(); },
    })));
    expect(await fetchVendorModels(base, { fetchImpl: streamed as unknown as typeof fetch })).toEqual({ ok: false, error: "BAD_RESPONSE" });
  });

  it("reports non-JSON bodies as a bad response", async () => {
    const html = () => Promise.resolve(new Response("<html></html>", { status: 200 }));
    expect(await fetchVendorModels({ provider: "p", baseUrl: "https://x.test/v1", apiKey: "k" }, { fetchImpl: html as unknown as typeof fetch })).toEqual({ ok: false, error: "BAD_RESPONSE" });
  });
});

describe("parseModelList 输入模态（厂商接口的真实形状）", () => {
  it("OpenRouter：architecture.input_modalities 为准，旧式 modality 字符串也认，两者都没有就是未知", () => {
    const body = {
      data: [
        { id: "openai/gpt-4o", name: "OpenAI: GPT-4o", architecture: { modality: "text+image->text", input_modalities: ["text", "image"], output_modalities: ["text"], tokenizer: "GPT" } },
        { id: "deepseek/deepseek-chat", name: "DeepSeek: V3", architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"] } },
        { id: "legacy/vision-old", architecture: { modality: "text+image->text" } },
        { id: "x/no-info", architecture: { tokenizer: "GPT", instruct_type: null } },
      ],
    };
    expect(parseModelList(body)).toEqual([
      { id: "openai/gpt-4o", name: "OpenAI: GPT-4o", inputModalities: ["text", "image"] },
      { id: "deepseek/deepseek-chat", name: "DeepSeek: V3", inputModalities: ["text"] },
      { id: "legacy/vision-old", inputModalities: ["text", "image"] },
      { id: "x/no-info" },
    ]);
  });

  it("Anthropic：capabilities.image_input.supported 决定能否看图，false 也是明确的仅文本", () => {
    const body = {
      data: [
        { type: "model", id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6", created_at: "2026-02-17T00:00:00Z", capabilities: { image_input: { supported: true }, pdf_input: { supported: true }, thinking: { supported: true } } },
        { type: "model", id: "claude-text-only", display_name: "Claude Text", created_at: "2025-01-01T00:00:00Z", capabilities: { image_input: { supported: false } } },
      ],
      has_more: false,
      first_id: "claude-sonnet-4-6",
      last_id: "claude-text-only",
    };
    expect(parseModelList(body)).toEqual([
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", inputModalities: ["text", "image"] },
      { id: "claude-text-only", name: "Claude Text", inputModalities: ["text"] },
    ]);
  });

  it("通用字段：input_modalities / modalities（数组或 {input:[...]}），大小写与空白容忍，纯音频不算文本或图片", () => {
    expect(parseModelList({ data: [
      { id: "g-array", modalities: ["text", "image"] },
      { id: "g-object", modalities: { input: ["text"], output: ["text"] } },
      { id: "g-top", input_modalities: ["Text", " IMAGE "] },
      { id: "g-audio-only", modalities: ["audio"] },
    ] })).toEqual([
      { id: "g-array", inputModalities: ["text", "image"] },
      { id: "g-object", inputModalities: ["text"] },
      { id: "g-top", inputModalities: ["text", "image"] },
      { id: "g-audio-only" },
    ]);
  });

  it("布尔能力位：Mistral 的 capabilities.vision、supports_vision、vision；false 表示明确不支持图片", () => {
    expect(parseModelList({ data: [
      { id: "mistral-small-latest", object: "model", capabilities: { completion_chat: true, function_calling: true, fim_completion: false, fine_tuning: false, vision: true, classification: false } },
      { id: "mistral-text", object: "model", capabilities: { completion_chat: true, vision: false } },
      { id: "gateway-a", supports_vision: true },
      { id: "gateway-b", vision: false },
    ] })).toEqual([
      { id: "mistral-small-latest", inputModalities: ["text", "image"] },
      { id: "mistral-text", inputModalities: ["text"] },
      { id: "gateway-a", inputModalities: ["text", "image"] },
      { id: "gateway-b", inputModalities: ["text"] },
    ]);
  });

  it("没有任何模态信息的条目保持未知（不写入字段），不当成仅文本", () => {
    const [model] = parseModelList({ data: [{ id: "plain", owned_by: "x" }] });
    expect(model).toEqual({ id: "plain" });
    expect(model).not.toHaveProperty("inputModalities");
  });

  it("models 映射形状同样带上输入模态", () => {
    expect(parseModelList({ models: { "alias-1": { id: "canonical-1" }, "alias-2": { id: "canonical-2", capabilities: { vision: true } } } }))
      .toEqual([{ id: "alias-1" }, { id: "alias-2", inputModalities: ["text", "image"] }]);
  });
});

describe("fetchVendorModels 带出输入模态", () => {
  it("OpenRouter 清单经 fetchVendorModels 返回时保留 inputModalities", async () => {
    const fetchImpl = vi.fn(() => json({ data: [{ id: "openai/gpt-4o", architecture: { input_modalities: ["text", "image"] } }] }));
    const result = await fetchVendorModels(
      { provider: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-test" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result).toEqual({ ok: true, models: [{ id: "openai/gpt-4o", inputModalities: ["text", "image"] }] });
  });
});

describe("OpenRouter model list", () => {
  it("resolves the models endpoint from the preset Base URL and from a pasted chat-completions address", () => {
    expect(resolveModelsUrl("https://openrouter.ai/api/v1", "openai")).toBe("https://openrouter.ai/api/v1/models");
    expect(resolveModelsUrl("https://openrouter.ai/api/v1/chat/completions", "openai")).toBe("https://openrouter.ai/api/v1/models");
  });

  it("reads the { data: [{ id, name }] } shape with vendor/model ids, keeps the display name and drops duplicates", () => {
    expect(parseModelList({
      data: [
        { id: "openai/gpt-5.6", name: "OpenAI: GPT-5.6", architecture: { input_modalities: ["text", "image"] }, supported_parameters: ["reasoning", "tools"] },
        { id: "deepseek/deepseek-v4-pro", name: "DeepSeek: DeepSeek V4 Pro" },
        { id: "openai/gpt-5.6", name: "duplicate" },
      ],
    })).toEqual([
      { id: "openai/gpt-5.6", name: "OpenAI: GPT-5.6", inputModalities: ["text", "image"] },
      { id: "deepseek/deepseek-v4-pro", name: "DeepSeek: DeepSeek V4 Pro" },
    ]);
  });

  it("fetches the list with the Bearer key and without the Anthropic version header", async () => {
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) => json({ data: [{ id: "openai/gpt-5.6", name: "OpenAI: GPT-5.6" }] }));
    const result = await fetchVendorModels(
      { provider: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-v1-test" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result).toEqual({ ok: true, models: [{ id: "openai/gpt-5.6", name: "OpenAI: GPT-5.6" }] });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/models");
    expect(init?.method).toBe("GET");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-or-v1-test");
    expect(headers["anthropic-version"]).toBeUndefined();
  });
});
