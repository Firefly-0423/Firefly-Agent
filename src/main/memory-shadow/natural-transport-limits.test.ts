import { expect, it, vi } from "vitest";
import { createShadowModel } from "./shadow-model-call";
import type { ChatVendorAdapter } from "../orchestrator/vendors/types";

const config = { provider: "synthetic", baseUrl: "https://synthetic.invalid", model: "fake", apiKey: "synthetic-only" };
const caps = { requestBytes: 16384, outputTokens: 800, responseBytes: 32768 };
function fixture(body = JSON.stringify({ max_tokens: 800, stream: false, messages: [{ role: "user", content: "中文" }] }), response = "{}") {
  const request = { url: "https://synthetic.invalid", headers: { "content-type": "application/json" }, body }, fetchImpl = vi.fn(async () => new Response(response)), onUsage = vi.fn();
  const parse = vi.fn(() => ({ text: "{\"facts\":[]}", usage: { input: 10, output: 5 }, assistantMessage: { role: "assistant", content: "{\"facts\":[]}" } }));
  const adapter = { buildRequest: () => request, parseResponse: parse } as unknown as ChatVendorAdapter;
  const model = createShadowModel({ profile: { id: "synthetic", revision: 1 }, config, adapter, assertCurrent() {}, fetchImpl: fetchImpl as unknown as typeof fetch, verifiedLimits: caps, onUsage });
  return { request, fetchImpl, parse, model, onUsage };
}
it("reports verified UTF8 request bytes and sends the frozen request even if the adapter object changes", async () => {
  const f = fixture(), original = f.request.body, prepared = f.model.prepare("system", "user"); expect(prepared).toMatchObject({ ok: true, limits: { requestBytes: Buffer.byteLength(original), outputTokens: 800 } });
  f.request.body = JSON.stringify({ max_tokens: 1000000, messages: ["mutated"] }); f.request.url = "https://different.invalid";
  if (!prepared.ok) throw Error("expected prepared"); await prepared.send(new AbortController().signal);
  expect(f.fetchImpl.mock.calls[0]).toMatchObject(["https://synthetic.invalid", { body: original, redirect: "error" }]);
});
it.each([
  { max_tokens: 800, max_completion_tokens: 4096 }, { max_tokens: 800, max_output_tokens: "unproved" },
  { max_tokens: 800.5 }, { max_tokens: 800, stream: true }, { max_tokens: 800, data: "中".repeat(5500) },
])("rejects conflicting, unproved or oversized actual wire bounds before sending: %j", value => {
  const f = fixture(JSON.stringify(value)); expect(f.model.prepare("s", "u").ok).toBe(false); expect(f.fetchImpl).not.toHaveBeenCalled();
});
it("caps response bytes before adapter parsing and never exposes oversized provider text", async () => {
  const f = fixture(undefined, "SYNTHETIC_PRIVATE_RESPONSE".repeat(2000)), p = f.model.prepare("s", "u"); if (!p.ok) throw Error("expected prepared");
  expect(await p.send(new AbortController().signal)).toEqual({ ok: false, kind: "limits" }); expect(f.parse).not.toHaveBeenCalled(); expect(f.fetchImpl).toHaveBeenCalledOnce();
});
it("does not forward malformed provider usage into aggregate accounting", async () => {
  const f = fixture(), value = f.parse.getMockImplementation()!(); f.parse.mockReturnValue({ ...value, usage: { input: NaN, output: 5 } });
  const p = f.model.prepare("s", "u"); if (!p.ok) throw Error("expected prepared");
  const result = await p.send(new AbortController().signal); expect(result.ok).toBe(true); expect("usage" in result).toBe(false); expect(f.onUsage).not.toHaveBeenCalled();
});
it("preserves legitimate separately reported cached-input accounting", async () => {
  const f = fixture(), value = f.parse.getMockImplementation()!(), usage = { input: 10, output: 5, cachedInput: 1000, cacheCreation: 20 }; f.parse.mockReturnValue({ ...value, usage });
  const p = f.model.prepare("s", "u"); if (!p.ok) throw Error("expected prepared");
  expect(await p.send(new AbortController().signal)).toMatchObject({ ok: true, usage }); expect(f.onUsage).toHaveBeenCalledWith("fake", usage);
});
