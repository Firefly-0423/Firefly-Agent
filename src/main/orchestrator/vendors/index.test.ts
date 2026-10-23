import { expect, it, vi } from "vitest";
import { buildVendorUrl, createSseReader, getAdapterForConfig } from "./index";
import { OpenAICompatAdapter } from "./openai-adapter";
import { AnthropicAdapter } from "./anthropic-adapter";
import { ResponsesAdapter } from "./responses-adapter";
it.each([["openai", OpenAICompatAdapter], ["anthropic", AnthropicAdapter], ["responses", ResponsesAdapter]] as const)("selects and reuses %s adapters independently of credentials", (explicitTransport, Type) => {
  const cfg = { provider: "unit-provider", baseUrl: "https://example.test", model: "a", apiKey: "test", explicitTransport };
  const adapter = getAdapterForConfig(cfg); expect(adapter).toBeInstanceOf(Type); expect(getAdapterForConfig({ ...cfg, model: "b", apiKey: "changed" })).toBe(adapter);
});
it("keeps transport/provider caches separate and falls back to OpenAI for unknown providers", () => {
  const cfg = { provider: "unknown-provider", baseUrl: "https://example.test", model: "m", apiKey: "test" };
  expect(getAdapterForConfig(cfg)).toBeInstanceOf(OpenAICompatAdapter);
  expect(getAdapterForConfig(cfg)).not.toBe(getAdapterForConfig({ ...cfg, explicitTransport: "anthropic" }));
  expect(getAdapterForConfig(cfg)).not.toBe(getAdapterForConfig({ ...cfg, provider: "another" }));
});
it.each([["https://example.test/v1/", "openai", "https://example.test/v1/chat/completions"], ["https://example.test", "anthropic", "https://example.test/v1/messages"], ["https://example.test/v1", "anthropic", "https://example.test/v1/messages"], ["https://example.test/v1", "responses", "https://example.test/v1/responses"]] as const)("builds %s %s endpoint", (base, transport, expected) => { expect(buildVendorUrl(base, transport)).toBe(expected); });
it("decodes split multibyte UTF-8, multiline data, ignored fields and trailing event", async () => {
  const bytes = new TextEncoder().encode(": heartbeat\r\n\r\nevent: message\r\nid: 1\r\nretry: 10\r\ndata: 中文\r\ndata:  second\r\n\r\ndata: tail");
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } });
  const found = []; for await (const event of createSseReader({} as never, stream)) found.push(event);
  expect(found).toEqual([{ eventType: "message", data: "中文\n second" }, { eventType: "data", data: "tail" }]);
});
it("cancels a reader on early iteration exit", async () => {
  const cancel = vi.fn(); const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("data: a\n\n")); }, cancel });
  for await (const event of createSseReader({} as never, stream)) { expect(event.data).toBe("a"); break; } expect(cancel).toHaveBeenCalledOnce();
});
it("propagates stream read failures", async () => {
  const error = Error("read failed"), stream = new ReadableStream<Uint8Array>({ start(c) { c.error(error); } });
  await expect(createSseReader({} as never, stream)[Symbol.asyncIterator]().next()).rejects.toBe(error);
});
