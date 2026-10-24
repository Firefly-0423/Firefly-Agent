import { expect, it, vi } from "vitest";
import { createProactiveChannelRecipientRegistry, sendProactiveChannelMessage } from "./proactive-delivery";
import type { ChannelAdapter } from "./adapters/base";

function setup(phase: "offline" | "running" = "running", remember = true) {
  const registry = createProactiveChannelRecipientRegistry();
  if (remember) registry.remember({ channel: "wechat", senderId: "reader-52", chatId: "inbox-52", text: "Hello there", at: new Date(500) }, "context-52");
  const adapter = {
    id: "wechat", displayName: "Contract channel", capability: {}, onMessage: null,
    start: vi.fn(), stop: vi.fn(), send: vi.fn().mockResolvedValue({ ok: true }),
    getStatus: () => ({ phase, enabled: phase === "running" }),
  } as unknown as ChannelAdapter;
  const input = { channel: "wechat" as const, text: "The report is ready. Shall we review?", manager: { getAdapter: () => adapter },
    recipientRegistry: registry, appendHistory: vi.fn(), appendLog: vi.fn() };
  return { registry, adapter, input };
}

it("tracks the latest recipient separately on each supported channel", () => {
  const { registry } = setup();
  registry.remember({ channel: "feishu", senderId: "reader-91", chatId: "inbox-91", text: "New topic", at: new Date(700) }, "context-91");
  registry.remember({ channel: "wechat", senderId: "reader-73", chatId: "inbox-73", text: "Next topic", at: new Date(900) }, "context-73");
  expect(registry.get("wechat")).toMatchObject({ targetId: "inbox-73", sessionId: "context-73" });
  expect(registry.get("feishu")).toMatchObject({ targetId: "inbox-91", sessionId: "context-91" });
});

it.each([
  ["offline", true, "channel_offline"], ["running", false, "recipient_unavailable"],
] as const)("cancels with %s and a remembered recipient of %s", async (phase, remembered, reason) => {
  const { input, adapter } = setup(phase, remembered);
  expect(await sendProactiveChannelMessage(input)).toStrictEqual({ reason, kind: "cancelled" });
  expect(adapter.send).not.toHaveBeenCalled();
});

it("sends the whole reply as one part before committing assistant history", async () => {
  const { input, adapter } = setup();
  expect(await sendProactiveChannelMessage(input)).toStrictEqual({ totalParts: 1, deliveredParts: 1, kind: "committed" });
  expect(adapter.send).toHaveBeenCalledWith({
    parts: [{ kind: "text", text: input.text }], targetId: "inbox-52", channel: "wechat",
  });
});

it("does not write history when the adapter rejects delivery", async () => {
  const { input, adapter } = setup();
  vi.mocked(adapter.send).mockResolvedValue({ error: "not connected", ok: false });
  expect(await sendProactiveChannelMessage(input)).toStrictEqual({ reason: "send_failed", kind: "cancelled" });
  expect(input.appendHistory).not.toHaveBeenCalled();
});

it("uses an injected transport and commits exactly the delivered text", async () => {
  const { input } = setup();
  const send = vi.fn(async () => ({ ok: true as const }));
  expect(await sendProactiveChannelMessage({ ...input, delivery: { send } }))
    .toStrictEqual({ kind: "committed", deliveredParts: 1, totalParts: 1 });
  expect(input.appendHistory).toHaveBeenCalledWith("context-52", "assistant", input.text);
});

it("stops an invalidated proactive generation before sending", async () => {
  const { input, adapter } = setup();
  expect((await sendProactiveChannelMessage({ ...input, canContinue: () => false })).kind).toEqual("cancelled");
  expect(adapter.send).not.toHaveBeenCalled();
});
