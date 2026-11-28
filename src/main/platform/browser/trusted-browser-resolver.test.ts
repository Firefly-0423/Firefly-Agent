import { afterEach, describe, expect, it, vi } from "vitest";
import { createSocket } from "node:dgram";
import { connect } from "node:net";
import { once } from "node:events";
import { getServers } from "node:dns/promises";
import { createTrustedBrowserResolver, createTrustedBrowserProxyFactory } from "./trusted-browser-resolver";
import { startAuthenticatedConnectProxy, type ConnectProxy } from "./authenticated-connect-proxy";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
type Reply = { addresses?: string[]; rcode?: number; hold?: boolean };
async function dnsFixture(reply: (family: 4 | 6, name: string) => Reply) {
  const server = createSocket("udp4"), queries: Array<{ family: 4 | 6; name: string; send: () => void }> = [];
  server.on("message", (query, peer) => {
    let offset = 12; const labels: string[] = [];
    while (query[offset]) { const length = query[offset++]; labels.push(query.subarray(offset, offset + length).toString()); offset += length; }
    const end = offset + 5, family: 4 | 6 = query.readUInt16BE(offset + 1) === 1 ? 4 : 6;
    const result = reply(family, labels.join("."));
    const records = (result.addresses ?? []).map(address => {
      const data = family === 4 ? Buffer.from(address.split(".").map(Number)) : Buffer.from(address.replaceAll(":", ""), "hex");
      const record = Buffer.alloc(12); record.writeUInt16BE(0xc00c); record.writeUInt16BE(family === 4 ? 1 : 28, 2);
      record.writeUInt16BE(1, 4); record.writeUInt32BE(60, 6); record.writeUInt16BE(data.length, 10);
      return Buffer.concat([record, data]);
    });
    const header = Buffer.alloc(12); header.writeUInt16BE(query.readUInt16BE(0)); header.writeUInt16BE(0x8180 | (result.rcode ?? 0), 2);
    header.writeUInt16BE(1, 4); header.writeUInt16BE(records.length, 6);
    const response = Buffer.concat([header, query.subarray(12, end), ...records]);
    const entry = { family, name: labels.join("."), send: () => server.send(response, peer.port, peer.address) };
    queries.push(entry); if (!result.hold) entry.send();
  });
  server.bind(0, "127.0.0.1"); await once(server, "listening");
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  return { config: { server: "127.0.0.1", port: server.address().port }, queries };
}
async function connectRequest(proxy: ConnectProxy, host = "example.com") {
  const c = proxy.credentialsFor({ ...proxy.endpoint, isProxy: true, scheme: "basic", webContentsId: 77 });
  if (!c) throw Error("fixture credentials missing");
  const socket = connect({ host: proxy.endpoint.host, port: proxy.endpoint.port });
  socket.on("error", () => {}); cleanups.push(() => { socket.destroy(); }); await once(socket, "connect");
  const response = new Promise<string>(resolve => { let value = ""; socket.on("data", data => { value += data; if (value.includes("\r\n\r\n")) resolve(value); }); socket.once("close", () => resolve(value || "closed")); });
  socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Authorization: Basic ${Buffer.from(`${c.username}:${c.password}`).toString("base64")}\r\n\r\n`);
  return { socket, response };
}
function resolver(config: { server: string; port: number }) {
  const owner = new AbortController(), r = createTrustedBrowserResolver(config, owner.signal);
  cleanups.push(() => r.dispose()); return { r, owner };
}
const public4 = "93.184.216.34", public6 = "2606:4700:0000:0000:0000:0000:0000:1111";

describe("trusted Main resolver using actual independent Node DNS/UDP", () => {
  it("collects complete A and AAAA without mutating the global resolver", async () => {
    const before = getServers(), dns = await dnsFixture(family => ({ addresses: family === 4 ? [public4, "8.8.8.8"] : [public6] }));
    const { r } = resolver(dns.config);
    expect(await r.resolve("example.com")).toEqual([{ address: public4, family: 4 }, { address: "8.8.8.8", family: 4 }, { address: "2606:4700::1111", family: 6 }]);
    expect(dns.queries.map(q => q.family).sort()).toEqual([4, 6]); expect(getServers()).toEqual(before);
  });
  it.each([4, 6] as const)("only ENODATA permits the absent family %s", async absent => {
    const dns = await dnsFixture(family => ({ addresses: family === absent ? [] : [family === 4 ? public4 : public6] }));
    expect(await resolver(dns.config).r.resolve("example.com")).toEqual([{ address: absent === 4 ? "2606:4700::1111" : public4, family: absent === 4 ? 6 : 4 }]);
  });
  it.each([{ rcode: 3, code: "ENOTFOUND" }, { rcode: 2, code: "ESERVFAIL" }, { rcode: 5, code: "EREFUSED" }])("fails closed on $code even with successful A", async ({ rcode, code }) => {
    const dns = await dnsFixture(family => family === 4 ? { addresses: [public4] } : { rcode });
    await expect(resolver(dns.config).r.resolve("example.com")).rejects.toMatchObject({ code });
  });
  it("waits for delayed AAAA before exposing A or permitting any dial", async () => {
    const dns = await dnsFixture(family => family === 4 ? { addresses: [public4] } : { addresses: [public6], hold: true });
    const { r } = resolver(dns.config); let settled = false; const pending = r.resolve("example.com").finally(() => { settled = true; });
    await vi.waitFor(() => expect(dns.queries).toHaveLength(2)); expect(settled).toBe(false);
    dns.queries.find(q => q.family === 6)!.send(); expect(await pending).toHaveLength(2);
  });
  it.each(["10.0.0.1", "198.18.0.1"])("mixed public/%s DNS has zero upstream dial through real CONNECT", async privateAddress => {
    const dns = await dnsFixture(family => ({ addresses: family === 4 ? [public4, privateAddress] : [] })), { r, owner } = resolver(dns.config);
    const dial = vi.fn(() => { throw Error("must not dial"); });
    const proxy = await startAuthenticatedConnectProxy({ webContentsId: 77, signal: owner.signal }, { resolve: r.resolve, connect: dial }); cleanups.push(() => proxy.revoke());
    const request = await connectRequest(proxy); expect(await request.response).toContain("403"); expect(dial).not.toHaveBeenCalled();
  });
  it.each(["fd00:0000:0000:0000:0000:0000:0000:0001", "0000:0000:0000:0000:0000:ffff:0808:0808"])("private/mapped AAAA %s in a complete answer forbids dial", async address => {
    const dns = await dnsFixture(family => ({ addresses: family === 4 ? [public4] : [address] })), { r, owner } = resolver(dns.config);
    const dial = vi.fn(() => { throw Error("must not dial"); });
    const proxy = await startAuthenticatedConnectProxy({ webContentsId: 77, signal: owner.signal }, { resolve: r.resolve, connect: dial }); cleanups.push(() => proxy.revoke());
    expect(await (await connectRequest(proxy)).response).toContain("403"); expect(dial).not.toHaveBeenCalled();
  });
  it("owner cancellation cancels both native queries; late responses cannot reopen", async () => {
    const dns = await dnsFixture(() => ({ hold: true })), { r, owner } = resolver(dns.config);
    const pending = r.resolve("example.com"); const rejected = expect(pending).rejects.toMatchObject({ code: "ECANCELLED" });
    await vi.waitFor(() => expect(dns.queries).toHaveLength(2)); owner.abort(); await rejected;
    dns.queries.forEach(q => q.send()); await expect(r.resolve("later.example")).rejects.toMatchObject({ code: "ECANCELLED" }); expect(dns.queries).toHaveLength(2);
  });
  it("one binding cancellation leaves another binding's native queries intact", async () => {
    const dns = await dnsFixture((_family, name) => ({ addresses: [], hold: name === "held.example" }));
    const first = resolver(dns.config), next = resolver(dns.config); const pending = first.r.resolve("held.example");
    const rejected = expect(pending).rejects.toMatchObject({ code: "ECANCELLED" }); await vi.waitFor(() => expect(dns.queries).toHaveLength(2)); first.owner.abort(); await rejected;
    expect(await next.r.resolve("fresh.example")).toEqual([]);
  });
  it("native timeout fails the whole result despite a successful A; no fallback", async () => {
    const dns = await dnsFixture(family => family === 4 ? { addresses: [public4] } : { hold: true });
    await expect(resolver(dns.config).r.resolve("example.com")).rejects.toMatchObject({ code: "ETIMEOUT" });
    expect(dns.queries.every(q => q.name === "example.com")).toBe(true);
  }, 10000);
  it.each(["example.com", "http://192.168.31.1", "192.168.31.1:53", "", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::", "ff02::1"])("rejects invalid trusted server %s", server => {
    expect(() => resolver({ server, port: 53 })).toThrow("browser DNS configuration unavailable");
  });
  it.each([0, -1, 65536, 53.5, NaN])("rejects invalid trusted port %s", port => {
    expect(() => resolver({ server: "192.168.31.1", port })).toThrow("browser DNS configuration unavailable");
  });
  it("pre-aborted owner allocates no native DNS or proxy listener", async () => {
    const owner = new AbortController(); owner.abort();
    const factory = createTrustedBrowserProxyFactory({ server: "192.168.31.1", port: 53 });
    await expect(factory({ webContentsId: 77, signal: owner.signal })).rejects.toMatchObject({ code: "ECANCELLED" });
  });
  it("explicit proxy revoke cancels actual resolver work even without owner abort", async () => {
    const dns = await dnsFixture(() => ({ hold: true })), owner = new AbortController();
    const factory = createTrustedBrowserProxyFactory(dns.config), proxy = await factory({ webContentsId: 77, signal: owner.signal }); cleanups.push(() => proxy.revoke());
    const request = await connectRequest(proxy); await vi.waitFor(() => expect(dns.queries).toHaveLength(2));
    await proxy.revoke(); expect(await request.response).not.toContain("200"); expect(owner.signal.aborted).toBe(false);
  });
  it("snapshots explicit Main config; later mutation cannot redirect resolver traffic", async () => {
    const dns = await dnsFixture(family => ({ addresses: family === 4 ? ["10.0.0.1"] : [] }));
    const factory = createTrustedBrowserProxyFactory(dns.config); dns.config.server = "invalid-renderer.example"; dns.config.port = 0;
    const proxy = await factory({ webContentsId: 77, signal: new AbortController().signal }); cleanups.push(() => proxy.revoke());
    expect(await (await connectRequest(proxy)).response).toContain("403"); expect(dns.queries.map(q => q.family).sort()).toEqual([4, 6]);
  });
});

it("the production trusted resolver factory preserves exact host scope before native DNS", async () => {
  // Private synthetic answers deliberately stop any allowed-host test before a TCP dial.
  const dns = await dnsFixture(family => ({ addresses: family === 4 ? ["10.0.0.1"] : [] }));
  const proxy = await createTrustedBrowserProxyFactory(dns.config)({ webContentsId: 77, signal: new AbortController().signal, allowedHosts: ["allowed.example"] });
  cleanups.push(() => proxy.revoke());
  expect(await (await connectRequest(proxy, "unapproved.example")).response).toContain("HTTP/1.1 403 Blocked\r\n");
  expect(dns.queries).toHaveLength(0);
  expect(await (await connectRequest(proxy, "allowed.example")).response).toContain("HTTP/1.1 403 Blocked\r\n");
  expect(dns.queries.map(query => query.name)).toEqual(["allowed.example", "allowed.example"]);
});
