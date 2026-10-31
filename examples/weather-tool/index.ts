/**
 * weather-tool 示例：联网查询天气，同时演示工具、普通存储与 Secrets。
 *
 * 要点：
 * - manifest 声明 secrets 依赖后，用 ctx.deps.secrets 读取本插件命名空间下的密钥
 * - 数据源降级：配了 OpenWeather 密钥就走官方接口；没配或请求失败，退回免密钥的 Open-Meteo
 * - 用 ctx.storage 记住最近一次查询的城市，下次不传参数时当作默认城市
 */
import type { FireflyPlugin, PluginTool } from "@firefly_wu/plugin-sdk";

/** 状态放在模块作用域里：register 时读到的密钥，以及最近一次查询的城市。 */
let openWeatherKey: string | undefined;
let recentCity: string | undefined;

/** 拉取 JSON；HTTP 状态异常时抛出带前缀说明的错误。 */
async function fetchJson<T>(url: string, failure: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${failure}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** Open-Meteo 地理编码（免密钥）：城市名换经纬度。 */
async function locate(city: string): Promise<{ lat: number; lon: number }> {
  const body = await fetchJson<{ results?: Array<{ latitude: number; longitude: number }> }>(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`,
    "地理编码请求失败",
  );
  const match = body.results?.[0];
  if (!match) throw new Error(`找不到城市: ${city}`);
  return { lat: match.latitude, lon: match.longitude };
}

async function fromOpenMeteo(city: string): Promise<string> {
  const { lat, lon } = await locate(city);
  const body = await fetchJson<{
    current?: { temperature_2m?: number; relative_humidity_2m?: number; wind_speed_10m?: number };
  }>(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m`,
    "天气请求失败",
  );
  const { temperature_2m: temp, relative_humidity_2m: humidity, wind_speed_10m: wind } = body.current ?? {};
  return `${city} 当前 ${temp ?? "?"}°C，湿度 ${humidity ?? "?"}%，风速 ${wind ?? "?"} km/h（Open-Meteo）`;
}

async function fromOpenWeather(city: string, key: string): Promise<string> {
  const query = `q=${encodeURIComponent(city)}&appid=${encodeURIComponent(key)}&units=metric&lang=zh_cn`;
  const body = await fetchJson<{
    name?: string;
    weather?: Array<{ description?: string }>;
    main?: { temp?: number; humidity?: number };
  }>(`https://api.openweathermap.org/data/2.5/weather?${query}`, "天气请求失败");
  const condition = body.weather?.[0]?.description ?? "未知";
  return `${body.name ?? city} 当前 ${body.main?.temp ?? "?"}°C（${condition}），湿度 ${body.main?.humidity ?? "?"}%（OpenWeather）`;
}

/** 有密钥时先试 OpenWeather，失败（如密钥失效）则不报错，改用 Open-Meteo。 */
async function lookupWeather(city: string): Promise<string> {
  if (openWeatherKey) {
    try {
      return await fromOpenWeather(city, openWeatherKey);
    } catch {
      // 继续走免密钥数据源
    }
  }
  return fromOpenMeteo(city);
}

/** 省略 city 时回落到上次的城市；两者都没有则提示调用方补充。 */
async function runQuery(args: Record<string, unknown>): Promise<string> {
  const city = String(args.city ?? "").trim() || recentCity;
  if (!city) return "请提供要查询的城市名（参数 city），例如：{ \"city\": \"上海\" }";

  recentCity = city;
  return lookupWeather(city);
}

const cityField = { type: "string", description: "城市名，省略时使用上次查询的城市" };

const queryTool: PluginTool = {
  id: "weather-tool_query",
  name: "查询天气",
  description: "查询指定城市的当前天气。参数 city 为城市名（如「上海」「Tokyo」）；省略时使用上次查询过的城市。",
  risk: "network",
  effectKind: "external_side_effect",
  inputSchema: { type: "object", properties: { city: cityField } },
  execute: runQuery,
  enabled: true,
};

const plugin: FireflyPlugin = {
  async register(ctx) {
    // secrets 只能经由 PluginContext 注入；在 register 阶段取出并缓存，工具闭包随后使用
    openWeatherKey = await ctx.deps.secrets?.get("openweathermap_key");
    recentCity = ctx.storage.get<string>("lastCity");

    ctx.registerTool(queryTool);

    // 停止时写回城市，清理时机交给框架
    ctx.onDispose(() => {
      ctx.storage.set("lastCity", recentCity);
    });
  },
  unregister() {
    openWeatherKey = undefined;
    recentCity = undefined;
  },
};

export = plugin;
