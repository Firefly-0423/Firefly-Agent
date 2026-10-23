// @vitest-environment jsdom
import { act, createElement as element } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { useChannelMirrorEvents } from "./useChannelMirrorEvents";
import type { ChatMessageItem } from "../components/ChatMessageList";

let close: (() => void) | undefined;
afterEach(() => { close?.(); close = undefined; vi.unstubAllGlobals(); });
function mirror() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let receive: ((value: unknown) => void) | undefined;
  let selected: string | undefined = "desktop";
  const append = vi.fn<(id: string, rows: ChatMessageItem[]) => void>();
  const lookup = vi.fn(async () => ({ externalChats: [] as Array<{ sessionId: string; channel: string; chatId: string }>, bindings: [] as Array<{ sessionId: string; conversationId: string }> }));
  const stop = vi.fn(() => { receive = undefined; });
  vi.stubGlobal("agui", { onEvent: (callback: typeof receive) => { receive = callback; return stop; } });
  vi.stubGlobal("settings", { channelsContextBindingsGet: lookup });
  const target = document.body.appendChild(document.createElement("aside"));
  const renderer = createRoot(target);
  function Screen() { useChannelMirrorEvents({ getActiveSessionId: () => selected, appendMessages: append }); return null; }
  act(() => renderer.render(element(Screen)));
  const unmount = () => { act(() => renderer.unmount()); target.remove(); close = undefined; };
  close = unmount;
  return {
    append, lookup, stop, unmount,
    select: (value?: string) => { selected = value; },
    async send(event: unknown) { await act(async () => { receive?.(event); await new Promise(resolve => setTimeout(resolve, 0)); }); },
  };
}
function packet(direction = "bot:incoming", fields: Record<string, unknown> = {}) {
  return { type: "CUSTOM", name: "firefly.botMessage", value: { type: direction, channel: "wechat", senderId: "sender", senderName: "Mira", chatId: "external-room", text: "Check the build", at: 44, ...fields } };
}

test.each([
  ["bot:incoming", "[\u5fae\u4fe1] Mira\uff1aCheck the build"],
  ["bot:outgoing", "[\u5fae\u4fe1] \u56de\u590d Mira\uff1aCheck the build"],
])("%s renders the exact transient system line", async (direction, content) => {
  const page = mirror(); await page.send(packet(direction));
  expect(page.append).toHaveBeenCalledTimes(1);
  expect(page.append.mock.calls[0][0]).toBe("desktop");
  expect(page.append.mock.calls[0][1]).toEqual([expect.objectContaining({ role: "system", content })]);
});
test("no selected desktop conversation suppresses mirroring", async () => {
  const page = mirror(); page.select(); await page.send(packet()); expect(page.append.mock.calls).toEqual([]);
});
test.each([["desktop", 0], ["another-conversation", 1]] as const)("external binding to %s produces %i transient appends", async (conversationId, count) => {
  const page = mirror();
  page.lookup.mockResolvedValue({ externalChats: [{ sessionId: "external-session", channel: "wechat", chatId: "external-room" }], bindings: [{ sessionId: "external-session", conversationId }] });
  await page.send(packet()); expect(page.append).toHaveBeenCalledTimes(count);
});
test("long content respects the 160-character budget and ends in an ellipsis", async () => {
  const page = mirror(); await page.send(packet("bot:incoming", { text: "x".repeat(300) }));
  const rendered = page.append.mock.calls[0][1][0].content;
  expect(rendered.length).toBeLessThanOrEqual(160 + "[\u5fae\u4fe1] Mira\uff1a\u2026".length);
  expect(rendered.endsWith("\u2026")).toBe(true);
});
test("empty display names use the external chat identifier", async () => {
  const page = mirror(); await page.send(packet("bot:incoming", { senderName: "", chatId: "room-fallback" }));
  expect(page.append.mock.calls[0][1][0].content).toBe("[\u5fae\u4fe1] room-fallback\uff1aCheck the build");
});
test("invalid payloads and unrelated envelopes never append", async () => {
  const page = mirror();
  for (const event of [packet("bot:weird", { channel: undefined, chatId: undefined, text: undefined }), { type: "CUSTOM", name: "firefly.botMessage", value: null }, { type: "TEXT_MESSAGE_CONTENT", name: "firefly.botMessage", value: {} }, { type: "CUSTOM", name: "other.event", value: {} }]) await page.send(event);
  expect(page.append.mock.calls).toEqual([]);
});
test("unmount detaches the subscription before later deliveries", async () => {
  const page = mirror(); page.unmount(); await page.send(packet());
  expect(page.stop).toHaveBeenCalledTimes(1); expect(page.append.mock.calls).toEqual([]);
});
