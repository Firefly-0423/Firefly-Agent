import type { IncomingMessage } from "./channel-types";

/** 渠道消息进入对话时的文本形式：群聊带上发送者和引用。 */
export function formatChannelUserText(msg: IncomingMessage): string {
  if (msg.chatType !== "group") return msg.text;
  const author = msg.senderName ? `${msg.senderName} (${msg.senderId})` : msg.senderId;
  const quotation = msg.reply?.text ? `\n引用 ${msg.reply.senderName || msg.reply.senderId || "未知用户"}：${msg.reply.text}` : "";
  return `[群聊发送者：${author}]${quotation}\n${msg.text}`;
}
