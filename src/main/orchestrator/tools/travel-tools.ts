import { toolRegistry } from "./registry/tool-registry";
import { logger, LogTag } from "../../logging/logger";

const tripConfiguration: { key: (() => string) | null; enabled: (() => boolean) | null } = { key: null, enabled: null };
function readSetting<T>(reader: (() => T) | null): T | undefined { return reader?.(); }
export function setTravelConfig(amapKeyFn: () => string, enabledFn?: () => boolean): void {
  tripConfiguration.key = amapKeyFn;
  tripConfiguration.enabled = enabledFn ?? null;
}
async function geocode(address: string, key: string): Promise<string | null> {
  const endpoint = `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(address)}&output=JSON&key=${key}`;
  const cancellation = new AbortController();
  const deadline = setTimeout(() => cancellation.abort(), 15000);
  try {
    const reply = await fetch(endpoint, { signal: cancellation.signal });
    if (!reply.ok) return null;
    const payload = await reply.json() as { status?: string; geocodes?: Array<{ location: string }> };
    if (payload.status !== "1" || !payload.geocodes || payload.geocodes.length === 0) return null;
    return payload.geocodes[0].location;
  } catch { return null; }
  finally { clearTimeout(deadline); }
}
type PathLeg = { distance: string; duration: string; tolls: string; toll_distance: string; traffic_lights: string };
type TransitLeg = { cost: string; duration: string; walking_distance: string; segments?: Array<{
  walking?: { distance: string; duration: string };
  bus?: { buslines?: Array<{ name: string; depart_stop: { name: string }; arrival_stop: { name: string } }> };
}> };
type RouteReply = { route?: { paths?: PathLeg[]; transits?: TransitLeg[]; taxi_cost?: string }; data?: { paths?: PathLeg[] } };
async function requestRoute(endpoint: string, label: string, present: (payload: RouteReply) => string): Promise<string> {
  const cancellation = new AbortController();
  const deadline = setTimeout(() => cancellation.abort(), 15000);
  try {
    const reply = await fetch(endpoint, { signal: cancellation.signal });
    if (!reply.ok) return `[错误] ${label}路线查询失败：HTTP ${reply.status}`;
    const payload = await reply.json() as RouteReply;
    return present(payload);
  } catch (failure) {
    const detail = failure instanceof Error ? failure.message : String(failure);
    return `[错误] ${label}路线查询失败：` + detail;
  } finally { clearTimeout(deadline); }
}
async function planDriving(origin: string, destination: string, key: string): Promise<string> {
  const endpoint = `https://restapi.amap.com/v3/direction/driving?origin=${origin}&destination=${destination}&extensions=base&strategy=0&key=${key}`;
  return requestRoute(endpoint, "驾车", payload => {
    if (!payload.route?.paths?.length) return "[错误] 未找到驾车路线";
    const leg = payload.route.paths[0];
    const kilometers = (Number(leg.distance) / 1000).toFixed(1);
    const minutes = Math.round(Number(leg.duration) / 60);
    const fee = Number(leg.tolls);
    return [`🚗 驾车路线`, `距离：${kilometers} 公里`, `预计用时：${minutes} 分钟`,
      fee > 0 ? `路费：${fee.toFixed(0)} 元` : `路费：免费`, `红绿灯：${leg.traffic_lights || 0} 个`].join("\n");
  });
}
async function planWalking(origin: string, destination: string, key: string): Promise<string> {
  const endpoint = `https://restapi.amap.com/v3/direction/walking?origin=${origin}&destination=${destination}&key=${key}`;
  return requestRoute(endpoint, "步行", payload => {
    if (!payload.route?.paths?.length) return "[错误] 未找到步行路线";
    const leg = payload.route.paths[0];
    const meters = Number(leg.distance);
    const minutes = Math.round(Number(leg.duration) / 60);
    const distance = meters >= 1000 ? `${(meters / 1000).toFixed(1)} 公里` : `${meters.toFixed(0)} 米`;
    return [`🚶 步行路线`, `距离：${distance}`, `预计用时：${minutes} 分钟`].join("\n");
  });
}
async function planCycling(origin: string, destination: string, key: string): Promise<string> {
  const endpoint = `https://restapi.amap.com/v4/direction/bicycling?origin=${origin}&destination=${destination}&key=${key}`;
  return requestRoute(endpoint, "骑行", payload => {
    if (!payload.data?.paths?.length) return "[错误] 未找到骑行路线";
    const leg = payload.data.paths[0];
    const kilometers = (Number(leg.distance) / 1000).toFixed(1);
    const minutes = Math.round(Number(leg.duration) / 60);
    return [`🚲 骑行路线`, `距离：${kilometers} 公里`, `预计用时：${minutes} 分钟`].join("\n");
  });
}
async function planTransit(origin: string, destination: string, city: string, key: string): Promise<string> {
  const endpoint = `https://restapi.amap.com/v3/direction/transit/integrated?origin=${origin}&destination=${destination}&city=${encodeURIComponent(city)}&strategy=0&extensions=base&key=${key}`;
  return requestRoute(endpoint, "公交", payload => {
    if (!payload.route?.transits?.length) return "[错误] 未找到公交路线";
    const journey = payload.route.transits[0];
    const minutes = Math.round(Number(journey.duration) / 60);
    const fare = Number(journey.cost).toFixed(0);
    const walking = Number(journey.walking_distance);
    const walkingLabel = walking > 0 ? `（步行 ${walking.toFixed(0)} 米）` : "";
    const instructions = journey.segments?.map((segment, position) => {
      if (segment.bus?.buslines?.length) {
        const line = segment.bus.buslines[0];
        return `  ${position + 1}. 乘 ${line.name}：${line.depart_stop.name} → ${line.arrival_stop.name}`;
      }
      if (segment.walking) return `  ${position + 1}. 步行 ${Number(segment.walking.distance).toFixed(0)} 米`;
      return "";
    }).filter(Boolean) || [];
    return [`🚌 公交路线`, `预计用时：${minutes} 分钟`, `票价：${fare} 元${walkingLabel}`,
      payload.route.taxi_cost ? `打车参考价：${payload.route.taxi_cost} 元` : "",
      ...(instructions.length ? [`换乘方案：`, ...instructions] : [])].filter(Boolean).join("\n");
  });
}
async function executePlanTrip(args: Record<string, unknown>): Promise<string> {
  if (tripConfiguration.enabled && !readSetting(tripConfiguration.enabled)) return "[错误] 出行工具未启用，请在设置里开启";
  const key = readSetting(tripConfiguration.key) ?? "";
  if (!key) return "[提示] 高德 API Key 未配置。可在 设置→插件 中找到 🚗出行工具，填入高德 Web 服务 API Key（注册地址：https://lbs.amap.com）。";
  const start = String(args.origin ?? "").trim();
  const end = String(args.destination ?? "").trim();
  if (!start || !end) return "[错误] 请提供起点和终点";
  const travelMode = String(args.mode ?? "驾车").trim();
  const coordinates = await Promise.all([geocode(start, key), geocode(end, key)]);
  if (!coordinates[0]) return `[错误] 无法解析起点「${start}」的位置，请尝试更具体的名称`;
  if (!coordinates[1]) return `[错误] 无法解析终点「${end}」的位置，请尝试更具体的名称`;
  console.log("[TravelTools]", `规划路线：「${start}」→「${end}」, 方式=${travelMode}`);
  if (["驾车", "开车"].includes(travelMode)) return planDriving(coordinates[0], coordinates[1], key);
  if (["步行", "走路"].includes(travelMode)) return planWalking(coordinates[0], coordinates[1], key);
  if (["骑行", "骑车", "自行车"].includes(travelMode)) return planCycling(coordinates[0], coordinates[1], key);
  if (["公交", "公共交通", "地铁", "公交地铁"].includes(travelMode)) {
    const municipality = String(args.city ?? "").trim();
    if (!municipality) return "[错误] 公交路线必须提供城市（参数 city），例如 city='北京'";
    return planTransit(coordinates[0], coordinates[1], municipality, key);
  }
  return `[错误] 不支持的出行方式「${travelMode}」。支持：驾车、步行、骑行、公交`;
}
export function registerTravelTools(): void {
  const HANDLER_plan_trip = executePlanTrip;
  toolRegistry.register({
  "id": "plan_trip",
  "name": "🚗出行工具",
  "description": "路线规划，查驾车/步行/骑行/公交的路线、距离和预计时间。\n\n何时用：\n- 用户问「从 A 到 B 怎么走」「去 X 怎么坐车」「到 Y 多远」\n- 用户想知道驾车/公交/骑行/步行的路线和耗时\n- 用户问「打车要多少钱」「骑自行车去 X 多久」\n\n不要用于：\n- 查天气（用 weather 工具）\n- 查具体公交线路信息或时刻表（不支持）\n- 查路况（不支持）\n\n参数：\n- origin（必填）：起点，如「故宫」「北京市天安门」\n- destination（必填）：终点\n- mode（可选，默认驾车）：出行方式——驾车/开车、步行/走路、骑行/骑车/自行车、公交/公共交通/地铁\n- city（公交必填）：城市名，如「北京」「上海」。仅公交模式需要",
  "enabled": true,
  "risk": "network",
  "modes": [
    "work"
  ],
  "inputSchema": {
    "type": "object",
    "properties": {
      "origin": {
        "type": "string",
        "description": "起点，如「故宫」「北京市天安门」"
      },
      "destination": {
        "type": "string",
        "description": "终点"
      },
      "mode": {
        "type": "string",
        "description": "出行方式：驾车/开车、步行/走路、骑行/骑车/自行车、公交/公共交通/地铁（默认驾车）"
      },
      "city": {
        "type": "string",
        "description": "城市名，如「北京」「上海」，公交模式必填"
      }
    },
    "required": [
      "origin",
      "destination"
    ]
  }
, execute: HANDLER_plan_trip });
  logger.info(LogTag.TravelTools, "registered: plan_trip");
}
