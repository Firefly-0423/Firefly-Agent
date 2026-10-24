import { afterEach, describe, expect, it, vi } from "vitest";
import { QqBotAdapter } from "./qqbot-adapter";

const state = vi.hoisted(() => ({ gateway: vi.fn(), sockets: [] as any[] }));
vi.mock("../../settings-store", () => ({ loadChannelsSettings: () => ({ qqbot: { enabled: true, appId: "synthetic", appSecret: "synthetic" } }) }));
vi.mock("./qqbot-api-client", () => ({
  QqBotApiError: class extends Error {},
  QqBotApiClient: class {
    getGatewayUrl() { return state.gateway(); }
    async getAccessToken() { return "synthetic-token"; }
  },
}));
vi.mock("./qqbot-ws-client", () => ({
  QqBotWsClient: class {
    isReady = false;
    constructor(readonly options: any) { state.sockets.push(this); }
    async start() { this.isReady = true; this.options.onReadyChange(true); }
    async stop() { this.isReady = false; this.options.onReadyChange(false); }
  },
}));

function deferred() {
  let resolve!: (url: string) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<string>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const adapters: QqBotAdapter[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.stop();
  state.sockets.length = 0;
  state.gateway.mockReset();
});
function createAdapter() { const adapter = new QqBotAdapter(); adapters.push(adapter); return adapter; }

describe("QqBotAdapter lifecycle", () => {
  it("does not construct a gateway socket after stop during gateway discovery", async () => {
    const gateway = deferred();
    state.gateway.mockReturnValue(gateway.promise);
    const adapter = createAdapter();
    const starting = adapter.start();
    await adapter.stop();
    gateway.resolve("wss://synthetic.invalid");
    await starting;
    expect(state.sockets).toHaveLength(0);
    expect(adapter.getStatus().phase).toBe("offline");
  });

  it("ignores a gateway failure belonging to a stopped run", async () => {
    const gateway = deferred();
    state.gateway.mockReturnValue(gateway.promise);
    const adapter = createAdapter();
    const starting = adapter.start();
    const result = starting.then(() => "stopped", () => "rejected");
    await adapter.stop();
    gateway.reject(new Error("late gateway failure"));
    expect(await result).toBe("stopped");
    expect(adapter.getStatus().phase).toBe("offline");
  });

  it.each([false, true])("does not dispatch an old attachment after stop (restart=%s)", async (restart) => {
    state.gateway.mockResolvedValue("wss://synthetic.invalid");
    const adapter = createAdapter();
    await adapter.start();
    let releaseDownload!: () => void;
    const pendingDownload = new Promise<void>((resolve) => { releaseDownload = resolve; });
    (adapter as any).downloadAttachments = () => pendingDownload;
    const delivered: string[] = [];
    adapter.onMessage = async (message) => { delivered.push(message.text); return null; };
    const delivering = (adapter as any).deliverIncoming({
      channel: "qqbot", messageId: "synthetic-message", senderId: "synthetic-user", chatId: "synthetic-user", text: "late attachment", at: new Date(),
      attachments: [{ kind: "image", url: "https://synthetic.invalid/image.png" }],
    });
    await adapter.stop();
    if (restart) await adapter.start();
    releaseDownload();
    await delivering;
    expect(delivered).toEqual([]);
    expect(adapter.getStatus().phase).toBe(restart ? "running" : "offline");
  });

  it("keeps the new gateway connection when old discovery finishes after restart", async () => {
    const oldGateway = deferred();
    state.gateway.mockReturnValueOnce(oldGateway.promise).mockResolvedValue("wss://new.invalid");
    const adapter = createAdapter();
    const firstStart = adapter.start();
    await adapter.stop();
    await adapter.start();
    oldGateway.resolve("wss://old.invalid");
    await firstStart;
    expect(state.sockets).toHaveLength(1);
    expect(state.sockets[0].options.gatewayUrl).toBe("wss://new.invalid");
    expect(adapter.getStatus().phase).toBe("running");
  });
});
