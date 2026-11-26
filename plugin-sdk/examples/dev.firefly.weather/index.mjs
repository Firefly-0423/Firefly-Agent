/**
 * @file Firefly 1.2.0 SDK example: dev.firefly.weather
 * Demonstrates a `network` tool with parameter validation, timeout/network/cancel
 * ToolResult handling, `ctx.secrets` storage, and a settings panel message handler.
 */

const SECRET_KEY = "api_key";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_CITY_LENGTH = 100;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const URL_RESERVED = /[/?#&=\\]/;
const HAS_LETTER = /\p{L}/u;

/**
 * Validate the `city` argument before making any secret or network call.
 * @param {unknown} raw
 * @returns {{ ok: true; city: string } | { ok: false; reason: string }}
 */
export function validateCity(raw) {
  if (typeof raw !== "string") {
    return { ok: false, reason: "城市参数 city 必须是字符串" };
  }
  if (CONTROL_CHARS.test(raw)) {
    return { ok: false, reason: "城市名格式不合法：不能包含控制字符或换行符" };
  }
  const city = raw.trim();
  if (city.length === 0 || city.length > MAX_CITY_LENGTH) {
    return { ok: false, reason: `城市名长度必须在 1 到 ${MAX_CITY_LENGTH} 个字符之间` };
  }
  if (URL_RESERVED.test(city) || !HAS_LETTER.test(city)) {
    return { ok: false, reason: "城市名格式不合法：请提供真实城市名称，不能包含控制字符或 URL 保留符号" };
  }
  return { ok: true, city };
}

function maskKey(key) {
  if (key.length <= 4) return "****";
  return `${key.slice(0, 2)}${"*".repeat(Math.min(8, key.length - 4))}${key.slice(-2)}`;
}

async function readJson(fetchImpl, url, signal) {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) {
    const err = new Error(`天气服务返回 HTTP ${response.status}`);
    err.httpStatus = response.status;
    throw err;
  }
  return await response.json();
}

async function queryOpenWeather(fetchImpl, city, apiKey, signal) {
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${encodeURIComponent(apiKey)}&units=metric&lang=zh_cn`;
  const data = await readJson(fetchImpl, url, signal);
  return {
    city: data.name ?? city,
    temperatureC: data.main?.temp ?? null,
    humidity: data.main?.humidity ?? null,
    description: data.weather?.[0]?.description ?? "未知",
    source: "OpenWeather",
  };
}

async function queryOpenMeteo(fetchImpl, city, signal) {
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`;
  const geo = await readJson(fetchImpl, geoUrl, signal);
  const place = geo.results?.[0];
  if (!place) {
    throw new Error(`找不到城市: ${city}`);
  }
  const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m`;
  const weather = await readJson(fetchImpl, weatherUrl, signal);
  return {
    city: place.name ?? city,
    temperatureC: weather.current?.temperature_2m ?? null,
    humidity: weather.current?.relative_humidity_2m ?? null,
    windSpeedKmh: weather.current?.wind_speed_10m ?? null,
    source: "Open-Meteo",
  };
}

/**
 * Create the weather plugin instance. Optional overrides support deterministic testing.
 * @param {{ fetchImpl?: typeof fetch; timeoutMs?: number }} [options]
 * @returns {import("@firefly_wu/plugin-sdk").PluginDefinition}
 */
export function createWeatherPlugin(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  /** @type {Array<{ dispose(): void }>} */
  const disposables = [];

  return {
    activate(ctx) {
      const toolDisp = ctx.tools.register({
        name: "get_weather",
        description: "联网查询指定城市的当前天气。",
        parameters: {
          type: "object",
          properties: {
            city: {
              type: "string",
              description: "要查询的城市名称，例如「上海」或「Tokyo」",
              minLength: 1,
              maxLength: MAX_CITY_LENGTH,
            },
          },
          required: ["city"],
          additionalProperties: false,
        },
        describeApproval(args) {
          const city = typeof args?.city === "string" ? args.city.trim() : "";
          return {
            summary: city ? `联网查询「${city}」天气` : "联网查询城市天气",
            target: city || undefined,
          };
        },
        async execute(args, call) {
          const check = validateCity(args?.city);
          if (!check.ok) {
            return { status: "not_executed", reason: check.reason };
          }
          if (call.signal.aborted) {
            return { status: "not_executed", reason: "天气查询已在执行前取消" };
          }
          if (!ctx.has("secrets")) {
            return { status: "failed", error: "缺少 secrets 权限，无法读取 API Key", retryable: false };
          }

          let apiKey;
          try {
            apiKey = await ctx.secrets.get(SECRET_KEY);
          } catch (error) {
            return {
              status: "failed",
              error: `读取 API Key 失败: ${error instanceof Error ? error.message : String(error)}`,
              retryable: false,
            };
          }

          if (call.signal.aborted) {
            return { status: "not_executed", reason: "天气查询已取消" };
          }

          const controller = new AbortController();
          let timedOut = false;
          let cancelled = false;
          const onCallerAbort = () => {
            cancelled = true;
            controller.abort(call.signal.reason ?? "cancelled");
          };
          call.signal.addEventListener("abort", onCallerAbort, { once: true });
          const timer = setTimeout(() => {
            timedOut = true;
            controller.abort("timeout");
          }, timeoutMs);

          try {
            call.progress(`正在查询 ${check.city} 的天气...`, 20);
            const result = apiKey
              ? await queryOpenWeather(fetchImpl, check.city, apiKey, controller.signal)
              : await queryOpenMeteo(fetchImpl, check.city, controller.signal);
            return {
              status: "succeeded",
              output: result,
              summary: `${result.city} 当前 ${result.temperatureC ?? "?"}°C（${result.source}）`,
            };
          } catch (error) {
            if (timedOut) {
              return { status: "failed", error: `查询 ${check.city} 天气超时（>${timeoutMs}ms）`, retryable: true };
            }
            if (cancelled || call.signal.aborted) {
              return { status: "not_executed", reason: "天气查询已取消" };
            }
            return {
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
              retryable: false,
            };
          } finally {
            clearTimeout(timer);
            call.signal.removeEventListener("abort", onCallerAbort);
          }
        },
      });
      disposables.push(toolDisp);

      const uiDisp = ctx.ui.onMessage(async (event) => {
        if (event.from.kind !== "settings") {
          return { ok: false, error: "仅允许设置面板修改天气 API Key" };
        }
        if (!ctx.has("secrets")) {
          return { ok: false, error: "secrets 权限已撤销" };
        }
        if (event.method === "get_settings") {
          const existing = await ctx.secrets.get(SECRET_KEY);
          return {
            ok: true,
            configured: Boolean(existing),
            maskedKey: existing ? maskKey(existing) : null,
          };
        }
        if (event.method === "save_api_key") {
          const rawKey = event.params && typeof event.params === "object"
            ? /** @type {{ apiKey?: unknown }} */ (event.params).apiKey
            : undefined;
          if (typeof rawKey !== "string" || rawKey.trim().length === 0) {
            return { ok: false, error: "API Key 不能为空" };
          }
          const trimmed = rawKey.trim();
          await ctx.secrets.set(SECRET_KEY, trimmed);
          return { ok: true, configured: true, maskedKey: maskKey(trimmed) };
        }
        if (event.method === "clear_api_key") {
          const deleted = await ctx.secrets.delete(SECRET_KEY);
          return { ok: true, configured: false, deleted };
        }
        return { ok: false, error: `未知方法: ${event.method}` };
      });
      disposables.push(uiDisp);
    },

    deactivate() {
      while (disposables.length > 0) {
        disposables.pop()?.dispose();
      }
    },
  };
}

export default createWeatherPlugin();
