import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAdapter } from "../base";
import { NapCatAdapter } from "./napcat-adapter";
const fixture = vi.hoisted(() => ({ servers: [] as any[], config: { enabled: true, listenMode: "loopback", port: 6200, allowedPrivateUserIds: ["sender"], allowedGroupIds: [], groupRequireMention: true } }));
vi.mock("../../settings-store", () => ({ loadChannelsSettings: () => ({ qq: fixture.config }) }));
vi.mock("./onebot-reverse-ws", () => ({ OneBotReverseWsServer: class {
  constructor(readonly options: any) { fixture.servers.push(this); }
  async start() { return { host: "127.0.0.1", port: 6200, url: "ws://synthetic.invalid", resolvedMode: "loopback" }; }
  async stop() { this.options.onClientDisconnected(); }
} }));
vi.mock("./onebot-media", () => ({ ONEBOT_STREAM_MIN_VERSION: "4.0.0", versionAtLeast: () => true, OneBotMediaManager: class { async start() {} stop() {} } }));
vi.mock("./onebot-normalizer", () => ({ normalizeOneBotMessage: async () => ({ channel: "qq", senderId: "sender", chatId: "sender", text: "hi", at: new Date() }) }));
const adapters: NapCatAdapter[] = [];
const identity = (adapter: ChannelAdapter) => adapter.getMemoryAccountIdentity?.() ?? null;
function create() { const adapter = new NapCatAdapter(); adapters.push(adapter); return adapter; }
function client(userId: string, login: Promise<{ user_id: string }> = Promise.resolve({ user_id: userId })) { return { call: async (action: string) => action === "get_login_info" ? login : { app_version: "4.0.0" } }; }
beforeEach(() => { fixture.config.enabled = true; });
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.stop(); fixture.servers.length = 0; });
describe("NapCat trusted memory account", () => {
  it("requires verified get_login_info and rejects mismatched headers", async () => {
    const adapter = create(); await adapter.start(); expect(identity(adapter)).toBeNull(); const server = fixture.servers[0];
    await expect(server.options.onClientConnected(client("123"), { headerSelfId: "456" })).rejects.toThrow("不一致"); expect(identity(adapter)).toBeNull();
    await server.options.onClientConnected(client("123"), { headerSelfId: "123" });
    expect(identity(adapter)).toMatchObject({ accountKey: "qq:123", revision: expect.any(Number) }); expect(Object.isFrozen(identity(adapter))).toBe(true);
  });
  it("revokes before a replacement handshake and never takes identity from events", async () => {
    const adapter = create(); await adapter.start(); const server = fixture.servers[0]; const oldClient = client("123"); await server.options.onClientConnected(oldClient, { headerSelfId: "123" }); const first = identity(adapter)!;
    await server.options.onEvent({ post_type: "message", message_type: "private", self_id: "forged", user_id: "sender", message_id: "m", message: [] }, oldClient); expect(identity(adapter)).toEqual(first);
    let resolve!: (value: { user_id: string }) => void; const login = new Promise<{ user_id: string }>((done) => { resolve = done; });
    const replacing = server.options.onClientConnected(client("456", login), { headerSelfId: "456" }); expect(identity(adapter)).toBeNull();
    resolve({ user_id: "456" }); await replacing; expect(identity(adapter)?.accountKey).toBe("qq:456"); expect(identity(adapter)!.revision).toBeGreaterThan(first.revision);
    server.options.onClientDisconnected(); expect(identity(adapter)).toBeNull();
  });
  it("does not resurrect a stopped or superseded pending handshake", async () => {
    const adapter = create(); await adapter.start(); const server = fixture.servers[0];
    let resolve!: (value: { user_id: string }) => void; const pending = new Promise<{ user_id: string }>((done) => { resolve = done; });
    const connecting = server.options.onClientConnected(client("123", pending), { headerSelfId: "123" }); await adapter.stop(); await adapter.start();
    const current = fixture.servers[1]; await current.options.onClientConnected(client("456"), { headerSelfId: "456" }); const identityBeforeLate = identity(adapter);
    resolve({ user_id: "123" }); await connecting; server.options.onClientDisconnected(); expect(identity(adapter)).toEqual(identityBeforeLate); expect(identity(adapter)?.accountKey).toBe("qq:456");
  });
  it("rejects a handshake disconnected while get_login_info is pending", async () => {
    const adapter = create(); await adapter.start(); const server = fixture.servers[0];
    let resolve!: (value: { user_id: string }) => void; const pending = new Promise<{ user_id: string }>((done) => { resolve = done; });
    const connecting = server.options.onClientConnected(client("123", pending), { headerSelfId: "123" }); server.options.onClientDisconnected(); resolve({ user_id: "123" }); await connecting; expect(identity(adapter)).toBeNull();
  });
  it("does not publish missing login identity or configuration disabled after login", async () => {
    const adapter = create(); await adapter.start(); const server = fixture.servers[0];
    await expect(server.options.onClientConnected(client(""), {})).rejects.toThrow("user_id"); expect(identity(adapter)).toBeNull();
    await server.options.onClientConnected(client("123"), { headerSelfId: "123" }); fixture.config.enabled = false; expect(identity(adapter)).toBeNull();
  });
});
