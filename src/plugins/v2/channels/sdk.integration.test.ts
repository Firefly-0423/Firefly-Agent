import { expect, it, vi } from "vitest";
import { createRpcEndpoint, type RpcTransport } from "../../../shared/plugin-rpc";
import type { PluginManifestV1 } from "../../../shared/plugin-manifest";
import { createPluginContextProxy, type RuntimeChannelAdapter } from "../runtime/context";
import { createPluginChannelService, type ChannelRunRequest } from "./channel-service";

it("connects the SDK channel adapter to host registration, state, delivery, reply, disable and reactivation", async () => {
  vi.useFakeTimers();
  const listeners: Array<((frame: unknown) => void) | undefined> = [];
  const transport = (side: number): RpcTransport => ({ post: frame => queueMicrotask(() => listeners[1-side]?.(frame)), onFrame: fn => { listeners[side] = fn; return () => { listeners[side] = undefined; }; } });
  const host = createRpcEndpoint(transport(0)), plugin = createRpcEndpoint(transport(1));
  const manifest = { id: "dev.test.channel", name: "Channel", channels: [{ id: "inbox", title: "Inbox" }] } as PluginManifestV1;
  const recordSend = vi.fn(), run = vi.fn(async (_request: ChannelRunRequest) => {
    await new Promise(resolve => setTimeout(resolve, 30_000)); return { reply: "reply" };
  });
  const service = createPluginChannelService({ runner: { run }, tools: () => [], approveLocally: async () => false, recordSend, recordRun: vi.fn(), redactOutbound: text => text });
  const unbind = service.bindRpc(manifest, host, { call: (_id, method, params, opts) => host.call(method, params, opts) });
  const runtime = createPluginContextProxy({ id: manifest.id, version: "1.0.0", dataDir: "/unused", permissions: [], signal: new AbortController().signal, rpc: plugin });
  let channel!: Parameters<RuntimeChannelAdapter["start"]>[0];
  const start = vi.fn(async incoming => { channel = incoming; channel.reportState({ state: "connected" }); });
  const stop = vi.fn(async () => {}), send = vi.fn(async () => ({ externalMessageId: "out1" }));
  const adapter: RuntimeChannelAdapter = { id: "inbox", start, stop, send };
  const inbound = { externalMessageId: "in1", chat: { type: "private" as const, id: "user" }, sender: { id: "user" }, text: "hello", timestamp: 1 };
  try {
    runtime.ctx.channels.register(adapter); await runtime.awaitPendingRegistrations();
    await service.startPlugin(manifest.id); await Promise.resolve();
    expect(service.getState(manifest.id, "inbox")).toEqual({ state: "connected" });
    await expect(channel.deliver(inbound)).resolves.toEqual({ accepted: true, sessionId: 'channel:["dev.test.channel","inbox","private","user",null]' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.mock.calls[0][0].signal.aborted).toBe(false);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    await service.whenIdle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual({ chat: inbound.chat, text: "reply", replyToExternalMessageId: "in1" });
    expect(recordSend).toHaveBeenCalledWith({ pluginId: manifest.id, channelId: "inbox", result: { status: "succeeded", externalMessageId: "out1" } });
    await service.stopPlugin(manifest.id); expect(stop).toHaveBeenCalledTimes(1);
    await expect(channel.deliver(inbound)).rejects.toMatchObject({ code: "ERR_UNAVAILABLE" });
    service.registerChannel(manifest, { id: "inbox" }, { call: (_id, method, params, opts) => host.call(method, params, opts) });
    await service.startPlugin(manifest.id); expect(start).toHaveBeenCalledTimes(2);
    await service.stopPlugin(manifest.id);
  } finally { unbind(); runtime.dispose(); host.dispose(); plugin.dispose(); vi.useRealTimers(); }
});
