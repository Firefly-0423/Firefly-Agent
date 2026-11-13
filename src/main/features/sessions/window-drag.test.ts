import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeRestoredBounds, createWindowDragController, type DraggableWindow } from "./window-drag";

const workArea = { x: 0, y: 0, width: 2560, height: 1392 };

describe("computeRestoredBounds", () => {
  it("keeps the cursor at the same horizontal ratio and vertical grab offset", () => {
    const bounds = computeRestoredBounds({
      cursor: { x: 1280, y: 20 },
      maximized: { x: 0, y: 0, width: 2560, height: 1392 },
      normal: { x: 300, y: 200, width: 1280, height: 760 },
      workArea,
    });
    expect(bounds).toEqual({ x: 640, y: 0, width: 1280, height: 760 });
  });

  it("stays inside the work area when grabbing at the right edge", () => {
    const bounds = computeRestoredBounds({
      cursor: { x: 2560, y: 10 },
      maximized: { x: 0, y: 0, width: 2560, height: 1392 },
      normal: { x: 0, y: 0, width: 1280, height: 760 },
      workArea,
    });
    expect(bounds.x).toBe(2560 - 1280);
    expect(bounds.y).toBe(0);
  });

  it("never exceeds the work area when the remembered size is larger", () => {
    const bounds = computeRestoredBounds({
      cursor: { x: 100, y: 10 },
      maximized: { x: 0, y: 0, width: 1000, height: 700 },
      normal: { x: 0, y: 0, width: 4000, height: 3000 },
      workArea: { x: 0, y: 0, width: 1000, height: 700 },
    });
    expect(bounds).toMatchObject({ width: 1000, height: 700, x: 0, y: 0 });
  });
});

describe("createWindowDragController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function fakeWindow(maximized: boolean) {
    const state = { maximized, bounds: { x: 0, y: 0, width: 2560, height: 1392 } };
    const window: DraggableWindow & { setBounds: ReturnType<typeof vi.fn> } = {
      isDestroyed: () => false,
      isMaximized: () => state.maximized,
      getBounds: () => state.bounds,
      getNormalBounds: () => ({ x: 300, y: 200, width: 1280, height: 760 }),
      unmaximize: vi.fn(() => { state.maximized = false; }),
      setBounds: vi.fn((next) => { state.bounds = next; }),
    };
    return { window, state };
  }

  it("restores a maximized window, then follows the cursor until stopped", () => {
    const cursor = { x: 1280, y: 20 };
    const { window } = fakeWindow(true);
    const controller = createWindowDragController({ getCursor: () => cursor, getWorkArea: () => workArea });
    controller.start(window);
    expect(window.unmaximize).toHaveBeenCalledTimes(1);
    expect(window.setBounds).toHaveBeenLastCalledWith({ x: 640, y: 0, width: 1280, height: 760 });
    expect(controller.active).toBe(true);

    cursor.x = 1380; cursor.y = 120;
    vi.advanceTimersByTime(16);
    expect(window.setBounds).toHaveBeenLastCalledWith({ x: 740, y: 100, width: 1280, height: 760 });

    controller.stop();
    expect(controller.active).toBe(false);
    cursor.x = 0;
    const calls = window.setBounds.mock.calls.length;
    vi.advanceTimersByTime(100);
    expect(window.setBounds.mock.calls.length).toBe(calls);
  });

  it("applies the last cursor position when the drag ends between two samples", () => {
    const cursor = { x: 500, y: 40 };
    const { window, state } = fakeWindow(false);
    state.bounds = { x: 400, y: 20, width: 1280, height: 760 };
    const controller = createWindowDragController({ getCursor: () => cursor, getWorkArea: () => workArea });
    controller.start(window);
    cursor.x = 560; cursor.y = 90;
    controller.stop();
    expect(window.setBounds).toHaveBeenLastCalledWith({ x: 460, y: 70, width: 1280, height: 760 });
  });

  it("drags a normal window without unmaximizing and stops when the window is gone", () => {
    const cursor = { x: 500, y: 40 };
    const { window, state } = fakeWindow(false);
    state.bounds = { x: 400, y: 20, width: 1280, height: 760 };
    const controller = createWindowDragController({ getCursor: () => cursor, getWorkArea: () => workArea });
    controller.start(window);
    expect(window.unmaximize).not.toHaveBeenCalled();
    cursor.x = 600;
    vi.advanceTimersByTime(8);
    expect(window.setBounds).toHaveBeenLastCalledWith({ x: 500, y: 20, width: 1280, height: 760 });

    window.isDestroyed = () => true;
    vi.advanceTimersByTime(8);
    expect(controller.active).toBe(false);
  });
});
