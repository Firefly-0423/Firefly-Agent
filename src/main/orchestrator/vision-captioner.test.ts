import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../runtime-policy", () => ({ resolveTimeoutPolicy: () => ({ totalMs: 50 }) }));
import { captionImage } from "./vision-captioner";
const config = { baseUrl: " https://vision.example/v1/// ", apiKey: "test-key", model: "vision" };
const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: "A cat" } }] }) }); vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
it("sends base64 image and the original question to a normalized endpoint", async () => {
  expect(await captionImage({ base64: "AAAA", mime: "image/png" }, "  Count cats?  ", config)).toBe("A cat");
  const [url, request] = fetchMock.mock.calls[0]; expect(url).toBe("https://vision.example/v1/chat/completions");
  expect(request.headers.Authorization).toBe("Bearer test-key");
  const body = JSON.parse(request.body); expect(body).toMatchObject({ model: "vision", stream: false, max_tokens: 512 }); expect(body).not.toHaveProperty("temperature");
  expect(body.messages[0].content[0].text).toContain('"  Count cats?  "'); expect(body.messages[0].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
});
it("passes public URLs through and describes images when the question is blank", async () => {
  await captionImage({ url: "https://image.example/a.png" }, " \t", { ...config, baseUrl: "https://vision.example/chat/completions/" });
  expect(fetchMock.mock.calls[0][0]).toBe("https://vision.example/chat/completions"); const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.messages[0].content[0].text).toContain("描述控制在 200 字以内"); expect(body.messages[0].content[1].image_url.url).toBe("https://image.example/a.png");
});
it.each([{}, { choices: [] }, { choices: [{ message: { content: null } }] }])("reports empty provider content %j", async body => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => body }); expect(await captionImage({ url: "x" }, "", config)).toBe("[错误·运行时] 视觉模型未返回有效内容");
});
it("bounds HTTP error text", async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => "x".repeat(300) }); expect(await captionImage({ url: "x" }, "", config)).toBe("[错误·运行时] 视觉模型请求失败：HTTP 429 " + "x".repeat(200));
});
it("handles unreadable error bodies", async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => { throw Error("body"); } }); expect(await captionImage({ url: "x" }, "", config)).toBe("[错误·运行时] 视觉模型请求失败：HTTP 500 ");
});
it.each([new Error("offline"), "offline"])("reports request exceptions %s", async error => {
  fetchMock.mockRejectedValue(error); expect(await captionImage({ url: "x" }, "", config)).toBe("[错误·运行时] 视觉模型请求异常：offline");
});
it("aborts on timeout and clears its timer", async () => {
  vi.useFakeTimers(); fetchMock.mockImplementation((_url, { signal }) => new Promise((_yes, no) => signal.addEventListener("abort", () => no(Object.assign(Error("abort"), { name: "AbortError" })))));
  const pending = captionImage({ url: "x" }, "", config); await vi.advanceTimersByTimeAsync(50); expect(await pending).toBe("[错误·运行时] 视觉模型请求超时"); expect(vi.getTimerCount()).toBe(0);
});
