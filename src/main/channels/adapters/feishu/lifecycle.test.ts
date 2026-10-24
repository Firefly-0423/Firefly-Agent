import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeishuAdapter } from "./index";

const sdk = vi.hoisted(() => ({ createChannel: vi.fn() }));
vi.mock("@larksuiteoapi/node-sdk", () => ({ createLarkChannel: sdk.createChannel, Domain: { Feishu: "feishu" }, LoggerLevel: { warn: 1 } }));
vi.mock("../../settings-store", () => ({ loadChannelsSettings: () => ({ feishu: { enabled: true, appId: "synthetic", appSecret: "synthetic" } }) }));
vi.mock("electron", () => ({ app: { getPath: () => "/synthetic/firefly-feishu-lifecycle" } }));
vi.mock("../../../logger", () => ({ logger: { info() {}, warn() {}, error() {} }, LogTag: {} }));

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

class SyntheticChannel extends EventEmitter {
  connection = deferred();
  started = false;
  active = false;
  disconnects = 0;
  async connect() { this.started = true; await this.connection.promise; this.active = true; }
  async disconnect() { this.disconnects++; this.active = false; }
}

const adapters: FeishuAdapter[] = [];
const channels: SyntheticChannel[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  sdk.createChannel.mockImplementation(() => { const channel = new SyntheticChannel(); channels.push(channel); return channel; });
});

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.stop();
  channels.length = 0;
  vi.clearAllTimers();
  vi.useRealTimers();
});

function createAdapter() {
  const adapter = new FeishuAdapter();
  adapters.push(adapter);
  return adapter;
}

describe("FeishuAdapter lifecycle", () => {
  it("ignores a late initial connection failure after stop without retrying", async () => {
    const adapter = createAdapter();
    const starting = adapter.start();
    await Promise.resolve();
    expect(channels[0].started).toBe(true);
    await adapter.stop();
    channels[0].connection.reject(new Error("late synthetic failure"));
    await starting;
    expect(adapter.getStatus().phase).toBe("offline");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(channels).toHaveLength(1);
  });

  it("disconnects a late successful connection without changing stopped status", async () => {
    const adapter = createAdapter();
    const starting = adapter.start();
    await Promise.resolve();
    await adapter.stop();
    channels[0].connection.resolve();
    await starting;
    expect(adapter.getStatus().phase).toBe("offline");
    expect(channels[0].active).toBe(false);
  });

  it("does not connect if stopped before asynchronous startup resumes", async () => {
    const adapter = createAdapter();
    const starting = adapter.start();
    await adapter.stop();
    channels[0].connection.resolve();
    await starting;
    expect(channels[0].started).toBe(false);
    expect(adapter.getStatus().phase).toBe("offline");
  });

  it("ignores old channel events after stop and a new start", async () => {
    const adapter = createAdapter();
    const delivered: string[] = [];
    adapter.onMessage = async (message) => { delivered.push(message.text); return null; };
    const firstStart = adapter.start();
    channels[0].connection.resolve();
    await firstStart;
    await adapter.stop();
    const secondStart = adapter.start();
    channels[1].connection.resolve();
    await secondStart;
    channels[0].emit("reconnecting");
    channels[0].emit("error", new Error("old error"));
    channels[0].emit("message", { chatType: "p2p", chatId: "synthetic", senderId: "synthetic", messageId: "old-message", content: '{"text":"old message"}', rawContentType: "text" });
    await Promise.resolve();
    expect(adapter.getStatus().phase).toBe("running");
    expect(delivered).toEqual([]);
    expect(channels[1].active).toBe(true);
  });

  it("retries a current initial failure after 30 seconds and recovers", async () => {
    const adapter = createAdapter();
    const starting = adapter.start();
    channels[0].connection.reject(new Error("initial failure"));
    await starting;
    expect(adapter.getStatus().phase).toBe("error");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(channels).toHaveLength(2);
    channels[1].connection.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.getStatus().phase).toBe("running");
    expect(vi.getTimerCount()).toBe(0);
  });
});
