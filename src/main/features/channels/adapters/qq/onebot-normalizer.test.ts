import { it, expect, vi } from "vitest";
import { normalizeOneBotMessage, messageMentionsSelf } from "./onebot-normalizer";
import type { OneBotMessageEvent } from "./onebot-types";
import type { OneBotActionClient } from "./onebot-action-client";
import type { OneBotMediaManager } from "./onebot-media";

function event(): OneBotMessageEvent {
  return { time: 1_750_000_000, self_id: "16180", post_type: "message", message_type: "group",
    message_id: "review-42", user_id: "31415", group_id: "27182",
    sender: { user_id: "31415", nickname: "Mira", card: "Review lead" }, message: [] };
}

it("preserves ordered text, resolves a quote and removes the initial self mention", async () => {
  const incoming = event();
  incoming.message = [
    { type: "at", data: { qq: "16180" } }, { type: "text", data: { text: "Please inspect" } },
    { type: "at", data: { qq: "57721" } }, { type: "text", data: { text: "chart" } },
    { type: "reply", data: { id: "quoted-review" } }, { type: "image", data: { file: "chart-resource" } },
  ];
  const call = vi.fn(async (action: string) => action === "get_msg"
    ? { sender: { user_id: "14142", nickname: "Previous reviewer" }, message: [{ type: "text", data: { text: "Earlier findings" } }] }
    : { card: "Chart owner" });
  const downloadSegment = vi.fn(async () => ({ kind: "image", filePath: "D:/cache/chart.png", mime: "image/png" }));
  const result = await normalizeOneBotMessage(incoming, {
    selfId: "16180", client: { call } as unknown as OneBotActionClient,
    media: { downloadSegment } as unknown as OneBotMediaManager, supportsStream: true,
  });
  expect(messageMentionsSelf(incoming, "16180")).toEqual(true);
  expect(result).toMatchObject({
    channel: "qq", senderId: "31415", senderName: "Review lead", chatType: "group", chatId: "27182", messageId: "review-42",
    reply: { senderId: "14142", senderName: "Previous reviewer", messageId: "quoted-review", text: "Earlier findings" },
  });
  expect(result.text).toEqual("Please inspect @Chart owner chart[image]");
  expect(result.attachments).toHaveLength(1);
});

it("uses explicit placeholders for unsupported location and forwarded segments", async () => {
  const incoming = { ...event(), message_type: "private" as const, message: [
    { type: "text", data: { text: "Context follows:" } }, { type: "location", data: { lat: "48.8", lng: "2.3" } },
    { type: "forward", data: { id: "forwarded-review" } },
  ] };
  const result = await normalizeOneBotMessage(incoming, {
    selfId: "16180", client: { call: vi.fn() } as unknown as OneBotActionClient,
    media: { downloadSegment: vi.fn() } as unknown as OneBotMediaManager, supportsStream: true,
  });
  expect(result.text).toEqual("Context follows:[未支持的消息类型:location][未支持的消息类型:forward]");
});
