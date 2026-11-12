import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGuestTools, type GuestToolsContents } from "./browser-guest-tools";

type Cookie = { domain: string; name: string; path: string; secure?: boolean };
class FakeContents extends EventEmitter {
  destroyed = false; zoom = 1; userAgent = "Mozilla/5.0 (Windows NT 10.0) Chrome/142.0.1.2 Safari/537.36";
  emulation: unknown = null; printed: unknown[] = []; finds: unknown[] = []; stopped = 0;
  cookies: Cookie[] = []; removed: Array<[string, string]> = []; storages: unknown[] = []; cacheCleared = 0;
  image: { isEmpty(): boolean; toPNG(): Buffer; toJPEG(quality: number): Buffer } = { isEmpty: () => false, toPNG: () => Buffer.from("png"), toJPEG: () => Buffer.from("jpg") };
  entries = [{ url: "https://a.example/", title: "A" }, { url: "https://b.example/", title: "B" }]; active = 1;
  isDestroyed() { return this.destroyed; }
  findInPage(text: string, options: unknown) { this.finds.push([text, options]); return 1; }
  stopFindInPage() { this.stopped++; }
  getZoomFactor() { return this.zoom; } setZoomFactor(f: number) { this.zoom = f; }
  enableDeviceEmulation(p: unknown) { this.emulation = p; } disableDeviceEmulation() { this.emulation = null; }
  getUserAgent() { return this.userAgent; } setUserAgent(ua: string) { this.userAgent = ua; }
  print(options: unknown) { this.printed.push(options); }
  capturePage() { return Promise.resolve(this.image); }
  navigationHistory = { getAllEntries: () => this.entries, getActiveIndex: () => this.active };
  session = {
    cookies: { get: async () => this.cookies, remove: async (url: string, name: string) => { this.removed.push([url, name]); } },
    clearStorageData: async (options?: unknown) => { this.storages.push(options); },
    clearCache: async () => { this.cacheCleared++; },
  };
}
let contents: FakeContents;
const tools = () => createGuestTools(contents as unknown as GuestToolsContents);
beforeEach(() => { contents = new FakeContents(); });

describe("guest tools: find", () => {
  it("starts a search, steps through the same query, and restarts for a new one", () => {
    const t = tools();
    expect(t.find("cat", true, false).find).toEqual({ query: "cat", active: 0, matches: 0 });
    contents.emit("found-in-page", {}, { activeMatchOrdinal: 1, matches: 7 });
    expect(t.state().find).toEqual({ query: "cat", active: 1, matches: 7 });
    t.find("cat", false, true);
    t.find("dog", true, true);
    expect(contents.finds).toEqual([
      ["cat", { forward: true, findNext: false, matchCase: false }],
      ["cat", { forward: false, findNext: true, matchCase: false }],
      ["dog", { forward: true, findNext: false, matchCase: false }],
    ]);
  });
  it("stops, and a new document drops the highlights", () => {
    const t = tools(); t.find("cat", true, false);
    expect(t.stopFind().find).toBeNull();
    expect(contents.stopped).toBe(1);
    t.find("cat", true, false); contents.emit("did-navigate");
    expect(t.state().find).toBeNull();
  });
  it("tells subscribers about results and stops after unsubscribe", () => {
    const t = tools(), listener = vi.fn(), off = t.subscribe(listener); t.find("x", true, false);
    contents.emit("found-in-page", {}, { activeMatchOrdinal: 1, matches: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    off(); contents.emit("found-in-page", {}, { activeMatchOrdinal: 2, matches: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("guest tools: zoom and device", () => {
  it("zooms through the preset stops and resets", () => {
    const t = tools();
    expect(t.zoom("in").zoomPercent).toBe(110);
    expect(t.zoom("in").zoomPercent).toBe(125);
    expect(t.zoom("out").zoomPercent).toBe(110);
    expect(t.zoom("reset").zoomPercent).toBe(100);
  });
  it("emulates a phone with a mobile user agent and restores the original on switching off", () => {
    const t = tools(), original = contents.userAgent;
    expect(t.device("phone").device).toBe("phone");
    expect(contents.emulation).toMatchObject({ screenPosition: "mobile", screenSize: { width: 390, height: 844 }, viewSize: { width: 0, height: 0 } });
    expect(contents.userAgent).toContain("Android");
    expect(contents.userAgent).toContain("Chrome/142.0.1.2 Mobile");
    t.device("tablet");
    expect(contents.userAgent).not.toContain(" Mobile Safari");
    expect(t.device("off").device).toBe("off");
    expect(contents.emulation).toBeNull();
    expect(contents.userAgent).toBe(original);
  });
});

describe("guest tools: print, capture and history", () => {
  it("prints through the system dialog", () => {
    tools().print();
    expect(contents.printed).toEqual([{ silent: false, printBackground: true }]);
  });
  it("captures a PNG, and reports an empty capture as nothing", async () => {
    expect((await tools().capture())?.toString()).toBe("png");
    contents.image = { isEmpty: () => true, toPNG: () => Buffer.alloc(0), toJPEG: () => Buffer.alloc(0) };
    expect(await tools().capture()).toBeNull();
  });
  it("makes a bounded JPEG data URL snapshot, or nothing when empty or too large", async () => {
    expect(await tools().snapshot()).toBe(`data:image/jpeg;base64,${Buffer.from("jpg").toString("base64")}`);
    contents.image = { isEmpty: () => false, toPNG: () => Buffer.alloc(0), toJPEG: () => Buffer.alloc(2_000_000) };
    expect(await tools().snapshot()).toBeNull();
    contents.image = { isEmpty: () => true, toPNG: () => Buffer.alloc(0), toJPEG: () => Buffer.alloc(0) };
    expect(await tools().snapshot()).toBeNull();
  });
  it("lists history newest first, marking the current entry, with bounded titles", () => {
    contents.entries = [{ url: "https://a.example/", title: "A".repeat(500) }, { url: "https://b.example/", title: "B" }];
    const entries = tools().history();
    expect(entries.map(e => [e.index, e.current])).toEqual([[1, true], [0, false]]);
    expect(entries[1].title).toHaveLength(200);
  });
  it("does nothing once the page is gone", async () => {
    const t = tools(); contents.destroyed = true;
    expect(await t.capture()).toBeNull(); expect(t.history()).toEqual([]); expect(await t.cookies()).toEqual([]);
    t.print(); expect(contents.printed).toEqual([]);
    expect(t.zoom("in").zoomPercent).toBe(100);
  });
});

describe("guest tools: cookies and browsing data", () => {
  beforeEach(() => {
    contents.cookies = [
      { domain: ".example.com", name: "a", path: "/", secure: true }, { domain: "example.com", name: "b", path: "/x", secure: true },
      { domain: "other.test", name: "c", path: "/", secure: false },
    ];
  });
  it("summarises cookies per domain without exposing names or values", async () => {
    expect(await tools().cookies()).toEqual([{ domain: "example.com", count: 2 }, { domain: "other.test", count: 1 }]);
  });
  it("clears one site's cookies only", async () => {
    await tools().clear(["cookies"], "example.com");
    expect(contents.removed).toEqual([["https://example.com/", "a"], ["https://example.com/x", "b"]]);
    expect(contents.storages).toEqual([]);
  });
  it("clears all cookies, the cache and site storage as asked", async () => {
    await tools().clear(["cookies", "cache", "storage"]);
    expect(contents.storages).toEqual([{ storages: ["cookies"] }, { storages: ["localstorage", "indexdb", "filesystem", "websql", "serviceworkers", "cachestorage"] }]);
    expect(contents.cacheCleared).toBe(1);
  });
});
