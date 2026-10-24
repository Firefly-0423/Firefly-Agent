import { app } from "electron";
import * as os from "os";
import { listMcpServers } from "./mcp-manager";
import { ACCESS_LEVEL_LABEL, getCurrentLevel } from "../permission";
import { resolveChatContextTimezone } from "../chat/chat-time-context";
import { getDateLocale } from "../locale-context";
import { resolveUserAddress } from "../../shared/user-address";

export interface ModelInfo { multimodal?: boolean; model: string; provider: string }
export interface UserInfoContext { gender?: string; timezone?: string; defaultCity?: string; birthday?: string; callPreference?: string; nickname?: string }

function safeGetPath(name: "desktop" | "documents" | "downloads" | "home"): string {
  try { return app.getPath(name); }
  catch (failure) { console.warn("[Env]", "getPath 失败:", name, failure); return ""; }
}
const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
function formatDate(d: Date, tz: string): string {
  let fields: Intl.DateTimeFormatPart[];
  try {
    fields = new Intl.DateTimeFormat(getDateLocale(), {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(d);
  } catch (failure) {
    console.warn("[Env]", "formatToParts 失败，回退系统本地时间:", failure);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const weekday = weekdays[d.getDay()];
    const hour = String(d.getHours()).padStart(2, "0");
    const minute = String(d.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day} ${weekday} ${hour}:${minute}`;
  }
  const field = (kind: Intl.DateTimeFormatPartTypes): string => fields.find((part) => part.type === kind)?.value ?? "";
  const year = field("year"), month = field("month"), day = field("day");
  const localizedWeekday = field("weekday");
  const weekday = localizedWeekday && /[周星期]/.test(localizedWeekday) ? localizedWeekday : weekdays[d.getDay()];
  const hour = field("hour"), minute = field("minute");
  return `${year}-${month}-${day} ${weekday} ${hour}:${minute}`;
}
function platformLabel(): string {
  const platform = process.platform;
  switch (platform) {
    case "win32": return `Windows (${os.release()})`;
    case "darwin": return `macOS (${os.release()})`;
    case "linux": return `Linux (${os.release()})`;
    default: return `${platform} (${os.release()})`;
  }
}

export function buildEnvironmentContext(modelInfo?: ModelInfo, userInfo?: UserInfoContext): string {
  const access = getCurrentLevel();
  const accessLabel = ACCESS_LEVEL_LABEL[access];
  const desktopPath = safeGetPath("desktop");
  const documentPath = safeGetPath("documents");
  const downloadPath = safeGetPath("downloads");
  const homePath = safeGetPath("home");
  const userName = os.userInfo().username;
  const timezone = resolveChatContextTimezone(userInfo?.timezone);
  const timestamp = formatDate(new Date(), timezone);
  let serverSummary = "未连接任何 MCP server";
  try {
    const available = listMcpServers();
    if (available.length > 0) serverSummary = available.map((server) => `${server.name}[${server.connected ? "已连接" : "未连接"}, ${server.toolCount} 工具]`).join(", ");
  } catch (failure) { console.warn("[Env]", "列 MCP server 失败:", failure); }

  const sections: string[] = ["## 运行环境（机器实际状态，不要再凭印象猜）", "", `- 当前时间：${timestamp}（时区 ${timezone}）`, `- 操作系统：${platformLabel()}`, `- 当前用户名：${userName}`];
  if (homePath) sections.push(`- 用户主目录：${homePath}`);
  if (desktopPath) sections.push(`- 桌面路径：${desktopPath}`);
  if (documentPath) sections.push(`- 文档路径：${documentPath}`);
  if (downloadPath) sections.push(`- 下载路径：${downloadPath}`);
  sections.push("", `- 文件权限档位：${accessLabel}（${access}）`, "- 工具能否调用以本轮提供的工具清单为准；fs-write / shell 等高风险操作可能触发审批确认。", `- MCP 服务：${serverSummary}`, "");
  const vision = modelInfo?.multimodal === true;
  sections.push(`- 当前模型是否支持查看图片：${vision ? "支持（可调 read_image 看图）" : "不支持（看不了图片，遇到图片问题必须如实说明，不许编造图片内容）"}`, "");
  if (userInfo) {
    sections.push("## 用户信息", "");
    if (userInfo.callPreference?.trim()) sections.push(`- 称呼偏好：${userInfo.callPreference.trim()}（称呼用户时优先用这个）`);
    else if (userInfo.nickname?.trim()) sections.push(`- 昵称：${userInfo.nickname.trim()}（称呼用户时用这个）`);
    if (userInfo.birthday) sections.push(`- 生日：${userInfo.birthday}`);
    if (userInfo.defaultCity) sections.push(`- 默认城市：${userInfo.defaultCity}（用户问天气/位置且没指定其他城市时，默认用这个）`);
    if (userInfo.gender === "male") sections.push("- 性别：男");
    else if (userInfo.gender === "female") sections.push("- 性别：女");
    const address = resolveUserAddress(userInfo);
    sections.push(`- 称呼使用：在重要提问或确认时，可以自然使用一次「${address}」；不要每句话重复称呼。`);
    switch (userInfo.gender) {
      case "male": sections.push("- 性别约束：不得使用女性指向称呼；性别只用于防止误称，不要求主动提及。"); break;
      case "female": sections.push("- 性别约束：不得使用男性指向称呼；性别只用于防止误称，不要求主动提及。"); break;
      default: sections.push("- 性别约束：性别未知或保密时只使用中性称呼，不得根据昵称、头像或语气推断。");
    }
    sections.push("", "> 用户时区仅用于时间计算，不代表用户所在地，不得根据时区推断用户所在城市。默认城市仅用于天气等需要定位的工具。", "");
  }
  sections.push("当用户提到「桌面 / 文档 / 下载」却没给绝对路径时，使用上面这些真实路径拼接，再交给文件类工具；不要写 `~/Desktop` 或硬编码盘符。");
  const context = sections.join("\n");
  console.log("[Env]", `level=${access}`, `desktop=${desktopPath || "?"}`, `mcp=${serverSummary.startsWith("未连接") ? "none" : "active"}`, `vision=${vision}`);
  return context;
}
