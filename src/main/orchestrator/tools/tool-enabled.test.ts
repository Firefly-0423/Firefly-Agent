import { it, describe, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("../../index", () => ({ sendToLive2DWindow: vi.fn() }));
import { setWeatherConfig } from "./built-in-tools";
import { clearWeatherCaches } from "./builtin-tools/weather-tool";
import { registerTravelTools, setTravelConfig } from "./travel-tools";
import { toolRegistry } from "./registry/tool-registry";

registerTravelTools();
describe("optional service enablement", () => {
  beforeEach(() => {
    clearWeatherCaches();
    setWeatherConfig(() => "Lisbon", () => "amap", () => "", undefined, () => false);
    setTravelConfig(() => "fixture-map-token", () => false);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it.each([
    ["weather", { city: "Lisbon" }, "[错误] 天气查询功能未启用，请在设置里开启"],
    ["plan_trip", { origin: "Station", destination: "Museum" }, "[错误] 出行工具未启用，请在设置里开启"],
  ] as const)("blocks %s before contacting its provider", async (id, args, message) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(toolRegistry.getById(id)!.execute(args)).resolves.toEqual(message);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes the invoking run context alongside the weather card", async () => {
    const publish = vi.fn();
    setWeatherConfig(() => "Lisbon", () => "open-meteo", () => "", publish, () => true);
    const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response({ results: [{ name: "Lisbon", latitude: 38.72, longitude: -9.14, country: "Portugal", admin1: "Lisbon" }] }))
      .mockResolvedValueOnce(response({ current: {
        temperature_2m: 21, apparent_temperature: 22, relative_humidity_2m: 64, precipitation: 0,
        weather_code: 2, wind_speed_10m: 9, wind_direction_10m: 180, surface_pressure: 1009, uv_index: 4, visibility: 12_000,
      } })));
    await toolRegistry.getById("weather")!.execute({ city: "Lisbon" }, { runId: "weather-request-73", userQuery: "Weather in Lisbon" });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ source: "open-meteo" }), expect.objectContaining({ runId: "weather-request-73" }));
  });
});
