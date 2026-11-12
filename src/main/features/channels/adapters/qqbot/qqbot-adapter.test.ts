import { beforeEach, afterEach, it, expect, vi } from "vitest";
import type { QqBotChannelConfig } from "../../settings-store";
import type { IncomingMessage, OutgoingMessage } from "../../types";

const state = vi.hoisted(() => ({
  dispatch: null as null | ((type: string, data: Record<string, unknown>) => void),
  sent: [] as Array<{ target: string; content: string; msgId: string; msgSeq: number }>,
  config: { enabled: true, appId: "108765432", appSecret: "contract-bot-credential", allowAnyPrivate: false,
    allowedUserOpenids: ["contract-user-alpha"], allowedGroupOpenids: ["contract-group-alpha"] },
}));
vi.mock("electron", () => ({ app: { getPath: () => process.env.TEMP ?? process.cwd() } }));
vi.mock("../../settings-store", () => ({ loadChannelsSettings: () => ({ qqbot: state.config }) }));
vi.mock("./qqbot-api-client", () => ({
  QqBotApiError: class extends Error {},
  QqBotApiClient: class {
    async getGatewayUrl() { return "wss://gateway.invalid/contract"; }
    async getAccessToken() { return "contract-access-token"; }
    async sendText(target: { openid: string; chatType: string }, content: string, receipt: { msgId: string; msgSeq: number }) {
      state.sent.push({ ...receipt, content, target: `${target.chatType}:${target.openid}` });
    }
  },
}));
vi.mock("./qqbot-ws-client", () => ({
  QqBotWsClient: class {
    isReady = false;
    constructor(private options: { onDispatch: typeof state.dispatch; onReadyChange: (ready: boolean) => void }) { state.dispatch = options.onDispatch; }
    async start() { this.isReady = true; this.options.onReadyChange(true); }
    async stop() { this.isReady = false; this.options.onReadyChange(false); }
  },
}));
import { QqBotAdapter, normalizeQqBotEvent, isQqBotEventAllowed } from "./qqbot-adapter";

const timestamp = "2025-05-16T09:10:11+08:00";
function privateEvent(extra: Record<string, unknown> = {}) {
  return { id: "contract-private-12", author: { user_openid: "contract-user-alpha" }, content: "Review the draft", timestamp, ...extra };
}
function groupEvent() {
  return { id: "contract-group-12", author: { member_openid: "contract-user-beta" },
    group_openid: "contract-group-alpha", content: "  Begin the review", timestamp };
}
let adapters: QqBotAdapter[];
beforeEach(() => { adapters = []; state.sent.length = 0; });
afterEach(async () => { for (const adapter of adapters) await adapter.stop(); });
async function start() { const adapter = new QqBotAdapter(); adapters.push(adapter); await adapter.start(); return adapter; }
function outgoing(): OutgoingMessage {
  return { channel: "qqbot", chatType: "private", targetId: "contract-user-alpha", parts: [{ kind: "text", text: "Draft received. Review next." }] };
}

it("normalizes direct and group envelopes with their distinct openid fields", () => {
  const direct = normalizeQqBotEvent("C2C_MESSAGE_CREATE", privateEvent());
  expect(direct).not.toBeNull();
  expect(direct).toMatchObject({ channel: "qqbot", chatType: "private", senderId: "contract-user-alpha",
    chatId: "contract-user-alpha", text: "Review the draft", messageId: "contract-private-12" });
  expect(direct!.at.getTime()).toEqual(Date.parse(timestamp));
  expect(normalizeQqBotEvent("GROUP_AT_MESSAGE_CREATE", groupEvent())).toMatchObject({
    chatType: "group", senderId: "contract-user-beta", chatId: "contract-group-alpha", text: "Begin the review",
  });
});

it("preserves image order and chooses the WAV URL over the voice source URL", () => {
  const result = normalizeQqBotEvent("C2C_MESSAGE_CREATE", privateEvent({ content: "", attachments: [
    { content_type: "image/png", url: "https://media.invalid/chart", filename: "chart.png" },
    { content_type: "voice", url: "https://media.invalid/silk", voice_wav_url: "https://media.invalid/wave" },
  ] }));
  expect(result!.attachments).toHaveLength(2);
  expect(result!.attachments![0]).toMatchObject({ kind: "image", url: "https://media.invalid/chart", mime: "image/png" });
  expect(result!.attachments![1]).toMatchObject({ kind: "audio", url: "https://media.invalid/wave" });
});

it("rejects unrelated events and messages missing a sender or group identifier", () => {
  expect(normalizeQqBotEvent("FRIEND_ADD" as never, {})).toBeNull();
  expect(normalizeQqBotEvent("C2C_MESSAGE_CREATE", { content: "Review" })).toBeNull();
  expect(normalizeQqBotEvent("GROUP_AT_MESSAGE_CREATE", { author: { member_openid: "contract-user-beta" }, content: "Review" })).toBeNull();
});

it("applies private and group allowlists independently", () => {
  const config: QqBotChannelConfig = state.config;
  const direct = { chatType: "private" as const, senderId: "contract-user-alpha", chatId: "contract-user-alpha" };
  const stranger = { ...direct, senderId: "contract-stranger", chatId: "contract-stranger" };
  expect(isQqBotEventAllowed(direct, config)).toEqual(true);
  expect(isQqBotEventAllowed(stranger, config)).toEqual(false);
  expect(isQqBotEventAllowed(stranger, { ...config, allowAnyPrivate: true })).toEqual(true);
  expect(isQqBotEventAllowed({ chatType: "group", senderId: "contract-user-beta", chatId: "contract-group-alpha" }, config)).toEqual(true);
  expect(isQqBotEventAllowed({ chatType: "group", senderId: "contract-user-beta", chatId: "contract-other-group" }, config)).toEqual(false);
});

it("reports rejected sender identifiers in the running channel status", async () => {
  const adapter = await start();
  expect(adapter.getStatus().phase).toEqual("running");
  state.dispatch!("C2C_MESSAGE_CREATE", privateEvent({ id: "unapproved-12", author: { user_openid: "contract-stranger" } }));
  await vi.waitFor(() => expect(adapter.getStatus().detail?.lastRejectedOpenid).toEqual("contract-stranger"));
});

it("hands approved messages to the dispatcher and sends a passive reply with the inbound receipt", async () => {
  const adapter = await start();
  const received: IncomingMessage[] = [];
  adapter.onMessage = async message => { received.push(message); return null; };
  state.dispatch!("C2C_MESSAGE_CREATE", privateEvent());
  await vi.waitFor(() => expect(received[0]?.senderId).toEqual("contract-user-alpha"));
  expect((await adapter.send(outgoing())).ok).toEqual(true);
  expect(state.sent).toHaveLength(1);
  expect(state.sent[0]).toMatchObject({ target: "private:contract-user-alpha", msgId: "contract-private-12", msgSeq: 1 });
});

it("increments reply sequence numbers through four sends and refuses the fifth", async () => {
  const adapter = await start();
  state.dispatch!("C2C_MESSAGE_CREATE", privateEvent());
  for (let count = 0; count < 4; count++) expect((await adapter.send(outgoing())).ok).toEqual(true);
  expect(state.sent.map(record => record.msgSeq)).toStrictEqual([1, 2, 3, 4]);
  const refused = await adapter.send(outgoing());
  expect(refused.ok).toEqual(false);
  expect(refused.error).toContain("上限");
  expect(state.sent).toHaveLength(4);
});

it("deduplicates repeated pushes of the same message", async () => {
  const adapter = await start();
  const received = vi.fn(async () => null);
  adapter.onMessage = received;
  state.dispatch!("C2C_MESSAGE_CREATE", privateEvent());
  state.dispatch!("C2C_MESSAGE_CREATE", privateEvent());
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(received).toHaveBeenCalledTimes(1);
});

it("hands off a second same-chat message while the first dispatcher call is pending", async () => {
  const adapter = await start();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const trace: string[] = [];
  adapter.onMessage = async message => {
    trace.push(message.messageId!);
    if (message.messageId === "pending-review") await blocked;
    return null;
  };
  try {
    state.dispatch!("C2C_MESSAGE_CREATE", privateEvent({ id: "pending-review" }));
    state.dispatch!("C2C_MESSAGE_CREATE", privateEvent({ id: "following-review" }));
    await vi.waitFor(() => expect(trace).toStrictEqual(["pending-review", "following-review"]));
  } finally { release(); }
});

it("refuses proactive sends without a recent inbound reply context", async () => {
  const adapter = await start();
  const result = await adapter.send({ ...outgoing(), targetId: "contract-unseen-user" });
  expect(result.ok).toEqual(false);
  expect(result.error).toContain("被动回复");
});
