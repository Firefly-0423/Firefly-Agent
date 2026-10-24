import path from "node:path";
import type { CDNMedia } from "./ilink-protocol-client";

type InboundItemType = 1 | 2 | 3 | 4 | 5;
type NamedMedia = { media?: unknown; name?: unknown; file_name?: unknown };
export type InboundWechatItem = {
  video_item?: NamedMedia;
  file_item?: NamedMedia;
  voice_item?: NamedMedia & { sample_rate?: unknown };
  image_item?: NamedMedia;
  type: InboundItemType;
};
export type InboundMediaKind = "image" | "voice" | "file" | "video";
export type InboundMediaDescriptor = {
  sampleRate?: number;
  media?: CDNMedia;
  analyzable: boolean;
  extension: string;
  fileName: string;
  kind: InboundMediaKind;
};
export const SAVE_INTENT_TTL_MS = 5 * 60 * 1000;
const readableSuffixes = new Set([
  ".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".yaml", ".yml", ".pdf", ".docx", ".xlsx",
  ".js", ".ts", ".tsx", ".jsx", ".py", ".java", ".go", ".rs", ".cpp", ".c", ".h", ".cs",
  ".html", ".css", ".xml", ".toml", ".ini", ".env", ".log",
]);
const pictureSuffixes = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

export function getWechatDisplayName(callPreference: unknown): string {
  return (typeof callPreference === "string" ? callPreference.trim() : "") || "伙伴";
}
export function getFileExtension(fileName: string): string { return path.extname(fileName).toLowerCase(); }
export function isAnalyzableWechatFile(fileName: string): boolean {
  const suffix = getFileExtension(fileName);
  return readableSuffixes.has(suffix) || pictureSuffixes.has(suffix);
}
export function isWechatSaveIntent(text: string): boolean {
  const compact = text.trim().replace(/\s+/g, "");
  return !!compact && /保存到桌面|存到桌面|放到桌面|代收|帮我收|帮我保存|保存文件|收一下/.test(compact);
}

function fileLabel(candidate: unknown, defaultLabel: string): string {
  if (typeof candidate !== "string") return defaultLabel;
  const stripped = candidate.trim();
  return stripped ? path.basename(stripped) : defaultLabel;
}
function cdnDescriptor(candidate: unknown): CDNMedia | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const descriptor = candidate as Partial<CDNMedia>;
  if (typeof descriptor.encrypt_query_param !== "string" || typeof descriptor.aes_key !== "string") return undefined;
  return { encrypt_query_param: descriptor.encrypt_query_param, aes_key: descriptor.aes_key, encrypt_type: descriptor.encrypt_type, full_url: descriptor.full_url };
}

export function describeInboundWechatMedia(items: InboundWechatItem[]): InboundMediaDescriptor[] {
  const descriptions: InboundMediaDescriptor[] = [];
  for (const incoming of items) {
    let source: NamedMedia;
    let category: InboundMediaKind;
    let fallback: string;
    if (incoming.type === 2 && incoming.image_item) {
      source = incoming.image_item; category = "image"; fallback = "微信图片";
    } else if (incoming.type === 3 && incoming.voice_item) {
      source = incoming.voice_item; category = "voice"; fallback = "微信语音";
    } else if (incoming.type === 4 && incoming.file_item) {
      source = incoming.file_item; category = "file"; fallback = "微信文件";
    } else if (incoming.type === 5 && incoming.video_item) {
      source = incoming.video_item; category = "video"; fallback = "微信视频";
    } else continue;
    const filename = fileLabel(source.file_name ?? source.name, fallback);
    const description: InboundMediaDescriptor = {
      kind: category,
      fileName: filename,
      extension: getFileExtension(filename),
      analyzable: category === "image" ? true : category === "file" ? isAnalyzableWechatFile(filename) : false,
      media: cdnDescriptor(source.media),
    };
    if (category === "voice") {
      description.sampleRate = typeof incoming.voice_item!.sample_rate === "number" ? incoming.voice_item!.sample_rate : undefined;
    }
    descriptions.push(description);
  }
  return descriptions;
}
export function buildUnsupportedWechatFilePrompt(username: string): string {
  return username + "，这个文件我暂时无法分析。如果你想让我代收，请在 5 分钟内回复“保存到桌面”。";
}
export function buildWechatVideoPrompt(username: string): string {
  return username + "，视频我暂时还看不了。如果你想让我代收，请在 5 分钟内回复“保存到桌面”。";
}
export function buildWechatSaveIntentPrompt(username: string): string {
  return "嗯，" + username + "，请把文件发过来。我会帮你放到桌面的“Firefly 收件箱”。";
}
export function buildWechatSaveSuccessPrompt(username: string, filePath: string): string {
  return username + "，文件已保存到桌面的“Firefly 收件箱”：" + filePath;
}
export function buildWechatAsrMissingPrompt(username: string): string {
  return username + "，我还没有配置语音识别，暂时听不懂这条语音。可以发文字给我。";
}
export function buildWechatAsrFailedPrompt(username: string, reason: string): string {
  return username + "，这条语音我暂时没听清楚：" + reason + "。可以换成文字再发我一次。";
}
