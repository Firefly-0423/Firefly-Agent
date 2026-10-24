import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ timeoutMs: 500 }));
vi.mock("../runtime-policy", () => ({
  resolveTimeoutPolicy: () => ({ totalMs: mocks.timeoutMs }),
}));

import { buildMosslandError, mosslandFetch } from "./api-client";

const init = (overrides: Record<string, unknown> = {}) => ({
  method: "POST",
  apiKey: "test-key",
  ...overrides,
}) as Parameters<typeof mosslandFetch>[1];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.timeoutMs = 500;
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("buildMosslandError", () => {
  it("explains HTTP 413 without parsing the body", () => {
    expect(buildMosslandError("语音合成", 413, "any body").message).toBe(
      "语音合成：上传的文件太大，超过了服务端限制（HTTP 413）。请压缩或截短音频后重试。",
    );
  });

  it("includes a truncated raw body when the response is not JSON", () => {
    const raw = "x".repeat(500);
    expect(buildMosslandError("请求", 502, raw).message).toBe(`请求：HTTP 502 ${"x".repeat(200)}`);
  });

  it("maps known error codes to friendly text and appends status and code", () => {
    expect(
      buildMosslandError("请求", 401, JSON.stringify({ error: { code: "authentication_error", message: "bad key" } }))
        .message,
    ).toBe("请求：API Key 无效，请检查 Authorization 头 (HTTP 401, code: authentication_error)");
    expect(
      buildMosslandError("请求", 402, JSON.stringify({ error: { code: "insufficient_credits" } })).message,
    ).toBe("请求：余额不足，请前往控制台充值 (HTTP 402, code: insufficient_credits)");
  });

  it("uses error_msg and error_code when present", () => {
    expect(
      buildMosslandError(
        "请求",
        429,
        JSON.stringify({ error: { error_msg: "slow down", error_code: "rate_limit_exceeded", message: "ignored" } }),
      ).message,
    ).toBe("请求：请求过于频繁，请稍后再试 (HTTP 429, code: rate_limit_exceeded)");
    expect(
      buildMosslandError("请求", 429, JSON.stringify({ error: { error_msg: "upstream detail", error_code: 42 } }))
        .message,
    ).toBe("请求：upstream detail (HTTP 429, code: 42)");
  });

  it("falls back to the upstream message for unknown codes", () => {
    expect(
      buildMosslandError("请求", 418, JSON.stringify({ error: { code: "teapot", message: "I am a teapot" } })).message,
    ).toBe("请求：I am a teapot (HTTP 418, code: teapot)");
  });

  it("uses the unknown-error text when the body carries neither code nor message", () => {
    expect(buildMosslandError("请求", 500, "{}").message).toBe("请求：未知错误 (code: ?) (HTTP 500)");
  });

  it("falls back to the raw body when the JSON body is null", () => {
    // JSON.parse("null") succeeds but there is no error object, so the raw-body branch is used.
    expect(buildMosslandError("请求", 500, "null").message).toBe("请求：HTTP 500 null");
  });
});

describe("mosslandFetch", () => {
  it("adds the bearer token while preserving caller headers and method", async () => {
    await mosslandFetch("https://api.mosi.cn/v1/test", init({ headers: { "Content-Type": "application/json" } }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.mosi.cn/v1/test");
    expect(request.method).toBe("POST");
    expect(request.headers).toEqual({ Authorization: "Bearer test-key", "Content-Type": "application/json" });
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it("lets an explicit Authorization header override the default", async () => {
    await mosslandFetch("https://api.mosi.cn/v1/test", init({ headers: { Authorization: "Bearer other" } }));
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(request.headers).toEqual({ Authorization: "Bearer other" });
  });

  it("returns the fetch response unchanged", async () => {
    const response = new Response("ok", { status: 201 });
    fetchMock.mockResolvedValue(response);
    await expect(mosslandFetch("https://api.mosi.cn", init())).resolves.toBe(response);
  });

  it("aborts on timeout and rejects with an AbortError", async () => {
    fetchMock.mockImplementation(
      (_url: string, request: RequestInit) =>
        new Promise((_resolve, reject) => {
          request.signal!.addEventListener("abort", () => {
            const error = new Error("Operation aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    await expect(mosslandFetch("https://api.mosi.cn", init({ timeoutMs: 5 }))).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("refuses to call fetch when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      mosslandFetch("https://api.mosi.cn", init({ signal: controller.signal })),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects promptly when the caller aborts an in-flight request", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_url: string, request: RequestInit) =>
        new Promise((_resolve, reject) => {
          request.signal!.addEventListener("abort", () => {
            const error = new Error("Operation aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    const pending = mosslandFetch("https://api.mosi.cn", init({ signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("propagates fetch failures unchanged", async () => {
    const failure = new Error("network down");
    fetchMock.mockRejectedValue(failure);
    await expect(mosslandFetch("https://api.mosi.cn", init())).rejects.toBe(failure);
  });

  it("uses the runtime timeout policy by default", async () => {
    mocks.timeoutMs = 5;
    fetchMock.mockImplementation(
      (_url: string, request: RequestInit) =>
        new Promise((_resolve, reject) => {
          request.signal!.addEventListener("abort", () => {
            const error = new Error("Operation aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    await expect(mosslandFetch("https://api.mosi.cn", init())).rejects.toMatchObject({ name: "AbortError" });
  });
});
