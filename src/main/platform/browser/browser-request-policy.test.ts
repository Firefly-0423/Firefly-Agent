import { describe, expect, it } from "vitest";
import { createBrowserRequestPolicy } from "./browser-request-policy";

describe("browser request policy (Main event inputs only)", () => {
  const request = { webContentsId: 19, url: "https://example.com/page", method: "GET", resourceType: "mainFrame" };
  it.each(["mainFrame", "subFrame", "stylesheet", "script", "image", "font", "media", "xhr"])("checks %s requests through the same policy", (resourceType) => {
    const policy = createBrowserRequestPolicy(19, new AbortController().signal);
    expect(policy.allows({ ...request, resourceType })).toBe(true);
    expect(policy.allows({ ...request, resourceType, method: "POST" })).toBe(false);
    expect(policy.allows({ ...request, resourceType, url: "https://127.0.0.1/" })).toBe(false);
  });
  it.each(["POST", "PUT", "DELETE", "OPTIONS", "CONNECT", "get", ""])("rejects method %s", (method) => {
    expect(createBrowserRequestPolicy(19, new AbortController().signal).allows({ ...request, method })).toBe(false);
  });
  it("permits HEAD", () => expect(createBrowserRequestPolicy(19, new AbortController().signal).allows({ ...request, method: "HEAD" })).toBe(true));
  it.each(["http://example.com", "wss://example.com", "file:///tmp/x", "data:text/plain,x", "https://user:secret@example.com", "https://example.com:8443", "https://0x7f000001", "https://[::ffff:8.8.8.8]/", "not a URL"])("rejects scheme/authority %s", (url) => {
    expect(createBrowserRequestPolicy(19, new AbortController().signal).allows({ ...request, url })).toBe(false);
  });
  it.each(["webSocket", "ping", "cspReport", "other", "", "serviceWorker"])("rejects unproven resource %s", (resourceType) => {
    expect(createBrowserRequestPolicy(19, new AbortController().signal).allows({ ...request, resourceType })).toBe(false);
  });
  it.each([0, -1, 20, undefined])("rejects unknown/foreign WebContents %s", (webContentsId) => {
    expect(createBrowserRequestPolicy(19, new AbortController().signal).allows({ ...request, webContentsId })).toBe(false);
  });
  it("denies after synchronous revoke and remains revoked", () => {
    const policy = createBrowserRequestPolicy(19, new AbortController().signal);
    expect(policy.allows(request)).toBe(true);
    policy.revoke(); policy.revoke();
    expect(policy.allows(request)).toBe(false);
  });
  it("denies an already aborted binding and aborts an active one", () => {
    const owner = new AbortController(); const policy = createBrowserRequestPolicy(19, owner.signal);
    owner.abort();
    expect(policy.allows(request)).toBe(false);
    expect(createBrowserRequestPolicy(19, owner.signal).allows(request)).toBe(false);
  });
  it("does not create policy for invalid registered identity", () => {
    expect(() => createBrowserRequestPolicy(0, new AbortController().signal)).toThrow();
  });
});
