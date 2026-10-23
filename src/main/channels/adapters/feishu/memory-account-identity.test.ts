import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAdapter } from "../base";
import { FeishuAdapter } from "./index";

const fixture = vi.hoisted(() => ({ createChannel: vi.fn(), settings: { enabled: true, appId: "app-a", appSecret: "synthetic", allowAnyPrivate: true, allowedSenderIds: [] as string[] } }));
vi.mock("@larksuiteoapi/node-sdk", () => ({ createLarkChannel: fixture.createChannel, Domain: { Feishu: "feishu" }, LoggerLevel: { warn: 1 } }));
vi.mock("../../settings-store", () => ({ loadChannelsSettings: () => ({ feishu: fixture.settings }) }));
vi.mock("electron", () => ({ app: { getPath: () => "/synthetic/feishu-memory" } }));
vi.mock("../../../logger", () => ({ logger: { info() {}, warn() {}, error() {} }, LogTag: {} }));
function deferred() { let resolve!: () => void; let reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
class Channel extends EventEmitter {
  handshake = deferred();
  state = "connecting";
  async connect() { await this.handshake.promise; this.state = "connected"; }
  async disconnect() { this.state = "idle"; }
  getConnectionStatus() { return { state: this.state }; }
}
const channels: Channel[] = [];
const adapters: FeishuAdapter[] = [];
const identity = (adapter: ChannelAdapter) => adapter.getMemoryAccountIdentity?.() ?? null;
function create() { const adapter = new FeishuAdapter(); adapters.push(adapter); return adapter; }
async function connect(adapter: FeishuAdapter) { const starting = adapter.start(); channels.at(-1)!.handshake.resolve(); await starting; return channels.at(-1)!; }
beforeEach(() => { vi.useFakeTimers(); Object.assign(fixture.settings, { enabled: true, appId: "app-a" }); fixture.createChannel.mockImplementation(() => { const channel = new Channel(); channels.push(channel); return channel; }); });
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.stop(); channels.length = 0; vi.clearAllTimers(); vi.useRealTimers(); });

describe("Feishu trusted memory account", () => {
  it("publishes captured appId only after the authenticated SDK handshake", async () => {
    const adapter = create(); const starting = adapter.start();
    expect(identity(adapter)).toBeNull(); channels[0].handshake.resolve(); await starting;
    const first = identity(adapter); expect(first).toMatchObject({ accountKey: "feishu:app-a", revision: expect.any(Number) });
    channels[0].emit("message", { chatType: "p2p", chatId: "u", senderId: "u", messageId: "m", content: '{"text":"hi"}', rawContentType: "text", appId: "forged", accountKey: "feishu:forged" });
    await Promise.resolve(); expect(identity(adapter)).toEqual(first); expect(Object.isFrozen(first)).toBe(true);
  });
  it("revokes reconnects immediately and ignores stale channel events", async () => {
    const adapter = create(); const old = await connect(adapter); const first = identity(adapter)!;
    old.state = "reconnecting"; old.emit("reconnecting"); expect(identity(adapter)).toBeNull();
    old.state = "connected"; old.emit("reconnected"); expect(identity(adapter)!.revision).toBeGreaterThan(first.revision);
    const second = identity(adapter)!; await adapter.stop(); expect(identity(adapter)).toBeNull();
    fixture.settings.appId = "app-b"; await connect(adapter); old.emit("reconnected");
    expect(identity(adapter)).toMatchObject({ accountKey: "feishu:app-b" }); expect(identity(adapter)!.revision).toBeGreaterThan(second.revision);
  });
  it("never promotes a rejected or stopped pending handshake", async () => {
    const adapter = create(); const starting = adapter.start(); channels[0].handshake.reject(new Error("authentication rejected")); await starting;
    expect(identity(adapter)).toBeNull(); await adapter.stop();
    const pending = adapter.start(); await adapter.stop(); channels.at(-1)!.handshake.resolve(); await pending; expect(identity(adapter)).toBeNull();
  });
  it("keeps processing errors distinct from loss of connection readiness", async () => {
    const adapter = create(); const channel = await connect(adapter); const first = identity(adapter);
    channel.emit("error", new Error("message processing failed")); expect(identity(adapter)).toEqual(first);
    channel.state = "failed"; expect(identity(adapter)).toBeNull();
  });
  it("revokes changed or disabled configuration without adopting its unverified appId", async () => {
    const adapter = create(); await connect(adapter); fixture.settings.appId = "app-b"; expect(identity(adapter)).toBeNull();
    fixture.settings.appId = "app-a"; expect(identity(adapter)).toBeNull(); await adapter.stop(); await connect(adapter);
    fixture.settings.enabled = false; expect(identity(adapter)).toBeNull();
  });
});
