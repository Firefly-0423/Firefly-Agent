import type { ToolContext } from "../registry/tool-context";
import type { ToolDefinition } from "../registry/tool-registry";
import { TtlResultCache } from "./ttl-result-cache";

const CAPTION_CACHE_TTL_MS = 30 * 60_000;
const captionCache = new TtlResultCache<string>(CAPTION_CACHE_TTL_MS);
const LOG_PREFIX = "[BuiltinTools]";

export function clearImageCaptionCache(): void { captionCache.clear(); }

async function loadCaptionVisionConfigLazy(): Promise<import("../../image-router").CaptionVisionConfig> {
  const profiles = await import("../../../settings/model-settings");
  const active = profiles.resolveModelSettingsProfile(profiles.loadModelSettings());
  const routes = await import("../../image-router");
  return routes.resolveCaptionVisionConfig(active);
}

async function executeReadImageUrl(input: Record<string, unknown>, context?: ToolContext): Promise<string> {
  const address = String(input.url || "").trim();
  if (!/^https?:\/\//i.test(address)) return "[错误] url 必须以 http:// 或 https:// 开头";
  const question = context?.userQuery ?? "";
  const identity = address + "||" + question;
  const cached = captionCache.get(identity);
  if (cached) {
    const date = new Date(cached.at).toLocaleString("zh-CN", { hour12: false });
    return "[缓存] 此描述生成于 " + date + "，30 分钟内复用\n\n" + cached.value;
  }
  const vision = await loadCaptionVisionConfigLazy();
  if (!vision.ok) return "[错误·配置] " + vision.error;
  console.log(LOG_PREFIX, "read_image_url:", address);
  const captioner = await import("../../vision-captioner");
  const description = await captioner.captionImage({ url: address }, question, vision.config);
  if (!description.startsWith("[错误")) captionCache.set(identity, description);
  return description;
}

export const readImageUrlTool: ToolDefinition = {
  "id": "read_image_url",
  "name": "读取网络图片",
  "description": "把公网图片 URL 交给视觉模型分析，返回文字描述。图片由模型厂商服务器直接拉取，本机不下载，适合快速看一眼网上的图。\n\n何时用：\n- 对话/网页里出现图片 URL，用户问'这图里是什么'\n- web_search 或 fetch_url 拿到图片链接，想看内容\n\n不要用于：\n- 本地图片文件 → read_image\n- 用户想把图片保存到本地 → download_file\n- 厂商拉不到的 URL（内网/失效/防盗链会报错，此时可用 download_file 下载后再 read_image）\n\n若未配置视觉模型会返回错误，届时如实告诉用户看不了。参数：url (必填，完整 http(s) 图片地址)。",
  "enabled": true,
  "risk": "network",
  "modes": [
    "code",
    "work"
  ],
  "effectKind": "read",
  "verificationPolicy": "none",
  "needsContext": true,
  "inputSchema": {
    "type": "object",
    "properties": {
      "url": {
        "type": "string",
        "description": "要分析的图片完整 URL（必须包含 https:// 或 http://）"
      }
    },
    "required": [
      "url"
    ]
  },
  execute: executeReadImageUrl,
};
