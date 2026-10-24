import { describe, expect, it } from "vitest";
import {
  beginBrowserNavigation,
  closeBrowserPage,
  completeBrowserNavigation,
  createBrowserPageState,
  failBrowserNavigation,
} from "./browser-page-state";

function loadedPage() {
  const pending = beginBrowserNavigation(createBrowserPageState("session-a", "browser-a"), "https://example.com/first");
  return completeBrowserNavigation(pending, {
    conversationId: "session-a", browserId: "browser-a", requestId: pending.requestId,
    url: "https://example.com/first", canGoBack: false, canGoForward: false,
  });
}

describe("manual browser page state", () => {
  it("starts with an empty page and disabled history actions", () => {
    expect(createBrowserPageState("session-a", "browser-a")).toMatchObject({
      conversationId: "session-a", browserId: "browser-a", requestId: 0,
      closed: false, loading: false, url: "", pendingUrl: null,
      canGoBack: false, canGoForward: false, error: null,
    });
  });

  it("shows loading without claiming the pending address was committed", () => {
    const loaded = loadedPage();
    const pending = beginBrowserNavigation(loaded, "https://example.com/second");
    expect(pending).toMatchObject({ loading: true, url: loaded.url, pendingUrl: "https://example.com/second", error: null });
    expect(pending.requestId).toBeGreaterThan(loaded.requestId);
  });

  it("commits the actual redirected address and history availability", () => {
    const pending = beginBrowserNavigation(loadedPage(), "https://example.com/second");
    const result = completeBrowserNavigation(pending, {
      conversationId: "session-a", browserId: "browser-a", requestId: pending.requestId,
      url: "https://example.com/final", canGoBack: true, canGoForward: false,
    });
    expect(result).toMatchObject({ loading: false, pendingUrl: null, url: "https://example.com/final", canGoBack: true, canGoForward: false });
  });

  it("ignores an older navigation completing after a newer request", () => {
    const older = beginBrowserNavigation(loadedPage(), "https://example.com/older");
    const current = beginBrowserNavigation(older, "https://example.com/newer");
    expect(completeBrowserNavigation(current, {
      conversationId: "session-a", browserId: "browser-a", requestId: older.requestId,
      url: "https://example.com/older", canGoBack: true, canGoForward: false,
    })).toEqual(current);
  });

  it.each([
    { conversationId: "session-b", browserId: "browser-a" },
    { conversationId: "session-a", browserId: "browser-b" },
  ])("ignores a completion owned by another session or tab: %j", (foreign) => {
    const pending = beginBrowserNavigation(loadedPage(), "https://example.com/second");
    expect(completeBrowserNavigation(pending, {
      ...foreign, requestId: pending.requestId, url: "https://example.com/foreign",
      canGoBack: true, canGoForward: true,
    })).toEqual(pending);
  });

  it.each(["blocked", "load_failed"] as const)("reports %s and preserves the last committed page", (error) => {
    const loaded = loadedPage();
    const pending = beginBrowserNavigation(loaded, "https://example.com/second");
    expect(failBrowserNavigation(pending, {
      conversationId: "session-a", browserId: "browser-a", requestId: pending.requestId, error,
    })).toMatchObject({ loading: false, pendingUrl: null, url: loaded.url, error });
  });

  it("ignores a stale failure after the new page committed", () => {
    const older = beginBrowserNavigation(loadedPage(), "https://example.com/older");
    const newer = beginBrowserNavigation(older, "https://example.com/newer");
    const loaded = completeBrowserNavigation(newer, {
      conversationId: "session-a", browserId: "browser-a", requestId: newer.requestId,
      url: "https://example.com/newer", canGoBack: true, canGoForward: false,
    });
    expect(failBrowserNavigation(loaded, {
      conversationId: "session-a", browserId: "browser-a", requestId: older.requestId, error: "load_failed",
    })).toEqual(loaded);
  });

  it("ignores a foreign failure even when its request number matches", () => {
    const pending = beginBrowserNavigation(loadedPage(), "https://example.com/second");
    expect(failBrowserNavigation(pending, {
      conversationId: "session-b", browserId: "browser-a", requestId: pending.requestId, error: "blocked",
    })).toEqual(pending);
  });

  it("does not accept a completion before any navigation was requested", () => {
    const initial = createBrowserPageState("session-a", "browser-a");
    expect(completeBrowserNavigation(initial, {
      conversationId: "session-a", browserId: "browser-a", requestId: initial.requestId,
      url: "https://example.com/unrequested", canGoBack: true, canGoForward: true,
    })).toEqual(initial);
  });

  it("does not let a duplicate completion change a settled page", () => {
    const loaded = loadedPage();
    expect(completeBrowserNavigation(loaded, {
      conversationId: "session-a", browserId: "browser-a", requestId: loaded.requestId,
      url: "https://example.com/duplicate", canGoBack: true, canGoForward: true,
    })).toEqual(loaded);
  });

  it("does not let a late error turn a settled success into a failure", () => {
    const loaded = loadedPage();
    expect(failBrowserNavigation(loaded, {
      conversationId: "session-a", browserId: "browser-a", requestId: loaded.requestId, error: "load_failed",
    })).toEqual(loaded);
  });

  it("clears the previous error when the user starts another navigation", () => {
    const pending = beginBrowserNavigation(loadedPage(), "https://example.com/second");
    const failed = failBrowserNavigation(pending, {
      conversationId: "session-a", browserId: "browser-a", requestId: pending.requestId, error: "blocked",
    });
    const retrying = beginBrowserNavigation(failed, "https://example.com/third");
    expect(retrying).toMatchObject({ loading: true, error: null, url: failed.url, pendingUrl: "https://example.com/third" });
    expect(retrying.requestId).toBeGreaterThan(failed.requestId);
  });

  it("makes closing a pending page final for late completion and new navigation", () => {
    const pending = beginBrowserNavigation(loadedPage(), "https://example.com/second");
    const closed = closeBrowserPage(pending);
    expect(closed).toMatchObject({ closed: true, loading: false, pendingUrl: null, canGoBack: false, canGoForward: false });
    expect(completeBrowserNavigation(closed, {
      conversationId: "session-a", browserId: "browser-a", requestId: pending.requestId,
      url: "https://example.com/second", canGoBack: true, canGoForward: true,
    })).toEqual(closed);
    expect(beginBrowserNavigation(closed, "https://example.com/third")).toEqual(closed);
  });

  it("ignores late errors after close and makes repeated close harmless", () => {
    const pending = beginBrowserNavigation(loadedPage(), "https://example.com/second");
    const closed = closeBrowserPage(pending);
    expect(failBrowserNavigation(closed, {
      conversationId: "session-a", browserId: "browser-a", requestId: pending.requestId, error: "load_failed",
    })).toEqual(closed);
    expect(closeBrowserPage(closed)).toEqual(closed);
  });

  it("does not mutate a state snapshot while beginning or closing navigation", () => {
    const initial = Object.freeze(createBrowserPageState("session-a", "browser-a"));
    const pending = Object.freeze(beginBrowserNavigation(initial, "https://example.com/first"));
    closeBrowserPage(pending);
    expect(initial).toMatchObject({ loading: false, closed: false, requestId: 0, pendingUrl: null });
    expect(pending).toMatchObject({ loading: true, closed: false, pendingUrl: "https://example.com/first" });
  });
});
