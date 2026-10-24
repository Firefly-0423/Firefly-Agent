import { expect, it, vi } from "vitest";
import * as counting from "./model-counting";
import type { VendorConfig } from "../orchestrator/vendors/types";
import type { PreparedRequest, TokenCounter } from "./context-contracts";
const openrouter: VendorConfig = { provider: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna", apiKey: "synthetic", explicitTransport: "responses" };
function counter(config = openrouter, revision = 1, options: Record<string, unknown> = {}): TokenCounter {
  const resolve = (counting as Record<string, unknown>).resolveMemoryCounter;
  expect(resolve).toBeTypeOf("function");
  return (resolve as (c: VendorConfig, r: number, o: unknown) => TokenCounter)(config, revision, options);
}
function frame(c: TokenCounter, extra: Record<string, unknown> = {}, inputTypes = ["text"]): PreparedRequest {
  const { providerId, model, transport, framingVersion } = c.capability;
  return { providerId, model, transport, framingVersion, body: { model, input: "合成中文测试", ...extra } as PreparedRequest["body"], inputTypes };
}
it("labels configured non-OpenAI counters as estimates without contacting a counter endpoint", async () => {
  const exactCount = vi.fn();
  const c = counter(openrouter, 1, { exactCount });
  expect(c.capability.mode).toBe("estimate"); expect(await c.count(frame(c))).toBeGreaterThan(0);
  expect(exactCount).not.toHaveBeenCalled();
});
it("allows verified official Responses exact counting and refuses a missing exact adapter", async () => {
  const cfg = { ...openrouter, baseUrl: "https://api.openai.com/v1", model: "gpt-5.2" };
  expect(() => counter(cfg)).toThrow("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");
  const exactCount = vi.fn(async () => 123), c = counter(cfg, 1, { exactCount });
  expect(c.capability.mode).toBe("exact"); expect(await c.count(frame(c))).toBe(123);
  expect(exactCount).toHaveBeenCalledOnce();
});
it("does not infer exact counting from model name or provider display name", () => {
  for (const baseUrl of ["https://api.openai.com.attacker.invalid/v1", "https://api.openai.com:444/v1", "https://api.openai.com/v1?proxy=1"]) {
    expect(counter({ ...openrouter, provider: "ChatGPT（OpenAI）", model: "gpt-5.2", baseUrl }).capability.mode).toBe("estimate");
  }
});
it("binds counting identity to transport, model, endpoint and trusted revision", () => {
  const c = counter(), next = counter(openrouter, 2), other = counter({ ...openrouter, baseUrl: "https://local.invalid/v1" });
  expect(c.capability.framingVersion).not.toBe(next.capability.framingVersion);
  expect(c.capability.providerId).not.toBe(other.capability.providerId);
  expect(c.capability.transport).toBe("responses");
});
it("counts complete tool schema and treats image payload as a labeled image estimate", async () => {
  const c = counter(), plain = await c.count(frame(c));
  const tools = [{ type: "function", name: "tool", description: "synthetic description ".repeat(200), parameters: { type: "object" } }];
  expect(await c.count(frame(c, { tools }, ["text", "function-tools"]))).toBeGreaterThan(plain);
  const image = (data: string) => frame(c, { input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64," + data }] }] }, ["text", "image"]);
  const short = await c.count(image("a".repeat(100))), long = await c.count(image("a".repeat(100000)));
  expect(long).toBe(short); expect(long).toBeGreaterThanOrEqual(4096);
  expect(c.capability.mode).toBe("estimate");
});
it("rejects unknown input types, counter identity mismatch, and wire model mismatch", async () => {
  const c = counter();
  await expect(c.count(frame(c, {}, ["audio"]))).rejects.toThrow("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");
  await expect(c.count({ ...frame(c), framingVersion: "forged" })).rejects.toThrow("MEMORY_CONTEXT_COUNTER_MISMATCH");
  await expect(c.count(frame(c, { model: "another-model" }))).rejects.toThrow("MEMORY_CONTEXT_COUNTER_MISMATCH");
});
it("cancellation before counting performs no exact request", async () => {
  const exactCount = vi.fn(async () => 12), c = counter({ ...openrouter, baseUrl: "https://api.openai.com/v1" }, 1, { exactCount });
  const abort = new AbortController(); abort.abort();
  await expect(c.count(frame(c), { signal: abort.signal })).rejects.toThrow("MEMORY_CONTEXT_CANCELLED");
  expect(exactCount).not.toHaveBeenCalled();
});
it("revalidates trusted configuration after exact counting and rejects invalid counts", async () => {
  let current = true;
  const cfg = { ...openrouter, baseUrl: "https://api.openai.com/v1" };
  const c = counter(cfg, 1, { validateCurrent: () => { if (!current) throw Error("CONFIG_CHANGED"); }, exactCount: async () => { current = false; return 42; } });
  await expect(c.count(frame(c))).rejects.toThrow("CONFIG_CHANGED");
  for (const value of [-1, 0.5, NaN]) {
    const invalid = counter(cfg, 1, { exactCount: async () => value });
    await expect(invalid.count(frame(invalid))).rejects.toThrow("MEMORY_CONTEXT_COUNT_FAILED");
  }
});
it("never hides tool-schema text merely because it resembles an image block", async () => {
  const c = counter();
  const tool = (text: string) => frame(c, { tools: [{ type: "function", name: "test", parameters: { default: { type: "input_image", image_url: "synthetic", description: text } } }] }, ["text", "function-tools"]);
  expect(await c.count(tool("schema text ".repeat(300)))).toBeGreaterThan((await c.count(tool("short"))) + 500);
});
it("sanitizes provider counting errors instead of leaking response text", async () => {
  const c = counter({ ...openrouter, baseUrl: "https://api.openai.com/v1" }, 1, { exactCount: async () => { throw Error("SYNTHETIC_PRIVATE_RESPONSE"); } });
  await expect(c.count(frame(c))).rejects.toThrow("MEMORY_CONTEXT_COUNT_FAILED");
});
it("estimates images in Responses function outputs without counting their base64 as text", async () => {
 const c = counter();
 const make = (size: number) => frame(c, { input: [{ type: "function_call_output", call_id: "call-a", output: [{ type: "input_image", image_url: "data:image/png;base64," + "a".repeat(size) }] }] }, ["text", "function-tools", "image"]);
 expect(await c.count(make(100000))).toBe(await c.count(make(100)));
});
it("allows Main to explicitly choose labeled estimate mode for official endpoints without claiming exact limits",async()=>{
 const c=counter({...openrouter,baseUrl:"https://api.openai.com/v1"},1,{mode:"estimate"});expect(c.capability.mode).toBe("estimate");expect(c.capability.framingVersion).toContain("firefly-prepared-estimate-v1");expect(await c.count(frame(c))).toBeGreaterThan(0);
});
