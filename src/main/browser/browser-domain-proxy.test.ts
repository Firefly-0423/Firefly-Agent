import { createServer, connect, type Socket } from "node:net";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createBrowserAuthorizationDomainRegistry } from "./browser-authorization-domain";
import { startBrowserDomainProxy } from "./browser-domain-proxy";
import { startAuthenticatedConnectProxy, type ConnectProxy } from "./authenticated-connect-proxy";

function setup(policy?: { hosts: readonly string[]; resourceHosts?: readonly string[] }) {
  const session = {}, abort = new AbortController();
  const registry = createBrowserAuthorizationDomainRegistry({ gateOpen: true, isOwnerCurrent: () => true });
  const domain = registry.create({ owner: {}, profile: {}, conversationId: "c", browserId: "b", generation: 0, signal: abort.signal }, session, policy)!;
  const contents = { id: 17, session, isDestroyed: () => false };
  domain.registerContents(contents);
  return { domain, contents, abort };
}
function proxy() {
  return { endpoint: { host: "127.0.0.1" as const, port: 12345, realm: "test" }, credentialsFor: vi.fn(() => ({ username: "u", password: "p" })), revoke: vi.fn(async () => {}) };
}
describe("domain proxy adapter", () => {
  it("passes an immutable exact-host scope without expanding the Agent policy", async () => {
    const hosts = ["github.com"];
    const { domain, contents } = setup({ hosts });
    const raw = proxy();
    const factory = vi.fn(async (_owner: { allowedHosts?: readonly string[] }) => raw);
    const scoped = await startBrowserDomainProxy(domain, contents, factory);
    hosts.push("foreign.example");
    expect(factory.mock.calls[0][0].allowedHosts).toEqual(["github.com"]);
    expect(Object.isFrozen(factory.mock.calls[0][0].allowedHosts)).toBe(true);
    await scoped.revoke();
  });
  it("passes an explicit empty host policy as deny-all", async () => {
    const { domain, contents } = setup({ hosts: [] });
    const factory = vi.fn(async () => proxy());
    const scoped = await startBrowserDomainProxy(domain, contents, factory);
    expect(factory).toHaveBeenCalledWith({ webContentsId: 17, signal: domain.signal, allowedHosts: [] });
    await scoped.revoke();
  });
  it("starts with registered native identity and denies credentials before activation", async () => {
    const { domain, contents } = setup(), raw = proxy(), factory = vi.fn(async () => raw);
    const scoped = await startBrowserDomainProxy(domain, contents, factory);
    expect(factory).toHaveBeenCalledWith({ webContentsId: 17, signal: domain.signal });
    const challenge = { isProxy: true, host: "127.0.0.1", port: 12345, realm: "test", scheme: "basic" };
    expect(scoped.credentialsFor(contents, challenge)).toBeNull();
    domain.activate();
    expect(scoped.credentialsFor(contents, challenge)).toEqual({ username: "u", password: "p" });
    expect(scoped.credentialsFor(undefined, challenge)).toBeNull();
    expect(scoped.credentialsFor({ ...contents }, challenge)).toBeNull();
    expect(raw.credentialsFor).toHaveBeenCalledTimes(1);
    expect(raw.credentialsFor).toHaveBeenCalledWith({ ...challenge, webContentsId: 17 });
    const closing = scoped.revoke();
    expect(domain.signal.aborted).toBe(true);
    expect(scoped.credentialsFor(contents, challenge)).toBeNull();
    expect(scoped.revoke()).toBe(closing);
    await closing;
    expect(raw.revoke).toHaveBeenCalledTimes(1);
  });
  it("does not start for missing, foreign or revoked native contents", async () => {
    const { domain, contents } = setup(), factory = vi.fn(async () => proxy());
    await expect(startBrowserDomainProxy(domain, { ...contents }, factory)).rejects.toThrow();
    domain.revoke();
    await expect(startBrowserDomainProxy(domain, contents, factory)).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
  });
  it("reclaims a proxy which resolves after cancellation", async () => {
    const { domain, contents, abort } = setup(), raw = proxy();
    let resolve!: (value: ConnectProxy) => void;
    const pending = startBrowserDomainProxy(domain, contents, () => new Promise<ConnectProxy>((done) => { resolve = done; }));
    const rejected = expect(pending).rejects.toThrow();
    abort.abort(); resolve(raw); await rejected;
    expect(raw.revoke).toHaveBeenCalledTimes(1);
  });
  it("executes the real proxy challenge checks through the adapter without DNS/dial", async () => {
    const { domain, contents } = setup();
    const scoped = await startBrowserDomainProxy(domain, contents, (owner) => startAuthenticatedConnectProxy(owner, {
      resolve: vi.fn(async () => { throw new Error("unexpected DNS"); }), connect: () => { throw new Error("unexpected dial"); },
    }));
    domain.activate();
    const good = { isProxy: true, host: scoped.endpoint.host, port: scoped.endpoint.port, realm: scoped.endpoint.realm, scheme: "basic" };
    try {
      expect(scoped.credentialsFor(contents, good)).not.toBeNull();
      for (const patch of [{ isProxy: false }, { host: "localhost" }, { port: good.port + 1 }, { realm: "other" }, { scheme: "digest" }]) {
        expect(scoped.credentialsFor(contents, { ...good, ...patch })).toBeNull();
      }
      expect(scoped.credentialsFor(undefined, good)).toBeNull();
    } finally { await scoped.revoke(); }
  });
});

it("connects confirmed resource hosts through the real CONNECT policy while denying resource navigation and unapproved hosts", async () => {
  const hosts = ["example.com"], resourceHosts = ["assets.example.com", "example.com", "assets.example.com"];
  const { domain, contents } = setup({ hosts, resourceHosts });
  const peers = new Set<Socket>(), clients = new Set<Socket>();
  const origin = createServer(socket => {
    peers.add(socket); socket.on("error", () => {});
    socket.on("close", () => peers.delete(socket)); socket.on("data", bytes => socket.write(bytes));
  });
  origin.listen(0, "127.0.0.1"); await once(origin, "listening");
  const originAddress = origin.address();
  if (!originAddress || typeof originAddress === "string") throw new Error("fixture address missing");
  const resolve = vi.fn(async (_host: string) => [{ address: "93.184.216.34", family: 4 as const }]);
  const dial = vi.fn((target: { address: string; family: number; port: number }) => {
    const socket = connect({ host: "127.0.0.1", port: originAddress.port });
    Object.defineProperty(socket, "remoteAddress", { get: () => target.address });
    return socket;
  });
  let scoped: Awaited<ReturnType<typeof startBrowserDomainProxy>> | undefined;
  try {
    scoped = await startBrowserDomainProxy(domain, contents, owner => startAuthenticatedConnectProxy(owner, { resolve, connect: dial }));
    domain.activate(); resourceHosts.push("foreign.example");
    const credentials = scoped.credentialsFor(contents, { isProxy: true, host: scoped.endpoint.host, port: scoped.endpoint.port, realm: scoped.endpoint.realm, scheme: "basic" })!;
    const auth = Buffer.from(credentials.username + ":" + credentials.password).toString("base64");
    async function request(host: string) {
      const socket = connect({ host: scoped!.endpoint.host, port: scoped!.endpoint.port });
      clients.add(socket); socket.on("error", () => {}); await once(socket, "connect");
      const response = new Promise<string>((done, reject) => {
        let text = "";
        socket.on("data", bytes => { text += bytes.toString(); if (text.includes("\r\n\r\n")) done(text); });
        socket.once("close", () => { if (!text) reject(new Error("closed without response")); });
      });
      socket.write("CONNECT " + host + ":443 HTTP/1.1\r\nHost: " + host + ":443\r\nProxy-Authorization: Basic " + auth + "\r\n\r\n");
      return response;
    }
    expect(await request("example.com")).toContain("200 Connection Established");
    expect(await request("assets.example.com")).toContain("200 Connection Established");
    expect(resolve.mock.calls.map(([host]) => host)).toEqual(["example.com", "assets.example.com"]);
    expect(dial.mock.calls.map(([target]) => target)).toEqual([
      { address: "93.184.216.34", family: 4, port: 443 }, { address: "93.184.216.34", family: 4, port: 443 },
    ]);
    for (const host of ["foreign.example", "sub.assets.example.com", "assets.example.com.evil.example"]) {
      expect(await request(host)).toContain("403");
    }
    expect(resolve).toHaveBeenCalledTimes(2); expect(dial).toHaveBeenCalledTimes(2);
    const details = { url: "https://assets.example.com/resource", method: "GET", webContentsId: contents.id };
    expect(domain.allows({ ...details, resourceType: "script" })).toBe(true);
    expect(domain.allows({ ...details, resourceType: "mainFrame" })).toBe(false);
    expect(domain.allows({ ...details, resourceType: "subFrame" })).toBe(false);
  } finally {
    clients.forEach(socket => socket.destroy());
    await scoped?.revoke();
    peers.forEach(socket => socket.destroy());
    await new Promise<void>(done => origin.close(() => done()));
  }
});
