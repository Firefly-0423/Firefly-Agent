import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ILinkBotAdapter } from "./ilink-bot-adapter";
import type { WeixinMessage } from "./ilink-protocol-client";
import { pendingSenders } from "../../sender-gate";

const rules = vi.hoisted(() => ({
  current: { enabled: true, allowAnyPrivate: false, allowedSenderIds: [] as string[] } as unknown,
  broken: false,
}));
vi.mock("../../settings-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../settings-store")>()),
  loadChannelsSettings: () => {
    if (rules.broken) throw new Error("CHANNELS_SETTINGS_READ_FAILED");
    return { wechat: rules.current };
  },
}));
vi.mock("electron", () => ({ app: { getPath: () => "/synthetic/wechat-gate" } }));
vi.mock("../../../logger", () => ({ logger: { info() {}, warn() {}, error() {} }, LogTag: {} }));

function inbound(overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return { msgId: "m-1", fromUserId: "stranger@im.wechat", toUserId: "bot", msgType: 1, content: "hi", items: [], contextToken: "ctx", raw: {}, ...overrides };
}

function setup() {
  const adapter = new ILinkBotAdapter();
  const delivered: string[] = [];
  adapter.onMessage = async (message) => { delivered.push(message.senderId); return null; };
  return { adapter, delivered, push: (msg: WeixinMessage) => (adapter as any).dispatchInbound(msg) as Promise<void> };
}

beforeEach(() => {
  pendingSenders.clear();
  rules.broken = false;
  rules.current = { enabled: true, allowAnyPrivate: false, allowedSenderIds: [] };
});
afterEach(() => pendingSenders.clear());

describe("WeChat sender gate", () => {
  it("holds a first-time sender for approval instead of dispatching", async () => {
    const { delivered, push } = setup();
    await push(inbound());
    expect(delivered).toEqual([]);
    expect(pendingSenders.list("wechat").map((item) => item.senderId)).toEqual(["stranger@im.wechat"]);
  });

  it("does not remember a reply context for a held sender", async () => {
    const { adapter, push } = setup();
    await push(inbound());
    expect((adapter as any).replyContextByTarget.has("stranger@im.wechat")).toBe(false);
  });

  it("dispatches an approved sender and leaves the pending list alone", async () => {
    rules.current = { enabled: true, allowAnyPrivate: false, allowedSenderIds: ["stranger@im.wechat"] };
    const { delivered, push } = setup();
    await push(inbound());
    expect(delivered).toEqual(["stranger@im.wechat"]);
    expect(pendingSenders.list("wechat")).toEqual([]);
  });

  it("dispatches everyone when allow-all is on", async () => {
    rules.current = { enabled: true, allowAnyPrivate: true, allowedSenderIds: [] };
    const { delivered, push } = setup();
    await push(inbound({ fromUserId: "anyone@im.wechat" }));
    expect(delivered).toEqual(["anyone@im.wechat"]);
  });

  it("fails closed when the settings cannot be read", async () => {
    rules.broken = true;
    const { delivered, push } = setup();
    await push(inbound());
    expect(delivered).toEqual([]);
  });
});
