import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeishuAdapter } from "./index";
import { pendingSenders } from "../../sender-gate";

const fixture = vi.hoisted(() => ({
  createChannel: vi.fn(),
  settings: { enabled: true, appId: "app-a", appSecret: "synthetic", allowAnyPrivate: false, allowedSenderIds: [] as string[] },
}));
vi.mock("@larksuiteoapi/node-sdk", () => ({ createLarkChannel: fixture.createChannel, Domain: { Feishu: "feishu" }, LoggerLevel: { warn: 1 } }));
vi.mock("../../settings-store", () => ({ loadChannelsSettings: () => ({ feishu: fixture.settings }) }));
vi.mock("electron", () => ({ app: { getPath: () => "/synthetic/feishu-gate" } }));
vi.mock("../../../logger", () => ({ logger: { info() {}, warn() {}, error() {} }, LogTag: {} }));

class Channel extends EventEmitter {
  async connect() {}
  async disconnect() {}
  getConnectionStatus() { return { state: "connected" }; }
}

const adapters: FeishuAdapter[] = [];
let channel: Channel;

async function connected() {
  const adapter = new FeishuAdapter();
  adapters.push(adapter);
  const delivered: string[] = [];
  adapter.onMessage = async (message) => { delivered.push(message.senderId); return null; };
  await adapter.start();
  return { delivered };
}

const message = (senderId: string, senderName?: string) => ({
  chatType: "p2p", chatId: "chat", senderId, senderName, messageId: `m-${senderId}`, content: '{"text":"hi"}', rawContentType: "text",
});

beforeEach(() => {
  pendingSenders.clear();
  Object.assign(fixture.settings, { allowAnyPrivate: false, allowedSenderIds: [] });
  fixture.createChannel.mockImplementation(() => { channel = new Channel(); return channel; });
});
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.stop();
  pendingSenders.clear();
});

describe("Feishu sender gate", () => {
  it("holds a first-time sender with their display name", async () => {
    const { delivered } = await connected();
    channel.emit("message", message("ou_stranger", "陌生人"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(delivered).toEqual([]);
    expect(pendingSenders.list("feishu")).toMatchObject([{ senderId: "ou_stranger", senderName: "陌生人" }]);
  });

  it("dispatches an approved sender", async () => {
    fixture.settings.allowedSenderIds = ["ou_friend"];
    const { delivered } = await connected();
    channel.emit("message", message("ou_friend"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(delivered).toEqual(["ou_friend"]);
    expect(pendingSenders.list("feishu")).toEqual([]);
  });

  it("dispatches everyone when allow-all is on", async () => {
    fixture.settings.allowAnyPrivate = true;
    const { delivered } = await connected();
    channel.emit("message", message("ou_anyone"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(delivered).toEqual(["ou_anyone"]);
  });
});
