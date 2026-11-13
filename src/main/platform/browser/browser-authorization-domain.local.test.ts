import { describe, expect, it } from "vitest";
import { createBrowserAuthorizationDomainRegistry, type BrowserDomainPolicy } from "./browser-authorization-domain";

function ready(policy?: BrowserDomainPolicy) {
  const owner = {}, profile = {}, session = {}, cancellation = new AbortController();
  const context = { owner, profile, conversationId: null, workspaceId: "workspace", browserId: "browser", generation: 0, signal: cancellation.signal };
  const registry = createBrowserAuthorizationDomainRegistry<object>({ gateOpen: true, isOwnerCurrent: input => input.owner === owner && input.profile === profile });
  const domain = registry.create(context, session, policy);
  if (domain) { domain.registerContents({ id: 7, session, isDestroyed: () => false }); domain.activate(); }
  return { registry, context, session, domain };
}
const req = (url: string, resourceType = "xhr", method = "GET") => ({ url, method, resourceType, webContentsId: 7 });

describe("private-network authorization domain", () => {
  it("admits only the granted host:port, and same-host resource ports", () => {
    const { domain } = ready({ hosts: ["192.168.1.5:5173"], resourceHosts: ["192.168.1.5:3000"] });
    expect(domain).not.toBeNull();
    expect(domain!.allows(req("http://192.168.1.5:5173/", "mainFrame"))).toBe(true);
    expect(domain!.allows(req("https://192.168.1.5:5173/app.js", "script"))).toBe(true);
    expect(domain!.allows(req("http://192.168.1.5:3000/api", "xhr"))).toBe(true);
    // a resource port is never a navigation target
    expect(domain!.allows(req("http://192.168.1.5:3000/", "mainFrame"))).toBe(false);
    for (const url of ["http://192.168.1.5:22/", "http://192.168.1.6:5173/", "http://localhost:5173/", "http://127.0.0.1:5173/",
      "http://169.254.169.254/", "https://example.com/", "http://192.168.1.5:5173@evil.com/"]) {
      expect(domain!.allows(req(url, "mainFrame")), url).toBe(false);
      expect(domain!.allows(req(url, "xhr")), url).toBe(false);
    }
  });

  it("allows same-host WebSocket only with a socket scheme and the WebSocket resource type", () => {
    const { domain } = ready({ hosts: ["localhost:5173"] });
    expect(domain!.allows(req("ws://localhost:5173/", "webSocket"))).toBe(true);
    expect(domain!.allows(req("ws://localhost:5173/", "xhr"))).toBe(false);
    expect(domain!.allows(req("http://localhost:5173/", "webSocket"))).toBe(false);
    expect(domain!.allows(req("ws://localhost:9999/", "webSocket"))).toBe(false);
    expect(domain!.allows(req("ws://example.com/", "webSocket"))).toBe(false);
  });

  it("keeps GET/HEAD only, and the owner webContents only", () => {
    const { domain } = ready({ hosts: ["localhost:5173"] });
    expect(domain!.allows(req("http://localhost:5173/", "xhr", "HEAD"))).toBe(true);
    expect(domain!.allows(req("http://localhost:5173/", "xhr", "POST"))).toBe(false);
    expect(domain!.allows({ ...req("http://localhost:5173/"), webContentsId: 8 })).toBe(false);
  });

  it("never lets a private grant reach the public network, or a public grant reach a private address", () => {
    const priv = ready({ hosts: ["localhost:5173"] }).domain!, pub = ready({ hosts: ["example.com"] }).domain!;
    expect(priv.allows(req("https://example.com/", "mainFrame"))).toBe(false);
    expect(pub.allows(req("https://example.com/", "mainFrame"))).toBe(true);
    for (const url of ["http://localhost:5173/", "http://127.0.0.1/", "http://192.168.1.5/", "https://192.168.1.5/", "ws://localhost:5173/"]) {
      expect(pub.allows(req(url, "mainFrame")), url).toBe(false);
      expect(pub.allows(req(url, "webSocket")), url).toBe(false);
    }
  });

  it("denies private targets when no host policy was supplied", () => {
    const { domain } = ready();
    expect(domain!.allows(req("https://example.com/", "mainFrame"))).toBe(true);
    expect(domain!.allows(req("http://localhost:5173/", "mainFrame"))).toBe(false);
  });

  it("refuses malformed or mixed-class policies", () => {
    const base = ready().registry, { context, session } = ready();
    const make = (policy: BrowserDomainPolicy) => ready(policy).domain;
    expect(make({ hosts: ["localhost:5173", "localhost:3000"] })).toBeNull(); // one primary only
    expect(make({ hosts: ["localhost:5173"], resourceHosts: ["127.0.0.1:3000"] })).toBeNull(); // other host
    expect(make({ hosts: ["localhost:5173"], resourceHosts: ["example.com"] })).toBeNull(); // public resource
    expect(make({ hosts: ["example.com"], resourceHosts: ["localhost:3000"] })).toBeNull(); // private resource
    expect(make({ hosts: ["169.254.169.254:80"] })).toBeNull();
    expect(make({ hosts: ["localhost"] })).toBeNull(); // no port: not a public host either
    expect(make({ hosts: ["localhost:5173"], resourceHosts: ["localhost:5173", "localhost:5174"] })).not.toBeNull();
    expect(base.canPrepare(context, { hosts: ["10.0.0.1:80"] })).toBe(false); // foreign owner for this registry
    void session;
  });

  it("revokes immediately and stays revoked", () => {
    const { domain } = ready({ hosts: ["localhost:5173"] });
    expect(domain!.allows(req("http://localhost:5173/", "mainFrame"))).toBe(true);
    domain!.revoke();
    expect(domain!.allows(req("http://localhost:5173/", "mainFrame"))).toBe(false);
  });

  it("web policy admits any public HTTPS page with ordinary methods and resource kinds", () => {
    const { domain } = ready({ web: true });
    expect(domain).not.toBeNull();
    for (const url of ["https://news.example/", "https://cdn.other.example/app.js?x=1", "https://8.8.8.8/"]) {
      for (const resourceType of ["mainFrame", "subFrame", "script", "image", "xhr", "ping", "other"]) expect(domain!.allows(req(url, resourceType)), `${resourceType} ${url}`).toBe(true);
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) expect(domain!.allows(req("https://api.example/x", "xhr", method)), method).toBe(true);
    expect(domain!.allows(req("wss://sock.example/live", "webSocket"))).toBe(true);
  });

  it("web policy still refuses everything that is not a public HTTPS target", () => {
    const { domain } = ready({ web: true });
    for (const url of ["http://news.example/", "ws://news.example/", "https://news.example:8443/", "https://user:pw@news.example/",
      "https://localhost/", "https://127.0.0.1/", "https://192.168.1.5/", "https://10.0.0.1/", "https://169.254.169.254/", "https://[::1]/",
      "http://localhost:5173/", "http://192.168.1.5:80/", "ws://localhost:5173/", "ftp://news.example/", "file:///C:/x"]) {
      expect(domain!.allows(req(url, "mainFrame")), url).toBe(false);
      expect(domain!.allows(req(url, "xhr", "POST")), url).toBe(false);
      expect(domain!.allows(req(url, "webSocket")), url).toBe(false);
    }
    // a socket scheme only with the socket resource, and the socket resource only with a socket scheme
    expect(domain!.allows(req("wss://sock.example/", "xhr"))).toBe(false);
    expect(domain!.allows(req("https://sock.example/", "webSocket"))).toBe(false);
  });

  it("web policy cannot be combined with host lists, and list policies keep read-only methods", () => {
    expect(ready({ web: true, hosts: ["example.com"] }).domain).toBeNull();
    expect(ready({ web: true, resourceHosts: ["example.com"] }).domain).toBeNull();
    const listed = ready({ hosts: ["example.com"] }).domain!;
    expect(listed.allows(req("https://example.com/", "xhr", "POST"))).toBe(false);
    expect(listed.allows(req("wss://example.com/", "webSocket"))).toBe(false);
    expect(listed.allows(req("https://example.com/", "ping"))).toBe(false);
    expect(Object.isFrozen(ready({ web: true }).domain!.epoch.policy)).toBe(true);
  });

  it("keeps the public policy shape for public grants", () => {
    const { domain } = ready({ hosts: ["example.com"] });
    expect(domain!.epoch.policy.resources).not.toContain("webSocket");
    expect(ready({ hosts: ["localhost:5173"] }).domain!.epoch.policy.resources).toContain("webSocket");
  });
});
