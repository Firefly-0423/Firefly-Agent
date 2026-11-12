import { describe, it, expect, vi } from "vitest";
import { createToastWindowController, type ToastBounds } from "./toast-window";
import { TOAST_WINDOW_WIDTH } from "./types";

function desktopToast() {
  let showing = false;
  const area = { x: -1600, y: 40, width: 1600, height: 947 };
  const bounds = vi.fn<(value: ToastBounds) => void>();
  const shell = {
    setBounds: bounds, isDestroyed: () => false, isVisible: () => showing,
    showInactive: vi.fn(() => { showing = true; }), hide: vi.fn(() => { showing = false; }),
    webContents: { id: 106 },
  };
  const api = createToastWindowController({
    createWindow: () => shell as never, getChatWindow: () => null,
    getCursorScreenPoint: () => ({ x: -700, y: 300 }), getDisplayMatching: () => ({ workArea: area }),
  });
  api.preload();
  return { api, shell, area, bounds, latest: () => bounds.mock.calls.at(-1)![0] };
}

describe("Toast desktop geometry", () => {
  it("applies each changed content height immediately and ignores repeated reports", () => {
    const port = desktopToast();
    for (const height of [26, 96, 122]) {
      port.api.updateHeight(height);
      expect(port.latest()).toMatchObject({ height, width: TOAST_WINDOW_WIDTH });
      const applied = port.bounds.mock.calls.length;
      port.api.updateHeight(height);
      expect(port.bounds).toHaveBeenCalledTimes(applied);
    }
    expect(port.bounds).toHaveBeenCalledTimes(3);
  });

  it("ignores zero, negative and nonfinite measurements", () => {
    const port = desktopToast();
    for (const height of [0, -5, NaN, Infinity, -Infinity]) port.api.updateHeight(height);
    expect(port.bounds).not.toHaveBeenCalled();
  });

  it("anchors the right and bottom edges to the usable display area", () => {
    const port = desktopToast();
    port.api.updateHeight(108);
    port.api.syncVisibility(true);
    expect(port.latest()).toEqual({ width: TOAST_WINDOW_WIDTH, height: 108,
      x: port.area.x + port.area.width - TOAST_WINDOW_WIDTH, y: port.area.y + port.area.height - 108 });
    expect(port.shell.showInactive).toHaveBeenCalledTimes(1);
  });

  it("caps oversized content at sixty percent of the usable display height", () => {
    const port = desktopToast();
    port.api.updateHeight(6000);
    port.api.syncVisibility(true);
    const box = port.latest();
    expect(box.height).toEqual(Math.floor(port.area.height * 0.6));
    expect(box.y + box.height).toBeLessThanOrEqual(port.area.y + port.area.height);
  });

  it("hides an empty queue and shows the same shell again for later content", () => {
    const port = desktopToast();
    port.api.updateHeight(108);
    for (const hasItems of [true, false, true]) {
      port.api.syncVisibility(hasItems);
      expect(port.shell.isVisible()).toEqual(hasItems);
    }
    expect(port.shell.hide).toHaveBeenCalledTimes(1);
    expect(port.shell.showInactive).toHaveBeenCalledTimes(2);
  });
});
