import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { resolveLocalStickerPath } from "../stickers/sticker-protocol";
import { getStickersDir, loadUserStickerManifest } from "../stickers/sticker-storage";
import { BUILT_IN_STICKER_FILES } from "../stickers/sticker-descriptions";
import { BUILT_IN_STICKER_IDS } from "../../shared/sticker-types";
import type { ChannelCapability, IncomingMessage, OutgoingMessage, OutgoingPart } from "./types";

export type ComposeOutgoingInput = { settings: { stickerEnabled: boolean }; capability?: ChannelCapability; sticker: string | null; replyText: string; incoming: IncomingMessage };
export type PreparedOutgoing = { transientFiles: string[]; stickerId?: string; assistantText: string; message: OutgoingMessage };
export interface OutgoingComposer {
  cleanupTransientFiles(files: readonly string[]): Promise<void>;
  compose(input: ComposeOutgoingInput): Promise<PreparedOutgoing>;
}
export type CreateOutgoingComposerOptions = { resolveStickerImagePath?: (stickerId: string) => string | null; removeFile?: (filePath: string) => Promise<void> };
export function buildTextOutgoingParts(replyText: string): OutgoingPart[] { return [{ kind: "text", text: replyText }]; }
export function downgradeToCapability(message: OutgoingMessage, capability: ChannelCapability | undefined): OutgoingMessage {
  if (!capability) return message;
  const converted: OutgoingPart[] = [];
  for (const fragment of message.parts) {
    switch (fragment.kind) {
      case "text":
        converted.push(capability.maxTextLength > 0 && fragment.text.length > capability.maxTextLength
          ? { kind: "text", text: fragment.text.slice(0, Math.max(0, capability.maxTextLength - 20)) + "\n...(过长已截断)" } : fragment);
        break;
      case "image": converted.push(capability.image ? fragment : { kind: "text", text: `[图片] ${fragment.caption ?? fragment.url ?? fragment.filePath ?? ""}` }); break;
      case "audio": converted.push(capability.audio ? fragment : { kind: "text", text: `[语音消息 ${fragment.mime}, 见桌面端]` }); break;
      case "file": converted.push(capability.file ? fragment : { kind: "text", text: `[文件] ${fragment.name ?? fragment.filePath}` }); break;
      case "video": converted.push(capability.video ? fragment : { kind: "text", text: `[视频] ${fragment.name ?? fragment.filePath}` }); break;
      case "card": {
        if (capability.card) { converted.push(fragment); break; }
        const paragraphs = [fragment.title];
        if (fragment.markdown) paragraphs.push(fragment.markdown);
        if (fragment.fields && fragment.fields.length > 0) paragraphs.push(...fragment.fields.map((entry) => `${entry.key}: ${entry.value}`));
        converted.push({ kind: "text", text: paragraphs.join("\n") });
        break;
      }
      case "sticker": if (capability.sticker) converted.push(fragment); break;
      default: converted.push(fragment);
    }
  }
  return { ...message, parts: converted };
}
export function resolveStickerImagePath(stickerId: string): string | null {
  if (!stickerId) return null;
  const entries = loadUserStickerManifest();
  const custom = entries[stickerId];
  if (custom) return resolveLocalStickerPath(getStickersDir(), custom.file);
  if (!(BUILT_IN_STICKER_IDS as readonly string[]).includes(stickerId)) return null;
  const filename = BUILT_IN_STICKER_FILES[stickerId];
  if (!filename) return null;
  const root = app.getAppPath();
  const locations = [path.join(root, "dist", "renderer", "stickers", filename), path.join(root, "src", "renderer", "public", "stickers", filename)];
  for (const location of locations) if (fs.existsSync(location)) return location;
  return null;
}
export function createOutgoingComposer(options: CreateOutgoingComposerOptions = {}): OutgoingComposer {
  const findSticker = options.resolveStickerImagePath ?? resolveStickerImagePath;
  const erase = options.removeFile ?? (async (filename: string) => { await fs.promises.rm(filename, { force: true }); });
  const cleanup = async (files: readonly string[]): Promise<void> => {
    for (const filename of files) {
      try { await erase(filename); }
      catch (failure) { console.warn("[OutgoingComposer]", `清理临时文件失败: ${filename}`, failure); }
    }
  };
  return {
    async compose(input) {
      const temporary: string[] = [];
      const fragments = buildTextOutgoingParts(input.replyText);
      let stickerId: string | undefined;
      if (input.sticker && input.settings.stickerEnabled) {
        try {
          const image = findSticker(input.sticker);
          if (image) { fragments.push({ kind: "sticker", stickerId: input.sticker, imagePath: image }); stickerId = input.sticker; }
        } catch (failure) { console.warn("[OutgoingComposer]", `表情包解析失败，已跳过: ${input.sticker}`, failure); }
      }
      const outgoing = downgradeToCapability({
        channel: input.incoming.channel, chatType: input.incoming.chatType ?? "private", targetId: input.incoming.chatId, threadId: input.incoming.threadId,
        ...(input.incoming.chatType === "group" && input.incoming.messageId ? { replyContext: { messageId: input.incoming.messageId, mentionUserId: input.incoming.senderId } } : {}), parts: fragments,
      }, input.capability);
      return { message: outgoing, assistantText: input.replyText,
        ...(stickerId && input.capability?.sticker !== false ? { stickerId } : {}), transientFiles: temporary };
    },
    cleanupTransientFiles: cleanup,
  };
}
