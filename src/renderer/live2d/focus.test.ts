import { afterEach, expect, test, vi } from "vitest";
import { MouseFocusController } from "./focus";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test("suspends system cursor traffic until resumed and detaches on disposal", async () => {
  vi.useFakeTimers();
  const cursor = vi.fn().mockResolvedValue({ x: 420, y: 280 });
  const intervals = vi.fn(globalThis.setInterval), clear = vi.fn(globalThis.clearInterval);
  vi.stubGlobal("window", { screenX: 100, screenY: 80, setInterval: intervals,
    clearInterval: clear, firefly: { getCursorPosition: cursor } });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(callback, 1));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  const canvas = { addEventListener: vi.fn(), removeEventListener: vi.fn(),
    getBoundingClientRect: () => ({ width: 300, height: 180 }) };
  const focus = vi.fn();
  const subject = new MouseFocusController(canvas as unknown as HTMLCanvasElement, { focus } as never,
    { pollIntervalMs: 50 });
  await vi.advanceTimersByTimeAsync(2);
  expect(focus.mock.calls).toStrictEqual([[320, 200]]);
  subject.pause();
  expect(clear).toHaveBeenCalledTimes(1);
  cursor.mockClear();
  await vi.advanceTimersByTimeAsync(250);
  expect(cursor).not.toHaveBeenCalled();
  subject.resume();
  expect(intervals).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2);
  expect(cursor).toHaveBeenCalledTimes(1);
  subject.dispose();
  subject.dispose();
  expect(canvas.removeEventListener).toHaveBeenCalledExactlyOnceWith("pointermove", expect.any(Function));
  subject.resume();
  await vi.advanceTimersByTimeAsync(250);
  expect(cursor).toHaveBeenCalledTimes(1);
});
