import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({ register: vi.fn() }));
const logger = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("./registry/tool-registry", () => ({ toolRegistry: registry }));
vi.mock("../../logger", () => ({ logger, LogTag: { TravelTools: "travel-tools" } }));

import { registerTravelTools, setTravelConfig } from "./travel-tools";

interface RegisteredTool {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  risk: string;
  modes: string[];
  inputSchema: { properties: Record<string, unknown>; required: string[] };
  execute: (args: Record<string, unknown>) => Promise<string>;
}

registerTravelTools();
const tool = registry.register.mock.calls[0][0] as RegisteredTool;

type FetchHandler = (url: string) => { ok: boolean; status: number; json: () => Promise<unknown> };

function json(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function geocodeAnswer(address: string): string {
  return address === "起点" ? "116.100000,39.100000" : "116.200000,39.200000";
}

const DEFAULT_DRIVING = {
  route: { paths: [{ distance: "12345", duration: "1800", tolls: "15", toll_distance: "500", traffic_lights: "3" }] },
};
const DEFAULT_WALKING = { route: { paths: [{ distance: "1500", duration: "1200" }] } };
const DEFAULT_CYCLING = { data: { paths: [{ distance: "5000", duration: "900" }] } };
const DEFAULT_TRANSIT = {
  route: {
    taxi_cost: "30",
    transits: [{
      cost: "5",
      duration: "3600",
      walking_distance: "800",
      segments: [
        { bus: { buslines: [{ name: "1路", depart_stop: { name: "A站" }, arrival_stop: { name: "B站" } }] } },
        { walking: { distance: "200.4", duration: "180" } },
      ],
    }],
  },
};

/** Routes geocode + direction calls; `overrides` keyed by URL fragment can replace any answer. */
function routeFetch(overrides: Record<string, FetchHandler> = {}) {
  const fetchMock = vi.fn(async (input: string) => {
    for (const [fragment, handler] of Object.entries(overrides)) {
      if (input.includes(fragment)) return handler(input);
    }
    if (input.includes("/v3/geocode/geo")) {
      const address = new URL(input).searchParams.get("address") ?? "";
      return json({ status: "1", geocodes: [{ location: geocodeAnswer(address) }] });
    }
    if (input.includes("/v3/direction/driving")) return json(DEFAULT_DRIVING);
    if (input.includes("/v3/direction/walking")) return json(DEFAULT_WALKING);
    if (input.includes("/v4/direction/bicycling")) return json(DEFAULT_CYCLING);
    if (input.includes("/v3/direction/transit/integrated")) return json(DEFAULT_TRANSIT);
    throw new Error(`unexpected URL ${input}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function geocodes(fetchMock: ReturnType<typeof routeFetch>) {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes("/v3/geocode/geo"));
}

async function plan(args: Record<string, unknown>): Promise<string> {
  return tool.execute({ origin: "起点", destination: "终点", ...args });
}

beforeEach(() => {
  setTravelConfig(() => "test-amap-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("plan_trip registration", () => {
  it("registers the work-mode network tool with a required origin/destination schema", () => {
    expect(registry.register).toHaveBeenCalledTimes(1);
    expect(tool).toMatchObject({
      id: "plan_trip",
      name: "🚗出行工具",
      enabled: true,
      risk: "network",
      modes: ["work"],
    });
    expect(tool.inputSchema.required).toEqual(["origin", "destination"]);
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(["city", "destination", "mode", "origin"]);
    expect(tool.description).toContain("交通");
    expect(logger.info).toHaveBeenCalledWith("travel-tools", "registered: plan_trip");
  });
});

describe("plan_trip configuration gates", () => {
  it("refuses to run while travel is disabled, before touching the network", async () => {
    routeFetch();
    setTravelConfig(() => "test-amap-key", () => false);
    await expect(plan({})).resolves.toBe("[错误] 出行工具未启用，请在设置里开启");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("restores the enabled default when no enabled getter is provided", async () => {
    routeFetch();
    setTravelConfig(() => "test-amap-key", () => false);
    setTravelConfig(() => "test-amap-key");
    await expect(plan({ mode: "步行" })).resolves.toContain("步行路线");
  });

  it("explains how to configure a missing AMap key", async () => {
    routeFetch();
    setTravelConfig(() => "");
    const result = await plan({});
    expect(result).toContain("[提示] 高德 API Key 未配置");
    expect(result).toContain("lbs.amap.com");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("treats a missing getter as an unconfigured key", async () => {
    routeFetch();
    setTravelConfig(() => "");
    await expect(plan({})).resolves.toContain("[提示] 高德 API Key 未配置");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("plan_trip input validation", () => {
  it.each([
    [{ origin: undefined, destination: "终点" }],
    [{ origin: "  ", destination: "终点" }],
    [{ origin: "起点", destination: "" }],
    [{ origin: "起点", destination: "  " }],
  ])("requires a non-blank origin and destination (%j)", async args => {
    routeFetch();
    await expect(plan(args)).resolves.toBe("[错误] 请提供起点和终点");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports an unresolvable origin with the supplied name", async () => {
    routeFetch({ "/v3/geocode/geo": () => json({ status: "1", geocodes: [] }) });
    await expect(plan({})).resolves.toBe("[错误] 无法解析起点「起点」的位置，请尝试更具体的名称");
  });

  it("reports an unresolvable destination", async () => {
    routeFetch({
      "/v3/geocode/geo": url => json(url.includes(encodeURIComponent("起点"))
        ? { status: "1", geocodes: [{ location: "116.1,39.1" }] }
        : { status: "1", geocodes: [] }),
    });
    await expect(plan({})).resolves.toBe("[错误] 无法解析终点「终点」的位置，请尝试更具体的名称");
  });

  it("treats a non-ok geocode response as unresolved", async () => {
    routeFetch({ "/v3/geocode/geo": () => json({ status: "1", geocodes: [{ location: "x" }] }, false, 500) });
    await expect(plan({})).resolves.toContain("无法解析起点");
  });

  it("rejects an unsupported travel mode after geocoding", async () => {
    const fetchMock = routeFetch();
    await expect(plan({ mode: "飞机" })).resolves.toBe("[错误] 不支持的出行方式「飞机」。支持：驾车、步行、骑行、公交");
    expect(geocodes(fetchMock)).toHaveLength(2);
  });
});

describe("driving directions", () => {
  it("formats distance, duration, toll and traffic lights", async () => {
    routeFetch();
    await expect(plan({})).resolves.toBe([
      "🚗 驾车路线",
      "距离：12.3 公里",
      "预计用时：30 分钟",
      "路费：15 元",
      "红绿灯：3 个",
    ].join("\n"));
  });

  it("reports a free route and falls back to zero traffic lights", async () => {
    routeFetch({
      "/v3/direction/driving": () => json({ route: { paths: [{ distance: "800", duration: "119", tolls: "0", toll_distance: "0", traffic_lights: "" }] } }),
    });
    await expect(plan({ mode: "开车" })).resolves.toBe([
      "🚗 驾车路线",
      "距离：0.8 公里",
      "预计用时：2 分钟",
      "路费：免费",
      "红绿灯：0 个",
    ].join("\n"));
  });

  it("reports missing paths and HTTP failures", async () => {
    routeFetch({ "/v3/direction/driving": () => json({ route: {} }) });
    await expect(plan({ mode: "驾车" })).resolves.toBe("[错误] 未找到驾车路线");
    routeFetch({ "/v3/direction/driving": () => json({}, false, 503) });
    await expect(plan({ mode: "驾车" })).resolves.toBe("[错误] 驾车路线查询失败：HTTP 503");
  });

  it("returns the transport error text when the request throws", async () => {
    routeFetch({ "/v3/direction/driving": () => { throw new Error("socket closed"); } });
    await expect(plan({ mode: "驾车" })).resolves.toBe("[错误] 驾车路线查询失败：socket closed");
  });
});

describe("walking directions", () => {
  it("formats long distances in kilometres", async () => {
    routeFetch();
    await expect(plan({ mode: "步行" })).resolves.toBe([
      "🚶 步行路线",
      "距离：1.5 公里",
      "预计用时：20 分钟",
    ].join("\n"));
  });

  it("formats short distances in metres", async () => {
    routeFetch({ "/v3/direction/walking": () => json({ route: { paths: [{ distance: "800", duration: "599" }] } }) });
    await expect(plan({ mode: "走路" })).resolves.toBe([
      "🚶 步行路线",
      "距离：800 米",
      "预计用时：10 分钟",
    ].join("\n"));
  });

  it("reports missing paths, HTTP failures and thrown errors", async () => {
    routeFetch({ "/v3/direction/walking": () => json({ route: { paths: [] } }) });
    await expect(plan({ mode: "步行" })).resolves.toBe("[错误] 未找到步行路线");
    routeFetch({ "/v3/direction/walking": () => json({}, false, 500) });
    await expect(plan({ mode: "步行" })).resolves.toBe("[错误] 步行路线查询失败：HTTP 500");
    routeFetch({ "/v3/direction/walking": () => { throw "boom"; } });
    await expect(plan({ mode: "步行" })).resolves.toBe("[错误] 步行路线查询失败：boom");
  });
});

describe("cycling directions", () => {
  it.each(["骑行", "骑车", "自行车"])("supports the %s alias", async mode => {
    routeFetch();
    await expect(plan({ mode })).resolves.toBe([
      "🚲 骑行路线",
      "距离：5.0 公里",
      "预计用时：15 分钟",
    ].join("\n"));
  });

  it("reports missing paths, HTTP failures and thrown errors", async () => {
    routeFetch({ "/v4/direction/bicycling": () => json({ data: { paths: [] } }) });
    await expect(plan({ mode: "骑行" })).resolves.toBe("[错误] 未找到骑行路线");
    routeFetch({ "/v4/direction/bicycling": () => json({}, false, 429) });
    await expect(plan({ mode: "骑行" })).resolves.toBe("[错误] 骑行路线查询失败：HTTP 429");
    routeFetch({ "/v4/direction/bicycling": () => { throw new Error("aborted"); } });
    await expect(plan({ mode: "骑行" })).resolves.toBe("[错误] 骑行路线查询失败：aborted");
  });
});

describe("transit directions", () => {
  it.each(["公交", "公共交通", "地铁", "公交地铁"])("supports the %s alias", async mode => {
    routeFetch();
    const result = await plan({ mode, city: "北京" });
    expect(result).toContain("🚌 公交路线");
    expect(result).toContain("预计用时：60 分钟");
    expect(result).toContain("票价：5 元（步行 800 米）");
    expect(result).toContain("打车参考价：30 元");
  });

  it("describes bus and walking segments in order", async () => {
    routeFetch();
    const result = await plan({ mode: "公交", city: "北京" });
    expect(result).toContain("换乘方案：");
    expect(result).toContain("  1. 乘 1路：A站 → B站");
    expect(result).toContain("  2. 步行 200 米");
  });

  it("omits the segment list and optional prices when absent", async () => {
    routeFetch({
      "/v3/direction/transit/integrated": () => json({
        route: { transits: [{ cost: "0", duration: "600", walking_distance: "0" }] },
      }),
    });
    const result = await plan({ mode: "公交", city: "上海" });
    expect(result).toBe([
      "🚌 公交路线",
      "预计用时：10 分钟",
      "票价：0 元",
    ].join("\n"));
  });

  it("requires a city for transit before requesting a route", async () => {
    const fetchMock = routeFetch();
    await expect(plan({ mode: "公交" })).resolves.toBe("[错误] 公交路线必须提供城市（参数 city），例如 city='北京'");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/transit/"))).toBe(false);
  });

  it("trims the city and encodes it into the request", async () => {
    const fetchMock = routeFetch();
    await plan({ mode: "公交", city: "  北京市  " });
    const url = fetchMock.mock.calls.map(([value]) => String(value)).find(value => value.includes("/transit/"));
    expect(new URL(url!).searchParams.get("city")).toBe("北京市");
  });

  it("reports missing routes, HTTP failures and thrown errors", async () => {
    routeFetch({ "/v3/direction/transit/integrated": () => json({ route: {} }) });
    await expect(plan({ mode: "公交", city: "北京" })).resolves.toBe("[错误] 未找到公交路线");
    routeFetch({ "/v3/direction/transit/integrated": () => json({}, false, 400) });
    await expect(plan({ mode: "公交", city: "北京" })).resolves.toBe("[错误] 公交路线查询失败：HTTP 400");
    routeFetch({ "/v3/direction/transit/integrated": () => { throw new Error("network down"); } });
    await expect(plan({ mode: "公交", city: "北京" })).resolves.toBe("[错误] 公交路线查询失败：network down");
  });
});

describe("geocoding", () => {
  it("sends both place names and the configured key to the geocoder", async () => {
    const fetchMock = routeFetch();
    await plan({ mode: "步行" });
    const entries = geocodes(fetchMock);
    expect(entries.map(([url]) => new URL(String(url)).searchParams.get("address"))).toEqual(["起点", "终点"]);
    for (const [url] of entries) expect(new URL(String(url)).searchParams.get("key")).toBe("test-amap-key");
  });

  it("treats a thrown geocoder request as an unresolved place", async () => {
    routeFetch({ "/v3/geocode/geo": () => { throw new Error("offline"); } });
    await expect(plan({})).resolves.toContain("无法解析起点「起点」");
  });
});
