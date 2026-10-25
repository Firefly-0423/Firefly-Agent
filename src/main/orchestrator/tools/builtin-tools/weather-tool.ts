import type { ToolDefinition } from "../registry/tool-registry";
import type { ToolContext } from "../registry/tool-context";
import { getDateLocale, getWeatherLanguage } from "../../../startup/locale-context";
import { currentUserTimezone } from "./timezone";
import { TtlResultCache } from "./ttl-result-cache";

export interface WeatherCardData {
  source: "open-meteo" | "amap";
  location: { province: string; city: string };
  weatherCode?: number; temp: number; feelsLike?: number; humidity: number;
  windDeg?: number; windSpeed?: number; precipitation?: number; pressure?: number;
  weather?: string; windDirection?: string; windPower?: string; reporttime?: string;
}
interface OMCity { name: string; latitude: number; longitude: number; country: string; admin1?: string }
interface AmapDistrict { adcode: string; name: string; level: string }
interface WeatherCacheEntry { data: Record<string, unknown>; card: WeatherCardData | null }
type CardCallback = (card: WeatherCardData, context?: ToolContext) => void;
const configuration: { city: (() => string) | null; source: (() => string) | null; key: (() => string) | null; enabled: (() => boolean) | null; card: CardCallback | null } = {
  city: null, source: null, key: null, enabled: null, card: null,
};
function readSetting<T>(reader: (() => T) | null): T | undefined { return reader?.(); }
const cityCoordinates = new TtlResultCache<OMCity>(24 * 60 * 60_000);
const districts = new TtlResultCache<AmapDistrict>(24 * 60 * 60_000);
const conditions = new TtlResultCache<WeatherCacheEntry>(30 * 60_000);
export function clearWeatherCaches(): void {
  cityCoordinates.clear();
  districts.clear();
  conditions.clear();
}
export function setWeatherConfig(
  cityGetter: () => string, sourceGetter: () => string, amapKeyFn: () => string,
  cardCb?: (card: WeatherCardData, context?: ToolContext) => void, enabledGetter?: () => boolean,
): void {
  configuration.city = cityGetter;
  configuration.source = sourceGetter;
  configuration.key = amapKeyFn;
  configuration.enabled = enabledGetter ?? null;
  if (cardCb) configuration.card = cardCb;
}
async function resolveLocation<T>(endpoint: string, accept: (value: unknown) => T | null): Promise<T | null> {
  const cancellation = new AbortController();
  const deadline = setTimeout(() => cancellation.abort(), 15_000);
  try {
    const reply = await fetch(endpoint, { signal: cancellation.signal });
    if (!reply.ok) return null;
    const payload: unknown = await reply.json();
    return accept(payload);
  } catch { return null; }
  finally { clearTimeout(deadline); }
}
async function omResolveCity(city: string): Promise<OMCity | null> {
  const identity = city + "|" + getWeatherLanguage();
  const saved = cityCoordinates.get(identity);
  if (saved) return saved.value;
  const parameters = new URLSearchParams({ name: city, count: "1", language: getWeatherLanguage(), format: "json" });
  const endpoint = `https://geocoding-api.open-meteo.com/v1/search?${parameters}`;
  return resolveLocation(endpoint, value => {
    const payload = value as { results?: OMCity[] };
    if (!payload.results || payload.results.length === 0) return null;
    cityCoordinates.set(identity, payload.results[0]);
    return payload.results[0];
  });
}
async function amapResolveAdcode(city: string, key: string): Promise<AmapDistrict | null> {
  const saved = districts.get(city);
  if (saved) return saved.value;
  const endpoint = `https://restapi.amap.com/v3/config/district?keywords=${encodeURIComponent(city)}&subdistrict=0&key=${key}`;
  return resolveLocation(endpoint, value => {
    const payload = value as { status?: string; districts?: AmapDistrict[] };
    if (payload.status !== "1" || !payload.districts || payload.districts.length === 0) return null;
    districts.set(city, payload.districts[0]);
    return payload.districts[0];
  });
}
function cachedConditions(identity: string, context?: ToolContext): string | null {
  const saved = conditions.get(identity);
  if (!saved) return null;
  const callback = configuration.card;
  if (saved.value.card && callback) callback(saved.value.card, context);
  return JSON.stringify({ ...saved.value.data, cached: true, cachedAt: new Date(saved.at).toISOString() });
}
function publishConditions(identity: string, data: Record<string, unknown>, card: WeatherCardData, context?: ToolContext): string {
  conditions.set(identity, { data, card });
  const callback = configuration.card;
  if (callback) callback(card, context);
  return JSON.stringify(data);
}
async function requestConditions<T>(endpoint: string, present: (payload: T) => string): Promise<string> {
  const cancellation = new AbortController();
  const deadline = setTimeout(() => cancellation.abort(), 15_000);
  try {
    const reply = await fetch(endpoint, { signal: cancellation.signal });
    if (!reply.ok) return `[错误] 天气查询失败：HTTP ${reply.status}`;
    return present(await reply.json() as T);
  } catch (failure) {
    const detail = failure instanceof Error ? failure.message : String(failure);
    return "[错误] 天气查询失败：" + detail;
  } finally { clearTimeout(deadline); }
}
type OMForecast = { current?: {
  temperature_2m: number; relative_humidity_2m: number; apparent_temperature: number; precipitation: number;
  weather_code: number; wind_speed_10m: number; wind_direction_10m: number; surface_pressure: number; uv_index: number; visibility: number;
}; daily?: { time: string[]; temperature_2m_max: number[]; temperature_2m_min: number[]; weather_code: number[]; wind_speed_10m_max: number[]; wind_direction_10m_dominant: number[] } };
async function omFetchWeather(city: string, context?: ToolContext): Promise<string> {
  const identity = "open-meteo|" + city;
  const saved = cachedConditions(identity, context);
  if (saved !== null) return saved;
  const place = await omResolveCity(city);
  if (!place) return `[错误] 找不到城市"${city}"，请确认城市名（支持中文/拼音）。`;
  const currentFields = ["temperature_2m", "relative_humidity_2m", "apparent_temperature", "precipitation", "weather_code", "wind_speed_10m", "wind_direction_10m", "surface_pressure", "uv_index", "visibility"].join(",");
  const dailyFields = ["temperature_2m_max", "temperature_2m_min", "weather_code", "wind_speed_10m_max", "wind_direction_10m_dominant"].join(",");
  const endpoint = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=${currentFields}&daily=${dailyFields}&timezone=auto`;
  return requestConditions<OMForecast>(endpoint, payload => {
    const reading = payload.current;
    if (!reading) return "[错误] 天气查询失败：Open-Meteo 未返回数据";
    const sky = omWeatherCodeText(reading.weather_code);
    const compass = omWindDir(reading.wind_direction_10m);
    const region = place.admin1 ? `${place.admin1}` : place.country;
    const output = { city: place.name, region, weather: sky,
      temperature: reading.temperature_2m, feelsLike: reading.apparent_temperature, humidity: reading.relative_humidity_2m,
      windDirection: compass, windSpeed: `${reading.wind_speed_10m}km/h`, precipitation: reading.precipitation,
      pressure: Math.round(reading.surface_pressure), uv: reading.uv_index, visibility: Math.round(reading.visibility / 1000),
      source: "Open-Meteo", updateTime: new Date().toLocaleString(getDateLocale(), { hour: "2-digit", minute: "2-digit", timeZone: currentUserTimezone() }) };
    const card: WeatherCardData = { source: "open-meteo", location: { province: region, city: place.name },
      weatherCode: reading.weather_code, temp: reading.temperature_2m, feelsLike: reading.apparent_temperature,
      humidity: reading.relative_humidity_2m, windDeg: reading.wind_direction_10m, windSpeed: reading.wind_speed_10m,
      precipitation: reading.precipitation, pressure: Math.round(reading.surface_pressure) };
    return publishConditions(identity, output, card, context);
  });
}
function omWeatherCodeText(code: number): string {
  const descriptions: Record<number, string> = { 0: "晴", 1: "晴间多云", 2: "多云", 3: "阴", 45: "雾", 48: "雾凇",
    51: "小雨", 53: "中雨", 55: "大雨", 56: "冻雨", 57: "强冻雨", 61: "小雨", 63: "中雨", 65: "大雨",
    66: "冻雨", 67: "强冻雨", 71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒", 80: "阵雨", 81: "强阵雨",
    82: "暴雨", 85: "阵雪", 86: "强阵雪", 95: "雷暴", 96: "雷暴伴冰雹", 99: "强雷暴伴冰雹" };
  return descriptions[code] ?? `未知（代码${code}）`;
}
function omWindDir(deg: number): string {
  const compass = ["北", "东北偏北", "东北", "东北偏东", "东", "东南偏东", "东南", "东南偏南", "南", "西南偏南", "西南", "西南偏西", "西", "西北偏西", "西北", "西北偏北"];
  const sector = Math.round(deg / 22.5) % 16;
  return compass[sector];
}
type AmapLive = { province: string; city: string; weather: string; temperature: string; winddirection: string; windpower: string; humidity: string; reporttime: string };
async function amapFetchWeather(city: string, key: string, context?: ToolContext): Promise<string> {
  const identity = "amap|" + city;
  const saved = cachedConditions(identity, context);
  if (saved !== null) return saved;
  const district = await amapResolveAdcode(city, key);
  if (!district) return `[错误] 找不到城市"${city}"，请确认城市名（支持中文，如"无锡"）。`;
  const endpoint = `https://restapi.amap.com/v3/weather/weatherInfo?city=${district.adcode}&key=${key}&extensions=base`;
  return requestConditions<{ status?: string; lives?: AmapLive[] }>(endpoint, payload => {
    if (payload.status !== "1" || !payload.lives || payload.lives.length === 0) return `[错误] 天气查询失败：高德返回 status=${payload.status ?? "?"}`;
    const reading = payload.lives[0];
    const output = { city: reading.city, region: reading.province, weather: reading.weather,
      temperature: Number(reading.temperature), humidity: Number(reading.humidity), windDirection: reading.winddirection,
      windSpeed: `${reading.windpower}级`, source: "高德天气",
      updateTime: reading.reporttime.slice(11, 16) || new Date().toLocaleString(getDateLocale(), { hour: "2-digit", minute: "2-digit" }) };
    const card: WeatherCardData = { source: "amap", location: { province: reading.province, city: reading.city },
      weather: reading.weather, temp: Number(reading.temperature), humidity: Number(reading.humidity),
      windDirection: reading.winddirection, windPower: reading.windpower, reporttime: reading.reporttime };
    return publishConditions(identity, output, card, context);
  });
}
async function executeWeather(args: Record<string, unknown>, context?: ToolContext): Promise<string> {
  if (configuration.enabled && !readSetting(configuration.enabled)) return "[错误] 天气查询功能未启用，请在设置里开启";
  const provider = readSetting(configuration.source) ?? "open-meteo";
  let municipality = String(args.city ?? "").trim();
  if (!municipality) municipality = (readSetting(configuration.city) ?? "").trim();
  const argumentCity = String(args.city ?? "").trim();
  const profileCity = (readSetting(configuration.city) ?? "").trim();
  const selectedBy: "arg" | "default" | "none" = argumentCity ? "arg" : profileCity ? "default" : "none";
  console.log(`[Weather] city resolution: argsCity=${argumentCity || "(empty)"} defaultCity=${profileCity || "(empty)"} final=${municipality || "(empty)"} source=${selectedBy}`);
  if (!municipality) return "[提示] 没有指定城市，也没设置默认城市。请告诉用户：在 设置 → 我的信息 填默认城市，或直接说出要查的城市名。";
  switch (provider) {
    case "open-meteo": return omFetchWeather(municipality, context);
    case "amap": {
      const credential = readSetting(configuration.key) ?? "";
      if (!credential) return "[错误] 还没有配置高德天气 Key。请在 设置 → 插件 → 天气查询 填入高德 Key，或切换天气源为 Open-Meteo（免配置）。";
      return amapFetchWeather(municipality, credential, context);
    }
    default: return `[错误] 未知的天气源"${provider}"。请在 设置 → 插件 → 天气查询 选择 Open-Meteo 或 高德天气。`;
  }
}
const HANDLER_weather = executeWeather;
export const weatherTool: ToolDefinition = {
  "id": "weather",
  "name": "查天气",
  "description": "查询指定城市的实时天气。返回温度、体感温度、湿度、风速风向、降水、日出日落、AQI、UV 等。\n\n何时用：\n- 用户问'今天天气怎样''外面冷不冷''热不热''要不要带伞''穿什么'\n- 用户提到城市名 + 天气相关词\n- 用户问'周末适合出去玩吗'且涉及天气判断\n\n不要用于：\n- 历史天气（'上周北京天气'）—— 做不到，直接告诉用户\n- 逐小时精确预报\n- 完全跟天气无关的问题\n\n参数：city（可选，城市名中文或拼音；不传则用用户设置的默认城市）。",
  "enabled": true,
  "risk": "network",
  "modes": [
    "work"
  ],
  "effectKind": "read",
  "verificationPolicy": "none",
  "inputSchema": {
    "type": "object",
    "properties": {
      "city": {
        "type": "string",
        "description": "要查询的城市名（中文或拼音），不传则用用户默认城市"
      }
    },
    "required": []
  }
, execute: HANDLER_weather };
