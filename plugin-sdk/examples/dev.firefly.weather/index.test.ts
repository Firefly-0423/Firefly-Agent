import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHost, type TestHostManifest } from "../../src/testing/index";
import { createWeatherPlugin, validateCity } from "./index.mjs";

const manifest = JSON.parse(
  readFileSync(path.join(__dirname, "firefly.plugin.json"), "utf8"),
) as TestHostManifest;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("dev.firefly.weather example plugin", () => {
  it("reads API key from ctx.secrets, queries OpenWeather on success, and supports settings panel updates", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        name: "Shanghai",
        main: { temp: 23, humidity: 58 },
        weather: [{ description: "晴" }],
      }),
    }));

    const host = createTestHost({
      manifest,
      mode: "work",
      level: "full",
      secrets: { api_key: "owm-secret-1234" },
    });
    const plugin = createWeatherPlugin({ fetchImpl: fetchMock as unknown as typeof fetch });
    await host.activate(plugin);

    const result = await host.callTool("get_weather", { city: "Shanghai" });
    expect(result).toEqual({
      status: "succeeded",
      output: {
        city: "Shanghai",
        temperatureC: 23,
        humidity: 58,
        description: "晴",
        source: "OpenWeather",
      },
      summary: "Shanghai 当前 23°C（OpenWeather）",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("appid=owm-secret-1234");
    expect(host.calls.some((call) => call.method === "secrets.get")).toBe(true);

    // Settings UI saves and clears API key in ctx.secrets; blank keys never call secrets.set.
    const blankSave = await host.sendUiMessage({
      from: { kind: "settings", id: "settings" },
      method: "save_api_key",
      params: { apiKey: "   " },
    });
    expect(blankSave).toEqual({ ok: false, error: "API Key 不能为空" });
    expect(host.calls.filter((call) => call.method === "secrets.set")).toHaveLength(0);

    const saved = await host.sendUiMessage({
      from: { kind: "settings", id: "settings" },
      method: "save_api_key",
      params: { apiKey: "new-key-9876" },
    });
    expect(saved).toEqual({ ok: true, configured: true, maskedKey: "ne********76" });
    expect(host.secrets.get("api_key")).toBe("new-key-9876");

    await host.deactivate("disabled");
  });

  it("falls back to Open-Meteo when no API key is configured", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("geocoding-api.open-meteo.com")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ results: [{ name: "Tokyo", latitude: 35.68, longitude: 139.69 }] }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ current: { temperature_2m: 19, relative_humidity_2m: 50, wind_speed_10m: 8 } }),
      };
    });

    const host = createTestHost({ manifest, mode: "code", level: "full" });
    await host.activate(createWeatherPlugin({ fetchImpl: fetchMock as unknown as typeof fetch }));

    const result = await host.callTool("get_weather", { city: "Tokyo" });
    expect(result).toEqual({
      status: "succeeded",
      output: {
        city: "Tokyo",
        temperatureC: 19,
        humidity: 50,
        windSpeedKmh: 8,
        source: "Open-Meteo",
      },
      summary: "Tokyo 当前 19°C（Open-Meteo）",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["   ", "Beijing?foo=1", "12345", "London\n"])(
    "rejects invalid city %j with not_executed and makes zero network or secrets calls",
    async (badCity) => {
      expect(validateCity(badCity).ok).toBe(false);
      const fetchMock = vi.fn();
      const host = createTestHost({ manifest, mode: "work", level: "full", secrets: { api_key: "k" } });
      await host.activate(createWeatherPlugin({ fetchImpl: fetchMock as unknown as typeof fetch }));

      const result = await host.callTool("get_weather", { city: badCity });
      expect(result.status).toBe("not_executed");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(host.calls.filter((call) => call.method === "secrets.get")).toHaveLength(0);
    },
  );

  it("does not execute network call when tool approval is rejected or mode is chat", async () => {
    const fetchMock = vi.fn();
    const host = createTestHost({
      manifest,
      mode: "work",
      level: "per-action",
      approvalDecision: "reject",
    });
    await host.activate(createWeatherPlugin({ fetchImpl: fetchMock as unknown as typeof fetch }));

    const rejected = await host.callTool("get_weather", { city: "Paris" });
    expect(rejected).toEqual({ status: "not_executed", reason: "ERR_REJECTED: Tool approval was rejected" });

    host.setMode("chat");
    const chatBlocked = await host.callTool("get_weather", { city: "Paris" });
    expect(chatBlocked).toEqual({ status: "not_executed", reason: 'Tool "get_weather" is unavailable in chat mode' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns failed on network error and failed with retryable=true on timeout", async () => {
    const failFetch = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const host1 = createTestHost({ manifest, mode: "work", level: "full" });
    await host1.activate(createWeatherPlugin({ fetchImpl: failFetch as unknown as typeof fetch }));
    const networkFailure = await host1.callTool("get_weather", { city: "Osaka" });
    expect(networkFailure).toEqual({ status: "failed", error: "ECONNRESET", retryable: false });

    vi.useFakeTimers();
    const slowFetch = vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("Aborted");
        err.name = "AbortError";
        reject(err);
      }, { once: true });
    }));
    const host2 = createTestHost({ manifest, mode: "work", level: "full" });
    await host2.activate(createWeatherPlugin({ fetchImpl: slowFetch as unknown as typeof fetch, timeoutMs: 2000 }));

    const pending = host2.callTool("get_weather", { city: "Osaka" });
    await vi.advanceTimersByTimeAsync(2000);
    const timedOut = await pending;
    expect(timedOut).toEqual({
      status: "failed",
      error: "查询 Osaka 天气超时（>2000ms）",
      retryable: true,
    });
  });

  it("returns not_executed on pre-aborted signal and on in-flight cancelTool", async () => {
    const fetchMock = vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("Aborted");
        err.name = "AbortError";
        reject(err);
      }, { once: true });
    }));
    const host = createTestHost({ manifest, mode: "work", level: "full" });
    await host.activate(createWeatherPlugin({ fetchImpl: fetchMock as unknown as typeof fetch }));

    const preAborted = new AbortController();
    preAborted.abort("user-stop");
    const preResult = await host.callTool("get_weather", { city: "Berlin" }, { signal: preAborted.signal });
    expect(preResult.status).toBe("not_executed");
    expect(fetchMock).not.toHaveBeenCalled();

    const inflight = host.callTool("get_weather", { city: "Berlin" }, { callId: "weather-cancel-1" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(host.cancelTool("weather-cancel-1")).toBe(true);
    const cancelledResult = await inflight;
    expect(cancelledResult).toEqual({ status: "not_executed", reason: "天气查询已取消" });
  });
});
