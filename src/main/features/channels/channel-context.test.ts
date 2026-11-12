import { expect, it, vi } from "vitest";
import { createChannelContext, formatChannelUserText, makeSessionId, lookupOriginalSender } from "./channel-context";
import type { IncomingMessage } from "./types";

function envelope(extra: Partial<IncomingMessage> = {}): IncomingMessage {
  return { channel: "qq", chatType: "private", senderId: "speaker-14", senderName: "Mira", chatId: "room-82", text: "Schedule a review", at: new Date(1200), ...extra };
}

it("creates stable anonymous identifiers scoped to channel and chat", () => {
  const id = makeSessionId("feishu", "ou_contract_82");
  expect(id).toEqual(makeSessionId("feishu", "ou_contract_82"));
  expect(id).toMatch(/^channel:feishu:[0-9a-f]{16}$/);
  expect(id).not.toBe(makeSessionId("wechat", "ou_contract_82"));
  expect(makeSessionId("qq", "room-82")).not.toBe(makeSessionId("qq", "room-83"));
  expect(lookupOriginalSender("channel:feishu:ffffffffffffffff")).toBeNull();
});

it("formats a group author and quoted message as model context", () => {
  expect(formatChannelUserText(envelope({
    chatType: "group", senderId: "speaker-14", senderName: "Mira", text: "Please continue",
    reply: { messageId: "quoted-8", senderId: "speaker-15", senderName: "Noah", text: "The draft is ready" },
  }))).toEqual("[群聊发送者：Mira (speaker-14)]\n引用 Noah：The draft is ready\nPlease continue");
});

it("migrates the Feishu private sender key and registers a reverse lookup", () => {
  const migrateHistory = vi.fn();
  const context = createChannelContext({ migrateHistory, appendChannelHistory: vi.fn() });
  const message = envelope({ channel: "feishu", senderId: "ou_contract_sender", chatId: "oc_contract_chat" });
  const sessionId = makeSessionId(message.channel, message.chatId);
  context.recordIncomingSession(message, { sessionId, boundConversationId: null });
  expect(migrateHistory).toHaveBeenCalledWith(makeSessionId("feishu", "ou_contract_sender"), sessionId);
  expect(lookupOriginalSender(sessionId)).toStrictEqual({ channel: "feishu", senderId: "ou_contract_sender" });
});

it("falls back to channel history when the bound conversation cannot be read", async () => {
  const fallback = [{ role: "user" as const, content: "Channel context remains available" }];
  const context = createChannelContext({
    migrateHistory: vi.fn(), appendChannelHistory: vi.fn(),
    loadBoundConversationHistory: async () => { throw new Error("conversation removed"); },
    loadRecentChannelHistory: async () => fallback,
  });
  expect(await context.resolvePriorMessages({ sessionId: "external-contract", boundConversationId: "desktop-contract" }, 16))
    .toStrictEqual(fallback);
});

it("loads the binding captured at dispatch time without resolving it again", async () => {
  const resolveBoundConversationId = vi.fn(() => "desktop-stable");
  const loadBoundConversationHistory = vi.fn(async () => [{ role: "assistant" as const, content: "Desktop context" }]);
  const context = createChannelContext({ resolveBoundConversationId, loadBoundConversationHistory, migrateHistory: vi.fn(), appendChannelHistory: vi.fn() });
  const dispatch = context.resolveDispatchContext("external-stable");
  await context.resolvePriorMessages(dispatch, 16);
  expect(resolveBoundConversationId).toHaveBeenCalledTimes(1);
  expect(loadBoundConversationHistory).toHaveBeenCalledWith("desktop-stable", 16);
});

it("stores group model context in channel history and mirrors the raw text with metadata", async () => {
  const appendChannelHistory = vi.fn();
  const appendBoundConversationMessage = vi.fn();
  const context = createChannelContext({ appendChannelHistory, appendBoundConversationMessage, migrateHistory: vi.fn() });
  const message = envelope({ chatType: "group", text: "Review begins now" });
  const dispatch = { sessionId: makeSessionId("qq", message.chatId), boundConversationId: "desktop-review" };
  await context.appendIncomingContext(message, dispatch);
  expect(appendChannelHistory).toHaveBeenCalledWith(dispatch.sessionId, "user", "[群聊发送者：Mira (speaker-14)]\nReview begins now");
  expect(appendBoundConversationMessage).toHaveBeenCalledWith("desktop-review", "user", "Review begins now", {
    senderName: "Mira", chatType: "group", channel: "qq", modelContext: "[群聊发送者：Mira (speaker-14)]\nReview begins now",
  });
});

it("commits delivered assistant text and its sticker to both histories", async () => {
  const appendChannelHistory = vi.fn();
  const appendBoundConversationMessage = vi.fn();
  const context = createChannelContext({ appendChannelHistory, appendBoundConversationMessage, migrateHistory: vi.fn() });
  const message = envelope({ channel: "wechat" });
  const dispatch = { sessionId: makeSessionId("wechat", message.chatId), boundConversationId: "desktop-review" };
  await context.appendAssistantContext(message, dispatch, {
    message: { channel: "wechat", targetId: message.chatId, parts: [{ kind: "text", text: "Acknowledged" }] },
    assistantText: "Acknowledged", stickerId: "HAPPY", transientFiles: [],
  });
  expect(appendChannelHistory).toHaveBeenCalledWith(dispatch.sessionId, "assistant", "Acknowledged");
  expect(appendBoundConversationMessage).toHaveBeenCalledWith("desktop-review", "assistant", "Acknowledged", {
    channel: "wechat", chatType: "private", senderName: "Mira", modelContext: undefined, sticker: "HAPPY",
  });
});

it.each(["feishu", "wechat", "qqbot", "qq"] as const)("isolates a new %s group from the participant's private transcript", async channel => {
  const privateId = makeSessionId(channel, "separate-private-sender");
  const groupId = makeSessionId(channel, "separate-group");
  const records = new Map([[privateId, [{ role: "user" as const, content: "Confidential private note" }]]]);
  const migrateHistory = vi.fn((from: string, to: string) => {
    if (!records.has(to) && records.has(from)) records.set(to, records.get(from)!);
  });
  const context = createChannelContext({
    migrateHistory, appendChannelHistory: vi.fn(), loadRecentChannelHistory: async id => records.get(id) ?? [],
  });
  const dispatch = context.resolveDispatchContext(groupId);
  context.recordIncomingSession(envelope({ channel, chatType: "group", senderId: "separate-private-sender", chatId: "separate-group" }), dispatch);
  expect(await context.resolvePriorMessages(dispatch, 10)).toStrictEqual([]);
  expect(records.get(privateId)?.[0].content).toEqual("Confidential private note");
  expect(migrateHistory).not.toHaveBeenCalled();
});
