import { expect, it, vi } from "vitest";
import { ChannelManager } from "./manager";
import type { ChannelAdapter } from "./adapters/base";

function adapterFor(id: "qq" | "feishu"): ChannelAdapter {
  let live = false;
  return {
    id, displayName: `Contract ${id}`, capability: {} as never, onMessage: null,
    start: vi.fn(async () => { live = true; }), stop: vi.fn(async () => { live = false; }),
    send: vi.fn(async () => ({ ok: true })),
    getStatus: () => ({ enabled: live, phase: live ? "running" : "offline" }),
  };
}

it("starts a registered adapter once across repeated and bulk start requests", async () => {
  const registry = new ChannelManager();
  const channel = adapterFor("qq");
  registry.register(channel);
  await registry.startOne("qq");
  await registry.startOne("qq");
  await registry.startAll();
  expect(registry.getAdapter("qq")).toBe(channel);
  expect(channel.getStatus().phase).toEqual("running");
  expect(channel.start).toHaveBeenCalledTimes(1);
  expect(await registry.unregister("qq")).toEqual(true);
  expect(channel.stop).toHaveBeenCalledTimes(1);
  expect(channel.getStatus().phase).toEqual("offline");
  expect(registry.getAdapter("qq")).toBeUndefined();
});

it("returns false when asked to remove an unregistered channel", async () => {
  expect(await new ChannelManager().unregister("absent" as never)).toEqual(false);
});

it("refuses to replace a running adapter with another instance of the same channel", async () => {
  const registry = new ChannelManager();
  const original = adapterFor("feishu");
  const replacement = adapterFor("feishu");
  registry.register(original);
  await registry.startOne("feishu");
  expect(() => registry.register(replacement)).toThrow(/禁止覆盖/);
  expect(registry.getAdapter("feishu")).toBe(original);
  expect(replacement.getStatus().phase).toEqual("offline");
  await registry.stopAll();
});

it("delegates incoming messages without sending the dispatcher result a second time", async () => {
  const registry = new ChannelManager();
  const channel = adapterFor("qq");
  const dispatch = vi.fn(async () => ({
    channel: "qq" as const, targetId: "room-49", parts: [{ kind: "text" as const, text: "Already delivered" }],
  }));
  registry.register(channel);
  registry.setDispatcher(dispatch);
  await registry.startOne("qq");
  const inbound = { channel: "qq" as const, chatId: "room-49", senderId: "participant-8", text: "Status request", at: new Date(900) };
  await channel.onMessage?.(inbound);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls[0]?.[0]).toBe(inbound);
  expect(channel.send).not.toHaveBeenCalled();
  await registry.stopAll();
});
