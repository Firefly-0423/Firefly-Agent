import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function load() {
  return import("./window-state");
}

function fakeWindow(destroyed = false) {
  return {
    isDestroyed: vi.fn(() => destroyed),
    show: vi.fn(),
  } as unknown as import("electron").BrowserWindow;
}

describe("window references", () => {
  it("starts every auxiliary window reference empty", async () => {
    const state = await load();
    expect(state.reactChatWindow).toBeNull();
    expect(state.sidebarWindow).toBeNull();
    expect(state.settingsWindow).toBeNull();
    expect(state.stickerManagerWindow).toBeNull();
    expect(state.toastWindow).toBeNull();
  });

  it("updates each exported reference through its setter, including clearing it", async () => {
    const state = await load();
    const react = fakeWindow();
    const sidebar = fakeWindow();
    const settings = fakeWindow();
    const stickers = fakeWindow();
    const toast = fakeWindow();

    state.setReactChatWindow(react);
    state.setSidebarWindow(sidebar);
    state.setSettingsWindow(settings);
    state.setStickerManagerWindow(stickers);
    state.setToastWindow(toast);
    expect(state.reactChatWindow).toBe(react);
    expect(state.sidebarWindow).toBe(sidebar);
    expect(state.settingsWindow).toBe(settings);
    expect(state.stickerManagerWindow).toBe(stickers);
    expect(state.toastWindow).toBe(toast);

    state.setReactChatWindow(null);
    state.setSidebarWindow(null);
    state.setSettingsWindow(null);
    state.setStickerManagerWindow(null);
    state.setToastWindow(null);
    expect(state.reactChatWindow).toBeNull();
    expect(state.sidebarWindow).toBeNull();
    expect(state.settingsWindow).toBeNull();
    expect(state.stickerManagerWindow).toBeNull();
    expect(state.toastWindow).toBeNull();
  });
});

describe("startup phase window visibility", () => {
  it("starts in the active, not-ready phase", async () => {
    const state = await load();
    expect(state.isStartupPhaseActive()).toBe(true);
  });

  it("defers showing a window until the startup phase is ready", async () => {
    const state = await load();
    const win = fakeWindow();
    state.showWindowWhenStartupReady(win);
    expect(win.show).not.toHaveBeenCalled();
    expect(state.isStartupPhaseActive()).toBe(true);

    state.markStartupPhaseReady();
    expect(state.isStartupPhaseActive()).toBe(false);
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it("flushes every deferred window exactly once", async () => {
    const state = await load();
    const first = fakeWindow();
    const second = fakeWindow();
    state.showWindowWhenStartupReady(first);
    state.showWindowWhenStartupReady(second);
    state.markStartupPhaseReady();
    state.markStartupPhaseReady();
    expect(first.show).toHaveBeenCalledTimes(1);
    expect(second.show).toHaveBeenCalledTimes(1);
  });

  it("does not show deferred windows that were destroyed", async () => {
    const state = await load();
    const alive = fakeWindow(false);
    const destroyed = fakeWindow(true);
    state.showWindowWhenStartupReady(alive);
    state.showWindowWhenStartupReady(destroyed);
    state.markStartupPhaseReady();
    expect(alive.show).toHaveBeenCalledTimes(1);
    expect(destroyed.show).not.toHaveBeenCalled();
  });

  it("shows windows immediately once the phase is ready", async () => {
    const state = await load();
    state.markStartupPhaseReady();
    const win = fakeWindow();
    state.showWindowWhenStartupReady(win);
    expect(win.show).toHaveBeenCalledTimes(1);
  });
});

describe("app icon provider", () => {
  it("defaults to an empty path and can be replaced", async () => {
    const state = await load();
    expect(state.getCurrentAppIconPath()).toBe("");
    state.setGetCurrentAppIconPath(() => "C:\\icons\\firefly.png");
    expect(state.getCurrentAppIconPath()).toBe("C:\\icons\\firefly.png");
  });
});

describe("react chat session dispatcher", () => {
  it("is exposed as a working singleton", async () => {
    const state = await load();
    expect(state.reactChatSession.isReady()).toBe(false);
    expect(state.reactChatSession.queueOrTake("session-a")).toBeNull();
    expect(state.reactChatSession.getPending()).toBe("session-a");
    expect(state.reactChatSession.markReady()).toBe("session-a");
    expect(state.reactChatSession.queueOrTake("session-b")).toBe("session-b");
    state.reactChatSession.reset();
    expect(state.reactChatSession.isReady()).toBe(false);
    expect(state.reactChatSession.getPending()).toBeNull();
  });
});
