import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ILinkBotAdapter } from "./ilink-bot-adapter";
import { ILinkClient, type WeixinMessage } from "./ilink-protocol-client";

vi.mock("../../settings-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../settings-store")>()),
  loadChannelsSettings: () => ({ wechat: { enabled: true, allowAnyPrivate: true, allowedSenderIds: [] } }),
}));
vi.mock("electron", () => ({ app: { getPath: () => "/synthetic/firefly-wechat-lifecycle" } }));
vi.mock("../../../logger", () => ({ logger: { info() {}, warn() {}, error() {} }, LogTag: {} }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const credentials = { botToken: "synthetic", ilinkBotId: "synthetic-bot", baseUrl: "https://synthetic.invalid", ilinkUserId: "synthetic-user" };
const adapters: ILinkBotAdapter[] = [];

beforeEach(() => {
  vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify(credentials));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected synthetic request"); }));
});

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function adapterWithMessages() {
  const adapter = new ILinkBotAdapter();
  const messages: string[] = [];
  adapter.onMessage = async (message) => { messages.push(message.text); return null; };
  adapters.push(adapter);
  return { adapter, messages };
}

function inbound(overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return { msgId: "message-1", fromUserId: "user-1", toUserId: "bot-1", msgType: 1, content: "hello", items: [], contextToken: "context-1", raw: {}, ...overrides };
}

function pollResponse() {
  return new Response(JSON.stringify({ msgs: [{ message_id: 1, from_user_id: "user-1", to_user_id: "bot-1", message_type: 1, context_token: "context-1", item_list: [{ type: 1, text_item: { text: "late message" } }] }], get_updates_buf: "cursor-1" }));
}

describe("ILinkBotAdapter lifecycle", () => {
  it("aborts the active HTTP long poll when stopped", async () => {
    const response = deferred<Response>();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      requestSignal = init.signal ?? undefined;
      return response.promise;
    });
    const { adapter } = adapterWithMessages();
    await adapter.start();
    const stopping = adapter.stop();
    const abortedAtStop = requestSignal?.aborted;
    response.resolve(new Response(JSON.stringify({ msgs: [] })));
    await stopping;
    expect(abortedAtStop).toBe(true);
    expect(adapter.getStatus().phase).toBe("offline");
  });

  it("does not dispatch a long-poll response that arrives after stop", async () => {
    const response = deferred<Response>();
    vi.stubGlobal("fetch", () => response.promise);
    const { adapter, messages } = adapterWithMessages();
    await adapter.start();
    const stopping = adapter.stop();
    response.resolve(pollResponse());
    await stopping;
    expect(messages).toEqual([]);
    expect(adapter.getStatus().phase).toBe("offline");
  });

  it("does not start polling when credentials finish loading after stop", async () => {
    const credentialsRead = deferred<string>();
    vi.mocked(fs.readFile).mockReturnValue(credentialsRead.promise as any);
    let requests = 0;
    vi.stubGlobal("fetch", async () => { requests++; throw new DOMException("aborted", "AbortError"); });
    const { adapter } = adapterWithMessages();
    const starting = adapter.start();
    await adapter.stop();
    credentialsRead.resolve(JSON.stringify(credentials));
    await starting;
    // Capture before cleanup so a resurrected polling loop cannot escape the test.
    const phase = adapter.getStatus().phase;
    const count = requests;
    const stopping = adapter.stop();
    await vi.waitFor(() => expect(adapter.getStatus().phase).toBe("offline"));
    await stopping;
    expect(phase).toBe("offline");
    expect(count).toBe(0);
  });

  it("preserves the platform message ID for downstream dispatch", async () => {
    const { adapter } = adapterWithMessages();
    const receivedIds: Array<string | undefined> = [];
    adapter.onMessage = async (message) => { receivedIds.push(message.messageId); return null; };
    await (adapter as any).dispatchInbound(inbound());
    expect(receivedIds).toEqual(["message-1"]);
  });

  it("dispatches duplicate message IDs only once, including concurrent delivery", async () => {
    const { adapter, messages } = adapterWithMessages();
    await Promise.all([(adapter as any).dispatchInbound(inbound()), (adapter as any).dispatchInbound(inbound())]);
    expect(messages).toEqual(["hello"]);
  });

  it("does not send a late ASR failure notice after inbound cancellation", async () => {
    const { adapter, messages } = adapterWithMessages();
    const signal = new AbortController();
    let rejectTranscription!: (error: Error) => void;
    const started = deferred<void>();
    (adapter as any).isAsrConfigured = () => true;
    (adapter as any).transcribeVoice = () => {
      started.resolve();
      return new Promise((_, reject) => { rejectTranscription = reject; });
    };
    const sent: string[] = [];
    (adapter as any).client = { sendText: async (_target: string, text: string) => { sent.push(text); return { ok: true }; } };
    const dispatching = (adapter as any).dispatchInbound(inbound({ items: [{ type: 3, voice_item: { media: { encrypt_query_param: "synthetic", aes_key: "synthetic" } } }] }), signal.signal);
    await started.promise;
    signal.abort();
    rejectTranscription(new Error("late ASR failure"));
    await dispatching;
    expect(sent).toEqual([]);
    expect(messages).toEqual([]);
  });

  it("stops during network retry backoff without leaving its timer behind", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", async () => { throw new Error("synthetic network failure"); });
    const { adapter } = adapterWithMessages();
    await adapter.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await adapter.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(adapter.getStatus().phase).toBe("offline");
  });

  it("does not let a stopped poll clear a newer running connection", async () => {
    const oldResponse = deferred<Response>();
    let requests = 0;
    let newSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", (_url: unknown, init: RequestInit) => {
      if (++requests === 1) return oldResponse.promise;
      newSignal = init.signal ?? undefined;
      return new Promise((_, reject) => newSignal?.addEventListener("abort", () => reject(newSignal?.reason), { once: true }));
    });
    const { adapter, messages } = adapterWithMessages();
    await adapter.start();
    const oldStop = adapter.stop();
    await adapter.start();
    oldResponse.resolve(pollResponse());
    await oldStop;
    expect(adapter.getStatus().phase).toBe("running");
    expect(newSignal?.aborted).toBe(false);
    expect(messages).toEqual([]);
    await adapter.stop();
    expect(newSignal?.aborted).toBe(true);
  });

  it("expires duplicate entries so IDs can be reused later", async () => {
    vi.useFakeTimers();
    const { adapter, messages } = adapterWithMessages();
    await (adapter as any).dispatchInbound(inbound());
    await (adapter as any).dispatchInbound(inbound());
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await (adapter as any).dispatchInbound(inbound());
    expect(messages).toEqual(["hello", "hello"]);
  });

  it("keeps identical IDs from different senders and messages without IDs", async () => {
    const { adapter, messages } = adapterWithMessages();
    await (adapter as any).dispatchInbound(inbound());
    await (adapter as any).dispatchInbound(inbound({ fromUserId: "user-2", content: "other sender" }));
    await (adapter as any).dispatchInbound(inbound({ msgId: "", content: "no id 1" }));
    await (adapter as any).dispatchInbound(inbound({ msgId: "", content: "no id 2" }));
    expect(messages).toEqual(["hello", "other sender", "no id 1", "no id 2"]);
  });
});

describe("ILinkClient polling cancellation", () => {
  it("settles pending fetch immediately when the caller aborts", async () => {
    const caller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const release = deferred<Response>();
    vi.stubGlobal("fetch", (_url: unknown, init: RequestInit) => {
      requestSignal = init.signal ?? undefined;
      return new Promise<Response>((resolve, reject) => {
        release.promise.then(resolve);
        requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
      });
    });
    const client = new ILinkClient(credentials);
    const polling = client.getUpdates("cursor", caller.signal);
    const result = polling.then(() => "resolved", (error: Error) => error.name);
    caller.abort();
    const aborted = requestSignal?.aborted;
    release.resolve(new Response(JSON.stringify({ msgs: [] })));
    expect(await result).toBe("AbortError");
    expect(aborted).toBe(true);
  });

  it("keeps the existing timeout and clears it after a successful poll", async () => {
    vi.useFakeTimers();
    const release = deferred<Response>();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", (_url: unknown, init: RequestInit) => {
      requestSignal = init.signal ?? undefined;
      return new Promise<Response>((resolve, reject) => {
        release.promise.then(resolve);
        requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
      });
    });
    const client = new ILinkClient(credentials);
    const result = client.getUpdates().then(() => "resolved", (error: Error) => error.name);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await result).toBe("AbortError");
    expect(vi.getTimerCount()).toBe(0);
    vi.stubGlobal("fetch", async () => pollResponse());
    expect(await client.getUpdates()).toMatchObject({ buf: "cursor-1", messages: [{ content: "late message" }] });
    expect(vi.getTimerCount()).toBe(0);
  });
});
