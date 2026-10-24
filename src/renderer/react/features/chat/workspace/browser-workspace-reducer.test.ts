import { describe, expect, it } from "vitest";
import { browserWorkspaceReducer, createBrowserWorkspaceState } from "./browser-workspace-reducer";

function pendingPage() {
  return browserWorkspaceReducer(createBrowserWorkspaceState("session-a", "browser-a"), {
    type: "navigation_started", url: "https://example.com/start",
  });
}

describe("manual browser workspace reducer", () => {
  it("initializes an empty page and clean address draft", () => {
    expect(createBrowserWorkspaceState("session-a", "browser-a")).toMatchObject({
      page: { conversationId: "session-a", browserId: "browser-a", loading: false, closed: false },
      address: "", addressEdited: false,
    });
  });

  it("edits an address without starting navigation or changing the committed URL", () => {
    const initial = createBrowserWorkspaceState("session-a", "browser-a");
    const edited = browserWorkspaceReducer(initial, { type: "address_edited", value: "https://example.com/draft" });
    expect(edited).toMatchObject({ address: "https://example.com/draft", addressEdited: true });
    expect(edited.page).toBe(initial.page);
  });

  it("starts the requested address and clears its editing flag", () => {
    const edited = browserWorkspaceReducer(createBrowserWorkspaceState("session-a", "browser-a"), {
      type: "address_edited", value: "https://example.com/draft",
    });
    const started = browserWorkspaceReducer(edited, { type: "navigation_started", url: edited.address });
    expect(started).toMatchObject({
      address: edited.address, addressEdited: false,
      page: { loading: true, pendingUrl: edited.address, url: "" },
    });
  });

  it("shows the committed redirected address when the user has not edited it", () => {
    const pending = pendingPage();
    const loaded = browserWorkspaceReducer(pending, {
      type: "navigation_completed",
      result: { conversationId: "session-a", browserId: "browser-a", requestId: pending.page.requestId,
        url: "https://example.com/final", canGoBack: true, canGoForward: false },
    });
    expect(loaded).toMatchObject({ address: "https://example.com/final", addressEdited: false,
      page: { url: "https://example.com/final", loading: false } });
  });

  it("keeps the user's edited draft when an in-flight page finishes", () => {
    const pending = pendingPage();
    const edited = browserWorkspaceReducer(pending, { type: "address_edited", value: "https://example.com/next" });
    const loaded = browserWorkspaceReducer(edited, {
      type: "navigation_completed",
      result: { conversationId: "session-a", browserId: "browser-a", requestId: pending.page.requestId,
        url: "https://example.com/final", canGoBack: true, canGoForward: false },
    });
    expect(loaded).toMatchObject({ address: "https://example.com/next", addressEdited: true,
      page: { url: "https://example.com/final", loading: false } });
  });

  it("does not let an old response overwrite a newer address or page", () => {
    const older = pendingPage();
    const current = browserWorkspaceReducer(older, { type: "navigation_started", url: "https://example.com/current" });
    const stale = browserWorkspaceReducer(current, {
      type: "navigation_completed",
      result: { conversationId: "session-a", browserId: "browser-a", requestId: older.page.requestId,
        url: "https://example.com/stale", canGoBack: false, canGoForward: false },
    });
    expect(stale).toBe(current);
  });

  it("shows a load failure while retaining the attempted address", () => {
    const pending = pendingPage();
    expect(browserWorkspaceReducer(pending, {
      type: "navigation_failed", result: { conversationId: "session-a", browserId: "browser-a",
        requestId: pending.page.requestId, error: "load_failed" },
    })).toMatchObject({ address: pending.address, page: { loading: false, error: "load_failed" } });
  });

  it("does not let a foreign failure disturb the current draft", () => {
    const pending = pendingPage();
    expect(browserWorkspaceReducer(pending, {
      type: "navigation_failed", result: { conversationId: "session-b", browserId: "browser-a",
        requestId: pending.page.requestId, error: "blocked" },
    })).toBe(pending);
  });

  it("closes permanently and ignores edits or navigation requests afterwards", () => {
    const closed = browserWorkspaceReducer(pendingPage(), { type: "closed" });
    expect(closed.page.closed).toBe(true);
    expect(browserWorkspaceReducer(closed, { type: "address_edited", value: "https://example.com/ignored" })).toBe(closed);
    expect(browserWorkspaceReducer(closed, { type: "navigation_started", url: "https://example.com/ignored" })).toBe(closed);
    expect(browserWorkspaceReducer(closed, { type: "closed" })).toBe(closed);
  });
});
