import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAdapter } from "../base";
import * as base from "../base";
import { QqBotAdapter } from "./qqbot-adapter";
const fixture = vi.hoisted(() => ({ gateway: vi.fn(), sockets: [] as any[], config: { enabled: true, appId: "app-a", appSecret: "synthetic", allowAnyPrivate: true } }));
vi.mock("../../settings-store", () => ({ loadChannelsSettings: () => ({ qqbot: fixture.config }) }));
vi.mock("./qqbot-api-client", () => ({ QqBotApiError: class extends Error {}, QqBotApiClient: class { getGatewayUrl() { return fixture.gateway(); } async getAccessToken() { return "synthetic"; } } }));
vi.mock("./qqbot-ws-client", () => ({ QqBotWsClient: class {
  isReady = false;
  constructor(readonly options: any) { fixture.sockets.push(this); }
  async start() {}
  ready(ready: boolean) { this.isReady = ready; this.options.onReadyChange(ready); }
  async stop() { this.ready(false); }
} }));
const adapters: QqBotAdapter[] = [];
const identity = (adapter: ChannelAdapter) => adapter.getMemoryAccountIdentity?.() ?? null;
function create() { const adapter = new QqBotAdapter(); adapters.push(adapter); return adapter; }
beforeEach(() => { fixture.gateway.mockResolvedValue("wss://synthetic.invalid"); Object.assign(fixture.config, { enabled: true, appId: "app-a" }); });
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.stop(); fixture.sockets.length = 0; fixture.gateway.mockReset(); });
describe("QQBot trusted memory account", () => {
  it("aborts the trusted account signal synchronously when the real adapter stops", async () => {
    const adapter = create();
    await adapter.start();
    fixture.sockets[0].ready(true);
    const snapshot = identity(adapter)!;
    const signal = (base as typeof base & {
      getChannelMemoryAccountSignal?: (value: unknown) => AbortSignal | null;
    }).getChannelMemoryAccountSignal?.(snapshot) ?? null;
    expect(signal).not.toBeNull();
    expect(signal!.aborted).toBe(false);

    const stopping = adapter.stop();
    expect(signal!.aborted).toBe(true);
    expect(identity(adapter)).toBeNull();
    await stopping;
  });

  it("requires authenticated READY and captures appId independently of event data", async () => {
    const adapter = create(); await adapter.start(); expect(identity(adapter)).toBeNull(); const socket = fixture.sockets[0]; socket.ready(true);
    const first = identity(adapter); expect(first).toMatchObject({ accountKey: "qqbot:app-a", revision: expect.any(Number) });
    socket.options.onDispatch("C2C_MESSAGE_CREATE", { id: "m", author: { user_openid: "user" }, content: "hello", appId: "forged", accountKey: "qqbot:forged" });
    expect(identity(adapter)).toEqual(first); expect(Object.isFrozen(first)).toBe(true);
  });
  it("revokes reconnect and account changes and ignores an old socket", async () => {
    const adapter = create(); await adapter.start(); const old = fixture.sockets[0]; old.ready(true); const first = identity(adapter)!;
    old.ready(false); expect(identity(adapter)).toBeNull(); old.ready(true); expect(identity(adapter)!.revision).toBeGreaterThan(first.revision);
    await adapter.stop(); expect(identity(adapter)).toBeNull(); fixture.config.appId = "app-b"; await adapter.start();
    old.ready(true); expect(identity(adapter)).toBeNull(); fixture.sockets[1].ready(true); expect(identity(adapter)?.accountKey).toBe("qqbot:app-b");
  });
  it("does not rebind a running connection when settings change", async () => {
    const adapter = create(); await adapter.start(); fixture.sockets[0].ready(true); fixture.config.appId = "app-b"; expect(identity(adapter)).toBeNull();
    fixture.config.appId = "app-a"; expect(identity(adapter)).toBeNull();
  });
  it("keeps ready transport errors distinct from disconnected errors", async () => {
    const adapter = create(); await adapter.start(); const socket = fixture.sockets[0]; socket.ready(true); const first = identity(adapter);
    socket.options.onError(new Error("message error")); expect(identity(adapter)).toEqual(first);
    socket.ready(false); socket.options.onError(new Error("connection failed")); expect(identity(adapter)).toBeNull();
  });
  it("never authenticates a failed gateway or an old discovery response", async () => {
    const adapter = create(); fixture.gateway.mockRejectedValueOnce(new Error("denied")); await expect(adapter.start()).rejects.toThrow("denied"); expect(identity(adapter)).toBeNull();
    let resolve!: (value: string) => void; fixture.gateway.mockReturnValueOnce(new Promise<string>((done) => { resolve = done; }));
    const starting = adapter.start(); await adapter.stop(); resolve("wss://late.invalid"); await starting; expect(identity(adapter)).toBeNull(); expect(fixture.sockets).toHaveLength(0);
  });
});
