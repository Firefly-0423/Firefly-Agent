import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAdapter } from "../base";
import { ILinkBotAdapter } from "./ilink-bot-adapter";
import { ILinkClient, SessionExpiredError } from "./ilink-protocol-client";
vi.mock("../../settings-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../settings-store")>()),
  loadChannelsSettings: () => ({ wechat: { enabled: true, allowAnyPrivate: true, allowedSenderIds: [] } }),
}));
vi.mock("electron", () => ({ app: { getPath: () => "/synthetic/wechat-memory" } }));
vi.mock("../../../logger", () => ({ logger: { info() {}, warn() {}, error() {} }, LogTag: {} }));
const credentials = { botToken: "synthetic", ilinkBotId: "bot-a", baseUrl: "https://synthetic.invalid", ilinkUserId: "user-a" };
const polls: Array<{ resolve: (response: Response) => void; reject: (error: Error) => void }> = [];
const adapters: ILinkBotAdapter[] = [];
const identity = (adapter: ChannelAdapter) => adapter.getMemoryAccountIdentity?.() ?? null;
function create() { const adapter = new ILinkBotAdapter(); adapters.push(adapter); return adapter; }
async function response(body: unknown) { polls.at(-1)!.resolve(new Response(JSON.stringify(body))); await vi.advanceTimersByTimeAsync(0); }
beforeEach(() => {
  vi.useFakeTimers(); credentials.ilinkBotId = "bot-a";
  vi.spyOn(fs, "readFile").mockImplementation(async () => JSON.stringify(credentials));
  vi.stubGlobal("fetch", (_url: unknown, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    polls.push({ resolve, reject }); init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }));
});
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.stop(); polls.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllTimers(); vi.useRealTimers(); });
describe("WeChat trusted memory account", () => {
  it("does not let an old send expiry revoke a restarted account", async () => {
    const adapter = create(); adapter.onMessage = async () => null; await adapter.start();
    await response({ msgs: [{ message_id: 1, from_user_id: "sender", to_user_id: "bot-a", message_type: 1, context_token: "synthetic", item_list: [{ type: 1, text_item: { text: "hi" } }] }] });
    let reject!: (error: Error) => void;
    vi.spyOn(ILinkClient.prototype, "sendText").mockImplementation(() => new Promise((_yes, no) => { reject = no; }));
    const sending = adapter.send({ channel: "wechat", targetId: "sender", parts: [{ kind: "text", text: "reply" }] });
    const sent = sending.catch((error) => error.message);
    await adapter.stop(); credentials.ilinkBotId = "bot-b"; await adapter.start(); await response({ msgs: [] });
    const current = identity(adapter); reject(new SessionExpiredError("old expired send")); await sent;
    expect(identity(adapter)).toEqual(current); expect(identity(adapter)?.accountKey).toBe("wechat:bot-b");
  });
  it("revokes an expired send immediately while a poll is still pending", async () => {
    const adapter = create(); adapter.onMessage = async () => null; await adapter.start();
    await response({ msgs: [{ message_id: 1, from_user_id: "sender", to_user_id: "bot-a", message_type: 1, context_token: "synthetic", item_list: [{ type: 1, text_item: { text: "hi" } }] }] });
    expect(identity(adapter)?.accountKey).toBe("wechat:bot-a");
    vi.spyOn(ILinkClient.prototype, "sendText").mockRejectedValue(new SessionExpiredError("synthetic expired send"));
    await expect(adapter.send({ channel: "wechat", targetId: "sender", parts: [{ kind: "text", text: "reply" }] })).rejects.toThrow("synthetic expired send");
    expect(identity(adapter)).toBeNull();
    await response({ msgs: [] });
    expect(identity(adapter)).toBeNull();
  });

  it("publishes only after successful polling using captured credentials, never inbound to_user_id", async () => {
    const adapter = create(); adapter.onMessage = async () => null; await adapter.start(); expect(identity(adapter)).toBeNull();
    await response({ msgs: [{ message_id: 1, from_user_id: "sender", to_user_id: "forged", message_type: 1, context_token: "synthetic", item_list: [{ type: 1, text_item: { text: "hi" } }] }] });
    const first = identity(adapter); expect(first).toMatchObject({ accountKey: "wechat:bot-a", revision: expect.any(Number) }); expect(Object.isFrozen(first)).toBe(true);
    adapter.currentCredentials!.ilinkBotId = "forged-public-field"; expect(identity(adapter)).toEqual(first);
    await response({ msgs: [] }); expect(identity(adapter)).toEqual(first);
  });
  it("revokes on polling failure, authenticates a fresh revision on recovery, and expires closed", async () => {
    const adapter = create(); await adapter.start(); await response({ msgs: [] }); const first = identity(adapter)!;
    polls.at(-1)!.reject(new Error("synthetic disconnect")); await vi.advanceTimersByTimeAsync(0); expect(identity(adapter)).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000); await response({ msgs: [] }); expect(identity(adapter)!.revision).toBeGreaterThan(first.revision);
    await response({ ret: -14, errmsg: "expired" }); expect(identity(adapter)).toBeNull();
  });
  it("revokes before stop settles and rejects late polling success", async () => {
    const adapter = create(); await adapter.start(); await response({ msgs: [] }); const old = identity(adapter)!; const late = polls.at(-1)!;
    const stopping = adapter.stop(); expect(identity(adapter)).toBeNull(); late.resolve(new Response('{"msgs":[]}')); await stopping; expect(identity(adapter)).toBeNull();
    credentials.ilinkBotId = "bot-b"; await adapter.start(); expect(identity(adapter)).toBeNull(); await response({ msgs: [] });
    expect(identity(adapter)?.accountKey).toBe("wechat:bot-b"); expect(identity(adapter)!.revision).toBeGreaterThan(old.revision);
  });
  it("never authenticates missing credentials or a rejected first poll", async () => {
    const adapter = create(); vi.mocked(fs.readFile).mockRejectedValueOnce(new Error("missing synthetic credentials")); await adapter.start(); expect(identity(adapter)).toBeNull();
    await adapter.start(); await response({ ret: -1, errmsg: "denied" }); expect(identity(adapter)).toBeNull();
  });
});
