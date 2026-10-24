import { afterEach, it, expect, vi } from "vitest";
import { once } from "node:events";
import * as http from "node:http";
import { WebSocket } from "ws";
import { OneBotReverseWsServer, resolveOneBotListenHost, isLoopbackHost, type OneBotReverseWsOptions } from "./onebot-reverse-ws";

const listeners: OneBotReverseWsServer[] = [];
const peers: WebSocket[] = [];
afterEach(async () => {
  peers.splice(0).forEach(socket => socket.terminate());
  for (const server of listeners.splice(0)) await server.stop();
});
async function listen(options: Partial<OneBotReverseWsOptions> = {}) {
  const onClientConnected = vi.fn();
  const server = new OneBotReverseWsServer({ listenMode: "loopback", port: 0, onEvent: vi.fn(), onClientConnected, ...options });
  listeners.push(server);
  return { server, info: await server.start(), onClientConnected };
}
function connect(url: string, id: string, authorization?: string) {
  const socket = new WebSocket(url, { headers: { "X-Self-ID": id, ...(authorization ? { Authorization: authorization } : {}) } });
  peers.push(socket);
  return socket;
}

it("resolves explicit loopback, detected WSL and automatic fallback addresses", () => {
  expect(resolveOneBotListenHost("loopback", undefined, {})).toStrictEqual({ resolvedMode: "loopback", host: "127.0.0.1" });
  expect(resolveOneBotListenHost("auto", undefined, {})).toStrictEqual({ resolvedMode: "loopback", host: "127.0.0.1" });
  const interfaces = { "Contract WSL adapter": [{ address: "172.29.32.1", netmask: "255.255.255.0", family: "IPv4", mac: "10:20:30:40:50:60", internal: false, cidr: "172.29.32.1/24" }] };
  expect(resolveOneBotListenHost("wsl", undefined, interfaces)).toStrictEqual({ host: "172.29.32.1", resolvedMode: "wsl" });
});

it.each([
  ["localhost", true], ["127.0.0.1", true], ["[::1]", true], ["::1", true], ["::ffff:127.0.0.1", true],
  ["::", false], ["0.0.0.0", false], ["192.168.45.7", false], ["172.29.32.1", false],
])("classifies listen address %s", (host, local) => {
  expect(isLoopbackHost(host as string)).toEqual(local);
});

it.each(["::", "192.168.45.7", "0.0.0.0"])("refuses unauthenticated listening at %s", async customHost => {
  const server = new OneBotReverseWsServer({ listenMode: "custom", customHost, port: 0, onEvent: vi.fn(), onClientConnected: vi.fn() });
  await expect(server.start()).rejects.toThrow(/Access Token/);
});

it("allows a custom loopback listener without a token", async () => {
  const { info } = await listen({ listenMode: "custom", customHost: "127.0.0.1" });
  expect(info.host).toEqual("127.0.0.1");
});

it("shuts down promptly despite an idle HTTP keep-alive connection", async () => {
  const { server, info } = await listen();
  const agent = new http.Agent({ keepAlive: true });
  try {
    await new Promise<void>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: info.port, path: "/", agent }, response => {
        expect(response.statusCode).toEqual(404);
        response.resume(); response.once("end", resolve);
      }).once("error", reject);
    });
    const start = Date.now();
    await server.stop();
    expect(Date.now() - start).toBeLessThan(2000);
  } finally { agent.destroy(); }
});

it("accepts an account identified over an unauthenticated loopback connection", async () => {
  const { info, onClientConnected } = await listen();
  await once(connect(info.url, "31415"), "open");
  expect(onClientConnected).toHaveBeenCalledTimes(1);
});

async function denied(url: string, authorization?: string) {
  const socket = connect(url, "31415", authorization);
  socket.on("error", () => {});
  return new Promise<number>(resolve => {
    socket.once("unexpected-response", (_request, response) => {
      response.resume(); socket.terminate(); resolve(response.statusCode ?? 0);
    });
  });
}

it("requires a matching Authorization bearer token and rejects query-only credentials", async () => {
  const { info, onClientConnected } = await listen({ accessToken: "reverse-contract-token" });
  expect(await denied(info.url, "Bearer incorrect-token")).toEqual(401);
  expect(await denied(info.url + "?access_token=reverse-contract-token")).toEqual(401);
  await once(connect(info.url, "31415", "Bearer reverse-contract-token"), "open");
  expect(onClientConnected).toHaveBeenCalledTimes(1);
});

it("keeps the first account, rejects another account and permits same-account reconnection", async () => {
  const { info } = await listen();
  const first = connect(info.url, "31415");
  await once(first, "open");
  const intruder = connect(info.url, "27182");
  const rejected = once(intruder, "close");
  await once(intruder, "open");
  expect((await rejected)[0]).toEqual(4003);
  expect(first.readyState).toEqual(WebSocket.OPEN);
  const replaced = once(first, "close");
  const replacement = connect(info.url, "31415");
  await once(replacement, "open");
  expect((await replaced)[0]).toEqual(4001);
  expect(replacement.readyState).toEqual(WebSocket.OPEN);
});

it("closes a silent peer with the heartbeat expiry code", async () => {
  const { info } = await listen({ heartbeatTimeoutMs: 25 });
  const socket = connect(info.url, "31415");
  const closed = once(socket, "close");
  await once(socket, "open");
  expect((await closed)[0]).toEqual(4000);
});
