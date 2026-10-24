import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getAppPath: () => "E:/synthetic-firefly" },
  screen: {},
  BrowserWindow: class extends EventEmitter {
    webContents = new EventEmitter();
    isDestroyed() { return false; }
  },
}));
vi.mock("../env", () => ({ isDev: false }));
vi.mock("./chat-window-placement", () => ({
  resolveInitialChatWindow: () => ({ bounds: { x: 0, y: 0, width: 1280, height: 760 }, maximized: false }),
  trackChatWindowState: vi.fn(),
}));

import { createReactChatWindowShell } from "./create-aux-windows";
import { reactChatSession, setReactChatWindow } from "./window-state";

beforeEach(() => {
  setReactChatWindow(null);
  reactChatSession.reset();
});

describe("chat renderer readiness during navigation", () => {
  it("keeps consecutive session dispatches ready after history.replaceState", () => {
    const window = createReactChatWindowShell();
    reactChatSession.markReady();
    expect(reactChatSession.queueOrTake("work-session")).toBe("work-session");
    window.webContents.emit("did-start-loading");
    window.webContents.emit("did-start-navigation", { isSameDocument: true, isMainFrame: true });
    expect(reactChatSession.queueOrTake("code-session")).toBe("code-session");
    expect(reactChatSession.getPending()).toBeNull();
  });

  it("queues a session while the main document is replaced until renderer ready", () => {
    const window = createReactChatWindowShell();
    reactChatSession.markReady();
    window.webContents.emit("did-start-loading");
    window.webContents.emit("did-start-navigation", { isSameDocument: false, isMainFrame: true });
    expect(reactChatSession.queueOrTake("replacement-session")).toBeNull();
    expect(reactChatSession.markReady()).toBe("replacement-session");
  });

  it("keeps the main renderer ready when a child frame navigates", () => {
    const window = createReactChatWindowShell();
    reactChatSession.markReady();
    window.webContents.emit("did-start-loading");
    window.webContents.emit("did-start-navigation", { isSameDocument: false, isMainFrame: false });
    expect(reactChatSession.queueOrTake("chat-session")).toBe("chat-session");
  });
});

it("does not create or activate the retired standalone status window", async () => {
  const { createSidebarWindow } = await import("./create-aux-windows");
  const { sidebarWindow, setSidebarWindow } = await import("./window-state");
  const show = vi.fn(); const focus = vi.fn();
  setSidebarWindow({ isDestroyed: () => false, show, focus } as never);
  createSidebarWindow();
  expect(show).not.toHaveBeenCalled(); expect(focus).not.toHaveBeenCalled();
  setSidebarWindow(null);
  expect(() => createSidebarWindow()).not.toThrow();
  expect(sidebarWindow).toBeNull();
});