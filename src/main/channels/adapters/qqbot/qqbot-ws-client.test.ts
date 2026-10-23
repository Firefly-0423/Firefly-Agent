import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { QqBotWsClient, QQBOT_INTENT_GROUP_AND_C2C, type QqBotWsClientOptions } from "./qqbot-ws-client";

class GatewayPeer extends EventEmitter {
  readyState = 1;
  frames: Array<{ op: number; d?: any }> = [];
  closed = false;
  terminated = false;
  deferClose = false;
  send(wire: string) { this.frames.push(JSON.parse(wire)); }
  receive(frame: unknown) { this.emit("message", JSON.stringify(frame)); }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.deferClose) { this.readyState = 3; this.emit("close"); }
  }
  terminate() { this.terminated = true; this.readyState = 3; this.emit("close"); }
  frame(op: number) { return this.frames.find(frame => frame.op === op); }
}
const sessions: QqBotWsClient[] = [];
afterEach(async () => {
  for (const client of sessions.splice(0)) await client.stop();
  vi.useRealTimers();
});
function session(overrides: Partial<QqBotWsClientOptions> = {}) {
  const peers: GatewayPeer[] = [];
  const readiness: boolean[] = [];
  const errors: Error[] = [];
  const events: string[] = [];
  const client = new QqBotWsClient({
    gatewayUrl: "wss://gateway.invalid/contract", getAccessToken: async () => "gateway-contract-token",
    onDispatch: type => events.push(type), onReadyChange: ready => readiness.push(ready), onError: error => errors.push(error),
    websocketFactory: () => { const peer = new GatewayPeer(); peers.push(peer); return peer as never; }, ...overrides,
  });
  sessions.push(client);
  return { client, peers, readiness, errors, events };
}
const hello = (peer: GatewayPeer, interval = 30_000) => peer.receive({ op: 10, d: { heartbeat_interval: interval } });
const ready = (peer: GatewayPeer, sequence = 19, id = "contract-session") => peer.receive({ op: 0, s: sequence, t: "READY", d: { session_id: id } });

it("identifies with the QQBot bearer prefix and both message intents after Hello", async () => {
  const { client, peers } = session();
  await client.start();
  hello(peers[0]);
  expect(peers[0].frame(2)).toBeDefined();
  expect(peers[0].frame(2)?.d.token).toEqual("QQBot gateway-contract-token");
  expect(peers[0].frame(2)?.d.intents).toEqual(QQBOT_INTENT_GROUP_AND_C2C);
});

it("marks READY and forwards C2C and group dispatches in wire order", async () => {
  const { client, peers, events } = session();
  await client.start();
  hello(peers[0]); ready(peers[0]);
  expect(client.isReady).toEqual(true);
  peers[0].receive({ op: 0, t: "C2C_MESSAGE_CREATE", s: 20, d: { id: "private-20", content: "Review" } });
  peers[0].receive({ op: 0, t: "GROUP_AT_MESSAGE_CREATE", s: 21, d: { group_openid: "group-21" } });
  expect(events).toStrictEqual(["C2C_MESSAGE_CREATE", "GROUP_AT_MESSAGE_CREATE"]);
});

it.each([9, 7])("revokes readiness immediately on opcode %s while close is pending", async opcode => {
  vi.useFakeTimers();
  const { client, peers, readiness } = session();
  await client.start();
  peers[0].deferClose = true;
  ready(peers[0]);
  expect(client.isReady).toEqual(true);
  peers[0].receive({ op: opcode, d: false });
  expect(client.isReady).toEqual(false);
  expect(readiness).toStrictEqual([true, false]);
  if (opcode === 9) {
    await vi.advanceTimersByTimeAsync(2999);
    expect(peers[0].frame(2)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(peers[0].frame(2)).toBeDefined();
    expect(client.isReady).toEqual(false);
    ready(peers[0], 22, "contract-reidentified");
    expect(readiness).toStrictEqual([true, false, true]);
  }
});

it("heartbeats with the latest sequence and terminates an unacknowledged connection", async () => {
  vi.useFakeTimers();
  const { client, peers } = session();
  await client.start();
  hello(peers[0], 1000); ready(peers[0], 71);
  vi.advanceTimersByTime(1000);
  expect(peers[0].frame(1)).toMatchObject({ op: 1, d: 71 });
  vi.advanceTimersByTime(2000);
  expect(peers[0].terminated).toEqual(true);
});

it("reconnects after server opcode seven and resumes the prior session and sequence", async () => {
  vi.useFakeTimers();
  const { client, peers } = session();
  await client.start();
  hello(peers[0]); ready(peers[0], 23, "contract-resumable");
  peers[0].receive({ op: 7 });
  expect(peers[0].closed).toEqual(true);
  await vi.advanceTimersByTimeAsync(1100);
  expect(peers).toHaveLength(2);
  hello(peers[1]);
  expect(peers[1].frame(6)).toMatchObject({ op: 6, d: { token: "QQBot gateway-contract-token", session_id: "contract-resumable", seq: 23 } });
});

it("does not open a peer when token resolution arrives after stop", async () => {
  let resolve!: (value: string) => void;
  const token = new Promise<string>(done => { resolve = done; });
  const { client, peers } = session({ getAccessToken: () => token });
  const starting = client.start();
  await client.stop();
  resolve("expired-contract-token");
  await starting;
  expect(peers).toHaveLength(0);
  expect(client.isReady).toEqual(false);
});

it("ignores token rejection from a stopped generation without errors or retry timers", async () => {
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  const { client, errors } = session({ getAccessToken: () => new Promise((_, fail) => { reject = fail; }) });
  const starting = client.start();
  await client.stop();
  reject(new Error("expired credential request"));
  await starting;
  expect(errors).toStrictEqual([]);
  expect(client.getLastError()).toBeNull();
  expect(vi.getTimerCount()).toEqual(0);
});

it("clears a scheduled invalid-session identification on stop", async () => {
  vi.useFakeTimers();
  const { client, peers } = session();
  await client.start();
  peers[0].receive({ op: 9, d: false });
  expect(vi.getTimerCount()).toEqual(1);
  await client.stop();
  expect(vi.getTimerCount()).toEqual(0);
});

it("prevents an invalid-session retry from sending the old token on a replacement peer", async () => {
  vi.useFakeTimers();
  let count = 0;
  const { client, peers } = session({ getAccessToken: async () => `contract-token-${++count}` });
  await client.start();
  peers[0].receive({ op: 9, d: false }); peers[0].close();
  await vi.advanceTimersByTimeAsync(1000);
  expect(peers).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(2000);
  expect(peers[1].frames).toStrictEqual([]);
  hello(peers[1]);
  expect(peers[1].frame(2)).toMatchObject({ d: { token: "QQBot contract-token-2" } });
});

it("keeps the new generation's peer when an earlier start finishes after restart", async () => {
  let resolve!: (token: string) => void;
  const pending = new Promise<string>(done => { resolve = done; });
  let calls = 0;
  const { client, peers } = session({ getAccessToken: () => ++calls === 1 ? pending : Promise.resolve("replacement-contract-token") });
  const earlier = client.start();
  await client.stop(); await client.start();
  resolve("expired-contract-token");
  await earlier;
  expect(peers).toHaveLength(1);
  hello(peers[0]);
  expect(peers[0].frame(2)).toMatchObject({ d: { token: "QQBot replacement-contract-token" } });
});
