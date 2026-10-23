import { describe, expect, it, vi } from "vitest";
import { ChannelManager } from "../channels/manager";
import { createChannelMemoryAccountIdentity, type ChannelAdapter } from "../channels/adapters/base";
import type { IncomingMessage } from "../channels/types";
import * as ingressApi from "./channel-memory-ingress";

vi.mock("../logger", () => ({ logger: { info: vi.fn() }, LogTag: { Channels: "channels" } }));

const incoming = (patch: Partial<IncomingMessage> = {}): IncomingMessage => ({ channel: "qq", senderId: "sender-1", chatId: "chat-1", text: "I prefer bash", at: new Date(1700000000000), ...patch });
async function fixture(accountKey = "qq:account-a") {
  const identity = createChannelMemoryAccountIdentity(); identity.authenticate(accountKey);
  const adapter: ChannelAdapter = { id: "qq", displayName: "synthetic", capability: {} as never,
    onMessage: null, start: async () => {}, stop: async () => {}, send: async () => ({ ok: true }),
    getMemoryAccountIdentity: identity.read, getStatus: () => ({ enabled: true, phase: "running" }) };
  const manager = new ChannelManager(); manager.register(adapter);
  let captured: object | undefined;
  manager.setDispatcher(async (_msg, ingress) => { captured = ingress; return null; });
  await manager.startOne("qq");
  const receive = async (message = incoming()) => { captured = undefined; await adapter.onMessage!(message); return { message, cap: captured! }; };
  return { manager, adapter, identity, receive };
}

describe("trusted channel memory ingress", () => {
  it("binds the exact registered adapter event and ignores payload account shapes", async () => {
    expect(ingressApi.requireChannelMemoryIngress).toBeTypeOf("function");
    const f = await fixture(); const msg = incoming();
    Object.assign(msg, { accountKey: "desktop-local-profile-v1", accountRevision: 900, memoryIngress: {} });
    const { cap } = await f.receive(msg), current = ingressApi.requireChannelMemoryIngress(cap, msg);
    expect(current).toMatchObject({ channel: "qq", accountKey: "qq:account-a", senderId: "sender-1", chatId: "chat-1", chatType: "private", provenance: "direct-text" });
    expect(current.scopeKey).not.toBe("desktop-local-profile-v1");
    expect(() => ingressApi.requireChannelMemoryIngress({ ...cap }, msg)).toThrow("MEMORY_CHANNEL_INGRESS_DENIED");
    expect(() => ingressApi.requireChannelMemoryIngress(cap, incoming())).toThrow("MEMORY_CHANNEL_INGRESS_DENIED");
    msg.senderId = "changed";
    expect(() => ingressApi.requireChannelMemoryIngress(cap, msg)).toThrow("MEMORY_CHANNEL_INGRESS_DENIED");
  });

  it("separates accounts, senders, groups and threads in all authority keys", async () => {
    const a = await fixture(), b = await fixture("qq:account-b");
    const cases = [await a.receive(), await b.receive(), await a.receive(incoming({ senderId: "sender-2" })),
      await a.receive(incoming({ chatType: "group" })), await a.receive(incoming({ chatId: "other-group" })), await a.receive(incoming({ threadId: "thread-2" }))];
    for (const field of ["scopeKey", "actorKey", "sessionId"] as const) {
      expect(new Set(cases.map(({ cap, message }) => ingressApi.requireChannelMemoryIngress(cap, message)[field])).size).toBe(cases.length);
    }
  });

  it("revokes old grants at stop and reconnect, even when the account key stays the same", async () => {
    const f = await fixture(), first = await f.receive(); const context = ingressApi.requireChannelMemoryIngress(first.cap);
    f.identity.revoke(); f.identity.authenticate("qq:account-a");
    expect(context.signal.aborted).toBe(true);
    expect(() => ingressApi.requireChannelMemoryIngress(first.cap)).toThrow("MEMORY_CHANNEL_INGRESS_DENIED");
    const second = await f.receive(), next = ingressApi.requireChannelMemoryIngress(second.cap);
    await f.manager.stopAll();
    expect(next.signal.aborted).toBe(true);
    expect(() => ingressApi.requireChannelMemoryIngress(second.cap)).toThrow("MEMORY_CHANNEL_INGRESS_DENIED");
    expect((await f.receive()).cap).toBeUndefined();
  });

  it("fails closed for forged account snapshots, mismatched channel and arbitrary same-manager messages", async () => {
    const f = await fixture(); f.adapter.getMemoryAccountIdentity = () => ({ accountKey: "qq:forged", revision: 1 });
    expect((await f.receive()).cap).toBeUndefined();
    f.adapter.getMemoryAccountIdentity = f.identity.read;
    expect((await f.receive(incoming({ channel: "wechat" }))).cap).toBeUndefined();
    expect(() => ingressApi.requireChannelMemoryIngress(incoming())).toThrow("MEMORY_CHANNEL_INGRESS_DENIED");
    expect((f.manager as unknown as Record<string, unknown>).mintMemoryIngress).toBeUndefined();
  });

  it("keeps quotations and trusted ASR transformations distinct from direct statements", async () => {
    const f = await fixture();
    const quote = await f.receive(incoming({ reply: { messageId: "q", senderId: "someone-else", text: "I prefer PowerShell" } }));
    expect(ingressApi.requireChannelMemoryIngress(quote.cap).provenance).toBe("quoted-context");
    const audio = incoming(); ingressApi.markChannelTextTransform(audio, "asr");
    const converted = await f.receive(audio);
    expect(ingressApi.requireChannelMemoryIngress(converted.cap).provenance).toBe("asr");
    const clone = await f.receive({ ...audio });
    expect(ingressApi.requireChannelMemoryIngress(clone.cap).provenance).toBe("direct-text");
  });
});
