import type { WeatherCategory } from "./weather-types";
import { t } from "../../../../i18n";

export const WMO_MAP: Record<number, [WeatherCategory, string]> = Object.fromEntries(([
  [0, "clear", "wmoClear"], [1, "clear", "wmoMostlyClear"],
  [2, "cloudy", "wmoPartlyCloudy"], [3, "cloudy", "wmoOvercast"],
  [45, "cloudy", "wmoFog"], [48, "cloudy", "wmoRimeFog"],
  [51, "rain", "wmoLightRain"], [53, "rain", "wmoModerateRain"], [55, "rain", "wmoHeavyRain"],
  [56, "rain", "wmoFreezingRain"], [57, "rain", "wmoHeavyFreezingRain"],
  [61, "rain", "wmoLightRain"], [63, "rain", "wmoModerateRain"], [65, "rain", "wmoHeavyRain"],
  [66, "rain", "wmoFreezingRain"], [67, "rain", "wmoHeavyFreezingRain"],
  [71, "snow", "wmoLightSnow"], [73, "snow", "wmoModerateSnow"], [75, "snow", "wmoHeavySnow"],
  [77, "snow", "wmoSnowGrains"], [80, "rain", "wmoShowers"], [81, "rain", "wmoHeavyShowers"],
  [82, "rain", "wmoViolentShowers"], [85, "snow", "wmoSnowShowers"], [86, "snow", "wmoHeavySnowShowers"],
  [95, "thunder", "wmoThunderstorm"], [96, "thunder", "wmoThunderstormHail"], [99, "thunder", "wmoHeavyThunderstormHail"],
] satisfies Array<[number, WeatherCategory, string]>).map(([number, category, key]) => [number, [category, "weather." + key]]));

export function mapWmoCode(code: number): [WeatherCategory, string] {
  const match = WMO_MAP[code];
  if (!match) return ["cloudy", t("weather.unknown")];
  return [match[0], t(match[1])];
}

export const AMAP_MAP: Record<string, WeatherCategory> = Object.fromEntries(([
  ["clear", "晴"],
  ["cloudy", "多云", "阴", "雾", "霾", "扬沙", "浮尘", "沙尘暴", "强沙尘暴"],
  ["rain", "小雨", "中雨", "大雨", "暴雨", "阵雨"],
  ["snow", "小雪", "中雪", "大雪", "暴雪", "雨夹雪", "阵雪"],
  ["thunder", "雷阵雨", "雷阵雨并伴有冰雹"],
] satisfies Array<[WeatherCategory, ...string[]]>).flatMap(([category, ...descriptions]) => descriptions.map((description) => [description, category])));

export function mapAmapWeather(text: string): WeatherCategory {
  const category = AMAP_MAP[text];
  return category ?? "cloudy";
}

const compassPoints = "N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW".split(" ");

export function omWindDir(deg: number): string {
  const sector = Math.round(deg / 22.5) % 16;
  return t("weather.windDir" + compassPoints[sector]);
}

export function formatReportTime(reporttime: string): string {
  const clock = reporttime.split(" ")[1] ?? "";
  return t("weather.updatedAt", { time: clock.slice(0, 5) });
}

export function formatDateText(date = new Date()): string {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const week = t("weather.weekday" + date.getDay());
  return t("weather.dateText", { month, day, week });
}
