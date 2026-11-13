import { describe, expect, it } from "vitest";
import { createBrowserAuthorizationDomainRegistry } from "./browser-authorization-domain";
import { createBrowserRequestPolicy } from "./browser-request-policy";

function setup(gateOpen = true) {
  const owner = {}, profile = {}, session = {}, cancellation = new AbortController();
  let current = true;
  const context = { owner, profile, conversationId: "conversation", browserId: "browser", generation: 0, signal: cancellation.signal };
  const registry = createBrowserAuthorizationDomainRegistry<object>({ gateOpen, isOwnerCurrent: (input) => current && input.owner === owner && input.profile === profile && input.conversationId === "conversation" && input.browserId === "browser" && input.generation === 0 });
  const contents = { id: 19, session, isDestroyed: () => false };
  return { context, registry, session, contents, cancellation, stale: () => { current = false; } };
}
function domainReady() {
  const test = setup();
  const domain = test.registry.create(test.context, test.session);
  expect(domain).not.toBeNull();
  if (!domain) throw new Error("fresh registered domain missing");
  expect(domain.registerContents(test.contents)).toBe(true);
  expect(domain.activate()).toBe(true);
  return { ...test, domain };
}
const get = { url: "https://example.com/page", method: "GET", resourceType: "xhr" };

describe("Main Session authorization domain", () => {
  it("keeps the gate closed by default and snapshots the constructor gate", () => {
    const test = setup();
    const options = { isOwnerCurrent: () => true };
    expect(createBrowserAuthorizationDomainRegistry(options).create(test.context, {})).toBeNull();
    const mutableOptions = { isOwnerCurrent: () => true, gateOpen: false };
    const closed = createBrowserAuthorizationDomainRegistry(mutableOptions);
    mutableOptions.gateOpen = true;
    expect(closed.canPrepare(test.context)).toBe(false);
    expect(closed.create(test.context, {})).toBeNull();
  });
  it("checks actual Main owner/profile context, not equal-looking owner DTOs", () => {
    const test = setup();
    expect(test.registry.canPrepare(test.context)).toBe(true);
    expect(test.registry.canPrepare({ ...test.context, owner: {} })).toBe(false);
    expect(test.registry.canPrepare({ ...test.context, profile: {} })).toBe(false);
    expect(test.registry.canPrepare({ ...test.context, conversationId: "other" })).toBe(false);
    expect(test.registry.canPrepare({ ...test.context, generation: 1 })).toBe(false);
  });
  it("copies and freezes policy/context; caller mutations cannot widen an epoch", () => {
    const test = setup(), hosts = ["example.com"];
    const domain = test.registry.create(test.context, test.session, { hosts });
    expect(domain).not.toBeNull();
    if (!domain) throw new Error("domain missing");
    domain.registerContents(test.contents); domain.activate();
    hosts.push("example.org"); test.context.conversationId = "changed";
    expect(domain.epoch.context.conversationId).toBe("conversation");
    expect(domain.epoch.policy.hosts).toEqual(["example.com"]);
    expect(Object.isFrozen(domain)).toBe(true);
    expect(Object.isFrozen(domain.epoch)).toBe(true);
    expect(Object.isFrozen(domain.epoch.context)).toBe(true);
    expect(Object.isFrozen(domain.epoch.policy)).toBe(true);
    expect(Object.isFrozen(domain.epoch.policy.hosts)).toBe(true);
    expect(domain.allows(get)).toBe(true);
    expect(domain.allows({ ...get, url: "https://example.org/" })).toBe(false);
  });
  it("denies until native primary contents are registered and preparation activates", () => {
    const test = setup(), domain = test.registry.create(test.context, test.session);
    expect(domain).not.toBeNull();
    if (!domain) throw new Error("domain missing");
    expect(domain.isCurrent()).toBe(true);
    expect(domain.isActive()).toBe(false);
    expect(domain.allows(get)).toBe(false);
    expect(domain.activate()).toBe(false);
    expect(domain.registerContents({ ...test.contents, session: {} })).toBe(false);
    expect(domain.registerContents(test.contents)).toBe(true);
    expect(domain.allows(get)).toBe(false);
    expect(domain.activate()).toBe(true);
    expect(domain.allows(get)).toBe(true);
  });
  it("inherits Session policy for missing worker ID without granting unknown contents authority", () => {
    const { domain, contents } = domainReady();
    expect(createBrowserRequestPolicy(19, new AbortController().signal).allows(get)).toBe(false);
    expect(domain.allows(get)).toBe(true);
    expect(domain.allows({ ...get, webContentsId: 19 })).toBe(true);
    expect(domain.allows({ ...get, webContentsId: 20 })).toBe(false);
    expect(domain.allows({ ...get, webContentsId: 0 })).toBe(false);
    expect(domain.ownsContents(contents)).toBe(true);
    expect(domain.ownsContents({ ...contents })).toBe(false);
    expect(domain.ownsContents(undefined)).toBe(false);
  });
  it.each(["POST", "PUT", "DELETE", "OPTIONS", "CONNECT", "get", ""])("keeps method %s denied", (method) => expect(domainReady().domain.allows({ ...get, method })).toBe(false));
  it("retains HEAD and the existing allowed resource types", () => {
    const { domain } = domainReady();
    for (const resourceType of ["mainFrame", "subFrame", "stylesheet", "script", "image", "font", "media", "xhr"]) {
      expect(domain.allows({ ...get, resourceType, method: "HEAD" })).toBe(true);
    }
  });
  it.each(["http://example.com", "wss://example.com", "file:///tmp/x", "data:text/plain,x", "https://user:secret@example.com", "https://example.com:8443", "https://127.0.0.1", "https://198.18.1.171", "https://[::ffff:8.8.8.8]/", "not a URL"])("retains target refusal %s", (url) => expect(domainReady().domain.allows({ ...get, url })).toBe(false));
  it.each(["webSocket", "ping", "cspReport", "other", "serviceWorker", ""])("denies unproven resource %s", (resourceType) => expect(domainReady().domain.allows({ ...get, resourceType })).toBe(false));
  it("never reuses a native Session even after its old domain is revoked", () => {
    const { registry, context, session, domain } = domainReady();
    expect(registry.create(context, session)).toBeNull();
    domain.revoke();
    expect(registry.create(context, session)).toBeNull();
    expect(registry.create(context, {})).not.toBeNull();
  });
  it("does not replace the registered native contents with equal-looking or foreign contents", () => {
    const { domain, contents } = domainReady();
    expect(domain.registerContents({ ...contents })).toBe(false);
    expect(domain.registerContents(contents)).toBe(true);
    contents.id = 20;
    expect(domain.ownsContents(contents)).toBe(false);
    contents.id = 19;
    expect(domain.isActive()).toBe(false);
    expect(domain.signal.aborted).toBe(true);
  });
  it("permanently denies after owner change, abort, or explicit revoke", () => {
    for (const reason of ["stale", "abort", "revoke"]) {
      const test = domainReady();
      if (reason === "stale") test.stale();
      if (reason === "abort") test.cancellation.abort();
      if (reason === "revoke") test.domain.revoke();
      expect(test.domain.allows(get)).toBe(false);
      expect(test.domain.signal.aborted).toBe(true);
      expect(test.domain.activate()).toBe(false);
    }
  });
  it("revokeAll makes all independently registered same-origin domains inactive", () => {
    const test = domainReady(), otherSession = {};
    const other = test.registry.create(test.context, otherSession);
    expect(other).not.toBeNull();
    if (!other) throw new Error("other missing");
    other.registerContents({ id: 20, session: otherSession, isDestroyed: () => false }); other.activate();
    test.registry.revokeAll();
    expect(test.domain.allows(get)).toBe(false);
    expect(other.allows(get)).toBe(false);
  });
  it("fails closed when Main owner verification throws", () => {
    const test = setup();
    expect(createBrowserAuthorizationDomainRegistry({ gateOpen: true, isOwnerCurrent: () => { throw new Error("private source"); } }).canPrepare(test.context)).toBe(false);
  });
  it.each(["127.0.0.1", "198.18.1.1", "example.com:8443", "user@example.com", ""])("rejects malformed or non-public host restriction %j before allocation", (host) => {
    const test = setup();
    expect(test.registry.canPrepare(test.context, { hosts: [host] })).toBe(false);
  });
});

it("resource domains never authorize top or subframe navigation and remain immutable for workers", () => {
  const test = setup(), resourceHosts = ["cdn.example"];
  const domain = test.registry.create(test.context, test.session, { hosts: ["public.example"], resourceHosts });
  expect(domain).not.toBeNull(); domain!.registerContents(test.contents); domain!.activate();
  resourceHosts.push("injected.example");
  for (const resourceType of ["script", "stylesheet", "image", "font", "media", "xhr"]) {
    expect(domain!.allows({ url: "https://cdn.example/file", method: "GET", resourceType })).toBe(true);
  }
  for (const resourceType of ["mainFrame", "subFrame"]) {
    expect(domain!.allows({ url: "https://cdn.example/file", method: "GET", resourceType })).toBe(false);
    expect(domain!.allows({ url: "https://public.example/page", method: "GET", resourceType })).toBe(true);
  }
  for (const host of ["injected.example", "sub.cdn.example", "cdn.example.evil.example"]) {
    expect(domain!.allows({ url: `https://${host}/file`, method: "GET", resourceType: "script" })).toBe(false);
  }
  expect(domain!.epoch.policy.resourceHosts).toEqual(["cdn.example"]);
});
