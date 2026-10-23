import type { IncomingMessage, ChannelMention, ChannelReplyContext } from "../../types";
import { OneBotActionClient } from "./onebot-action-client";
import { OneBotMediaManager } from "./onebot-media";
import type { OneBotMessageEvent, OneBotSegment } from "./onebot-types";
import { oneBotId } from "./onebot-types";

const memberLabels = new Map<string, { expiresAt: number; name: string }>();
function textFromSegments(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const words = value.map((part) => {
    if (!part || typeof part !== "object") return "";
    const fragment = part as OneBotSegment;
    switch (fragment.type) {
      case "text": return String(fragment.data?.text ?? "");
      case "markdown": return String(fragment.data?.markdown ?? fragment.data?.content ?? "");
      default: return "";
    }
  });
  return words.join("").trim();
}
async function resolveMemberName(connection: OneBotActionClient, room: string, person: string): Promise<string | undefined> {
  const identifier = `${room}:${person}`;
  const saved = memberLabels.get(identifier);
  if (saved && saved.expiresAt > Date.now()) return saved.name;
  try {
    const profile = await connection.call<Record<string, unknown>>("get_group_member_info", { group_id: room, user_id: person, no_cache: false });
    const label = String(profile.card || profile.nickname || "").trim();
    if (label) memberLabels.set(identifier, { name: label, expiresAt: Date.now() + 5 * 60_000 });
    return label || undefined;
  } catch { return undefined; }
}
async function resolveReply(connection: OneBotActionClient, fragment: OneBotSegment): Promise<ChannelReplyContext> {
  const identifier = oneBotId(fragment.data.id);
  if (!identifier) return { messageId: "" };
  try {
    const quoted = await connection.call<Record<string, unknown>>("get_msg", { message_id: identifier });
    const author = quoted.sender && typeof quoted.sender === "object" ? quoted.sender as Record<string, unknown> : {};
    return { messageId: identifier, senderId: oneBotId(author.user_id), senderName: String(author.card || author.nickname || "").trim() || undefined, text: textFromSegments(quoted.message) };
  } catch { return { messageId: identifier }; }
}
export function messageMentionsSelf(event: OneBotMessageEvent, selfId: string): boolean {
  return event.message.some((fragment) => fragment.type === "at" && oneBotId(fragment.data.qq) === selfId);
}
export async function normalizeOneBotMessage(
  event: OneBotMessageEvent,
  context: { selfId: string; client: OneBotActionClient; media: OneBotMediaManager; supportsStream: boolean },
): Promise<IncomingMessage> {
  const person = oneBotId(event.user_id);
  const room = oneBotId(event.group_id);
  const label = String(event.sender?.card || event.sender?.nickname || "").trim() || undefined;
  const addressed: ChannelMention[] = [];
  const media: NonNullable<IncomingMessage["attachments"]> = [];
  const words: string[] = [];
  let quoted: ChannelReplyContext | undefined;
  let removedSelf = false;
  for (const fragment of event.message) {
    if (!fragment || typeof fragment !== "object") continue;
    switch (fragment.type) {
      case "text": words.push(String(fragment.data.text ?? "")); break;
      case "markdown": words.push(String(fragment.data.markdown ?? fragment.data.content ?? "")); break;
      case "at": {
        const identifier = oneBotId(fragment.data.qq);
        const self = identifier === context.selfId;
        const display = room && identifier && identifier !== "all" ? await resolveMemberName(context.client, room, identifier)
          : identifier === "all" ? "全体成员" : undefined;
        addressed.push({ userId: identifier, name: display, isBot: self });
        if (self && !removedSelf) removedSelf = true;
        else words.push(` @${display || identifier} `);
        break;
      }
      case "reply": if (!quoted) quoted = await resolveReply(context.client, fragment); break;
      case "image": case "mface": case "record": case "file": case "video":
        try {
          media.push(await context.media.downloadSegment(fragment, context.supportsStream));
          words.push(`[${fragment.type === "record" ? "语音" : fragment.type === "mface" ? "图片表情" : fragment.type}]`);
        } catch (failure) {
          const reason = failure instanceof Error ? failure.message : String(failure);
          words.push(`[附件处理失败：${reason}]`);
        }
        break;
      case "face": words.push(`[QQ表情:${String(fragment.data.id ?? "")}]`); break;
      case "json": words.push("[JSON卡片]"); break;
      default: words.push(`[未支持的消息类型:${fragment.type}]`);
    }
  }
  const messageText = words.join("").trim() || String(event.raw_message ?? "").trim() || "[空消息]";
  return {
    channel: "qq", chatType: event.message_type, messageId: oneBotId(event.message_id), senderId: person,
    senderName: label, chatId: event.message_type === "group" ? room : person, text: messageText,
    attachments: media.length > 0 ? media : undefined, mentions: addressed.length > 0 ? addressed : undefined,
    reply: quoted, at: new Date((Number(event.time) || Math.floor(Date.now() / 1000)) * 1000), _raw: event,
  };
}
