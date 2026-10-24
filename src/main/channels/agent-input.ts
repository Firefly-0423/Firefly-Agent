import path from "node:path";
import type { AguiRunInput } from "../agui-bridge";
import type { IncomingMessage } from "./types";

type AttachmentInputs = Pick<AguiRunInput, "attachments" | "imageAttachments">;
export type ChannelAttachmentInputOptions = {
  captionImage?: (filePath: string) => Promise<{ ok: boolean; caption?: string; error?: string }>;
  imageMode?: "direct" | "caption";
};

function channelName(channel: IncomingMessage["channel"]): string {
  const names = { wechat: "微信", feishu: "飞书", qq: "QQ", qqbot: "QQ 机器人" };
  return Object.hasOwn(names, channel) ? names[channel] : channel;
}
export async function buildChannelAttachmentInputs(msg: IncomingMessage, options: ChannelAttachmentInputOptions = {}): Promise<AttachmentInputs> {
  const documents: NonNullable<AguiRunInput["attachments"]> = [];
  const pictures: NonNullable<AguiRunInput["imageAttachments"]> = [];
  const routing = options.imageMode ?? "direct";
  for (const media of msg.attachments ?? []) {
    if (!media.filePath) continue;
    const filename = media.caption || path.basename(media.filePath);
    if (media.kind === "image") {
      if (routing === "direct") {
        pictures.push({ name: filename, filePath: media.filePath, mime: media.mime });
        continue;
      }
      const description = options.captionImage
        ? await options.captionImage(media.filePath)
        : { ok: false, error: "未配置视觉模型，无法分析图片" };
      const detail = description.ok && description.caption ? description.caption
        : `图片分析失败：${description.error || "图片分析失败"}。请诚实说明暂时无法看清这张图。`;
      documents.push({ name: filename, text: `【图片视觉信息】\n用户通过${channelName(msg.channel)}发送了图片：${filename}\n${detail}` });
      continue;
    }
    if (media.kind === "file" || media.kind === "audio" || media.kind === "video") {
      const category = media.kind === "audio" ? "语音" : media.kind === "video" ? "视频" : "文件";
      documents.push({ name: filename, text: `用户通过${channelName(msg.channel)}发送了${category}：${media.filePath}` });
    }
  }
  return {
    attachments: documents.length > 0 ? documents : undefined,
    imageAttachments: pictures.length > 0 ? pictures : undefined,
  };
}
