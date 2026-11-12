import { afterEach, expect, it, vi } from "vitest";
import { revealStartupWindows } from "./startup-window-reveal";

afterEach(() => vi.useRealTimers());
function windows() {
  const history: string[] = [];
  return {
    history,
    loading: { isDestroyed: () => false, close: vi.fn(() => { history.push("close"); }), show: vi.fn() },
    chat: { isDestroyed: () => false, close: vi.fn(), show: vi.fn(() => { history.push("show"); }) },
  };
}
it("closes the loading window before showing chat without a minimum delay", async () => {
  const view = windows();
  await revealStartupWindows({ splashWindow: view.loading, chatWindow: view.chat, minimumDurationMs: 0 });
  expect(view.history).toEqual(["close", "show"]);
});
it("waits precisely the unelapsed part of the minimum duration", async () => {
  vi.useFakeTimers();
  const view = windows();
  let completed = false;
  const pending = revealStartupWindows({ splashWindow: view.loading, chatWindow: view.chat,
    loadingShownAt: 6000, now: () => 8000, minimumDurationMs: 2500 }).then(() => { completed = true; });
  await vi.advanceTimersByTimeAsync(499);
  expect(completed).toBe(false);
  expect(view.history).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(completed).toBe(true);
  await pending;
  expect(view.history).toEqual(["close", "show"]);
});
it("shows chat immediately if no loading window was shown", async () => {
  const view = windows();
  const delay = vi.fn(async () => {});
  await revealStartupWindows({ splashWindow: null, chatWindow: view.chat, minimumDurationMs: 2500, sleep: delay });
  expect(delay).not.toHaveBeenCalled();
  expect(view.chat.show).toHaveBeenCalledTimes(1);
});
