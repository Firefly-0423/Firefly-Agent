import { it, expect, describe, beforeEach, afterEach, vi } from "vitest";
import { weatherTool, clearWeatherCaches, setWeatherConfig } from "./weather-tool";

const cityRecord = { name: "Porto", latitude: 41.15, longitude: -8.61, country: "Portugal", admin1: "Porto District" };
const forecast = { current: {
  temperature_2m: 19.2, relative_humidity_2m: 73, apparent_temperature: 18.1, precipitation: 0.4,
  weather_code: 3, wind_speed_10m: 16, wind_direction_10m: 270, surface_pressure: 1007.8, uv_index: 2, visibility: 15_000,
}, daily: { time: ["2025-04-11"], temperature_2m_max: [21], temperature_2m_min: [14], weather_code: [3], wind_speed_10m_max: [23], wind_direction_10m_dominant: [270] } };
let publish = vi.fn();
let network = vi.fn();
const weather = async (city = "Porto") => JSON.parse(await weatherTool.execute({ city }));

beforeEach(() => {
  clearWeatherCaches();
  publish = vi.fn();
  setWeatherConfig(() => "Porto", () => "open-meteo", () => "", publish, () => true);
  network = vi.fn(async (input: unknown) => new Response(JSON.stringify(String(input).includes("geocoding-api") ? { results: [cityRecord] } : forecast)));
  vi.stubGlobal("fetch", network);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("weather lookup freshness", () => {
  it("reuses both lookups while still publishing a second card", async () => {
    const initial = await weather();
    expect(initial.cached).toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(1);
    const repeated = await weather();
    expect(repeated).toMatchObject({ cached: true, cachedAt: expect.any(String) });
    expect(network).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1][0]).toEqual(publish.mock.calls[0][0]);
  });
  it("separates city cache entries", async () => {
    await weather("Porto");
    await weather("Braga");
    expect(network).toHaveBeenCalledTimes(4);
  });
  it("refreshes weather after thirty-one minutes while retaining the geocode", async () => {
    vi.useFakeTimers();
    await weather();
    expect(network).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(31 * 60_000);
    expect((await weather()).cached).toBeUndefined();
    expect(network).toHaveBeenCalledTimes(3);
    expect(String(network.mock.calls[2][0])).toContain("api.open-meteo.com/v1/forecast");
  });
});
