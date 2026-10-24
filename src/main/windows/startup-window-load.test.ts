import { EventEmitter } from "node:events";
import { afterEach, describe, it, expect, vi } from "vitest";
import { loadWindowForStartup, type StartupLoadWindowLike } from "./startup-window-load";

function startupPage() {
  const shell = new EventEmitter();
  const page = new EventEmitter();
  const target: StartupLoadWindowLike = {
    once: (event, callback) => { shell.once(event, callback); },
    removeListener: (event, callback) => { shell.removeListener(event, callback); },
    webContents: { once: (event, callback) => { page.once(event, callback); },
      removeListener: (event, callback) => { page.removeListener(event, callback); } },
  };
  return { target, ready: () => shell.emit("ready-to-show"),
    fail: (main: boolean) => page.emit("did-fail-load", {}, -27, "PAGE_UNAVAILABLE", "https://desktop.invalid/chat", main),
    subscriptions: () => [shell.listenerCount("ready-to-show"), page.listenerCount("did-fail-load")] };
}

afterEach(() => vi.useRealTimers());

describe("Startup page readiness", () => {
  it("waits the configured deadline even when the load promise succeeds", async () => {
    vi.useFakeTimers();
    const page = startupPage();
    const pending = loadWindowForStartup({ window: page.target, load: async () => {}, timeoutMs: 20_000 });
    const rejected = expect(pending).rejects.toThrow("ready-to-show timeout");
    await vi.advanceTimersByTimeAsync(19_999);
    expect(page.subscriptions()).toEqual([1, 1]);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(page.subscriptions()).toEqual([0, 0]);
  });

  it("propagates a rejected page load", async () => {
    const page = startupPage();
    const failure = new Error("renderer navigation rejected");
    const pending = loadWindowForStartup({ timeoutMs: 20_000, window: page.target, load: () => Promise.reject(failure) });
    await expect(pending).rejects.toBe(failure);
    expect(page.subscriptions()).toEqual([0, 0]);
  });

  it("installs both listeners before scheduling navigation and removes them on readiness", async () => {
    const page = startupPage();
    const navigate = vi.fn(async () => {});
    const pending = loadWindowForStartup({ window: page.target, load: navigate, timeoutMs: 20_000 });
    expect(page.subscriptions()).toEqual([1, 1]);
    expect(navigate).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(navigate).toHaveBeenCalledTimes(1);
    page.ready();
    await expect(pending).resolves.toBeUndefined();
    expect(page.subscriptions()).toEqual([0, 0]);
  });

  it("ignores a subframe failure and still accepts window readiness", async () => {
    const page = startupPage();
    const pending = loadWindowForStartup({ timeoutMs: 20_000, window: page.target, load: async () => {} });
    page.fail(false);
    page.ready();
    await expect(pending).resolves.toBeUndefined();
  });

  it("reports the full main frame navigation failure", async () => {
    const page = startupPage();
    const pending = loadWindowForStartup({ timeoutMs: 20_000, window: page.target, load: async () => {} });
    page.fail(true);
    await expect(pending).rejects.toThrow("chat page did-fail-load -27: PAGE_UNAVAILABLE https://desktop.invalid/chat");
    expect(page.subscriptions()).toEqual([0, 0]);
  });
});
