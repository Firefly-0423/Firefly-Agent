import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelConversationBindingStore } from "./conversation-binding-store";
import { bindContextConversation, getContextBindingSnapshot, unbindContextConversation } from "./conversation-binding-api";

let directory: string;
let bindings: ChannelConversationBindingStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "binding-api-contract-"));
  bindings = new ChannelConversationBindingStore(join(directory, "bindings.json"));
  bindings.observe({ sessionId: "external-lobby", channel: "qq", chatId: "lobby-7", chatType: "private", lastAt: 70 });
});
afterEach(() => rmSync(directory, { force: true, recursive: true }));

it("exposes conversation summaries and external metadata without transcript contents", () => {
  const conversations = [{ id: "desktop-lobby", title: "Planning", mode: "chat", updatedAt: 85 }];
  const snapshot = getContextBindingSnapshot(bindings, conversations);
  expect(snapshot.externalChats[0].sessionId).toEqual("external-lobby");
  expect(snapshot.conversations).toStrictEqual(conversations);
  expect(snapshot).not.toHaveProperty("messages");
});

it("rejects nonexistent chats before checking desktop conversation existence", () => {
  const exists = vi.fn(() => true);
  expect(bindContextConversation(bindings, { sessionId: "external-missing", conversationId: "desktop-lobby" }, exists))
    .toStrictEqual({ error: "外部聊天不存在", ok: false });
  expect(exists).not.toHaveBeenCalled();
  expect(bindContextConversation(bindings, { sessionId: "external-lobby", conversationId: "desktop-missing" }, () => false))
    .toStrictEqual({ error: "桌面对话不存在", ok: false });
});

it("binds independently and only clears the selected chat", () => {
  bindings.observe({ sessionId: "external-study", channel: "wechat", chatId: "study-9", chatType: "private", lastAt: 90 });
  const exists = vi.fn(() => true);
  for (const [sessionId, conversationId] of [["external-lobby", "desktop-lobby"], ["external-study", "desktop-study"]]) {
    expect(bindContextConversation(bindings, { sessionId, conversationId }, exists)).toStrictEqual({ ok: true });
    expect(exists).toHaveBeenCalledWith(conversationId);
  }
  expect(unbindContextConversation(bindings, "external-lobby")).toStrictEqual({ ok: true });
  expect(bindings.resolve("external-lobby")).toBeNull();
  expect(bindings.resolve("external-study")).toEqual("desktop-study");
});

it.each([
  [null, "请求格式无效"],
  [{ sessionId: "", conversationId: "valid" }, "外部聊天标识无效"],
  [{ sessionId: "external-lobby", conversationId: "" }, "桌面对话标识无效"],
])("rejects invalid binding requests %j", (payload, error) => {
  expect(bindContextConversation(bindings, payload, () => true)).toStrictEqual({ error, ok: false });
});
