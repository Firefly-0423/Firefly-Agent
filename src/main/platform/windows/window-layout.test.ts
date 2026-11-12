import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cursor: { x: 0, y: 0 },
  displays: [] as Array<{ id: number; workArea: { x: number; y: number; width: number; height: number } }>,
  primary: 1,
}));
vi.mock("electron", () => ({
  screen: {
    getCursorScreenPoint: () => mocks.cursor,
    getAllDisplays: () => mocks.displays,
    getPrimaryDisplay: () => mocks.displays.find((display) => display.id === mocks.primary),
  },
}));

import { clampWindowToWorkArea, computeLayout, computePanelLayout } from "./window-layout";

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 };

beforeEach(() => {
  mocks.cursor = { x: 0, y: 0 };
  mocks.displays = [
    { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1440 } },
  ];
  mocks.primary = 1;
});

describe("clampWindowToWorkArea", () => {
  it("leaves a fully visible window untouched", () => {
    expect(clampWindowToWorkArea({ x: 100, y: 200 }, { width: 800, height: 600 }, WORK_AREA)).toEqual({ x: 100, y: 200 });
  });

  it("keeps the default 120x80 minimum visible on the left/top edge", () => {
    expect(clampWindowToWorkArea({ x: -10_000, y: -10_000 }, { width: 800, height: 600 }, WORK_AREA)).toEqual({
      x: 0 - 800 + 120,
      y: 0 - 600 + 80,
    });
  });

  it("keeps the minimum visible on the right/bottom edge", () => {
    expect(clampWindowToWorkArea({ x: 10_000, y: 10_000 }, { width: 800, height: 600 }, WORK_AREA)).toEqual({
      x: 1920 - 120,
      y: 1080 - 80,
    });
  });

  it("honors a custom visible minimum", () => {
    expect(clampWindowToWorkArea({ x: -10_000, y: 10_000 }, { width: 800, height: 600 }, WORK_AREA, 300, 200)).toEqual({
      x: -800 + 300,
      y: 1080 - 200,
    });
  });

  it("respects a work area with a non-zero origin", () => {
    const workArea = { x: 1920, y: -200, width: 1000, height: 800 };
    expect(clampWindowToWorkArea({ x: 0, y: 0 }, { width: 400, height: 300 }, workArea)).toEqual({
      x: 1920 - 400 + 120,
      y: 0,
    });
  });
});

describe("computePanelLayout", () => {
  it("lays panels horizontally centered when they fit", () => {
    const panels = [
      { width: 600, height: 500 },
      { width: 300, height: 400 },
      { width: 300, height: 300 },
    ];
    expect(computePanelLayout({ x: 0, y: 0, width: 2000, height: 1000 }, panels, 10)).toEqual([
      { x: 390, y: 250 },
      { x: 1000, y: 250 },
      { x: 1310, y: 250 },
    ]);
  });

  it("keeps the tallest panel vertically centered as the common baseline", () => {
    const panels = [
      { width: 100, height: 200 },
      { width: 100, height: 900 },
      { width: 100, height: 400 },
    ];
    const [first, second] = computePanelLayout({ x: 0, y: 0, width: 1000, height: 1000 }, panels, 0);
    expect(first!.y).toBe(50);
    expect(second!.y).toBe(50);
  });

  it("switches to the staircase layout when the total width overflows", () => {
    const panels = [
      { width: 1280, height: 760 },
      { width: 320, height: 760 },
      { width: 320, height: 760 },
    ];
    expect(computePanelLayout(WORK_AREA, panels, 8)).toEqual([
      { x: 320, y: 160 },
      { x: 1600, y: 160 },
      { x: 1600, y: 208 },
    ]);
  });

  it("pins the staircase panels to the right edge when the chat panel is wide", () => {
    const panels = [
      { width: 1900, height: 500 },
      { width: 300, height: 500 },
      { width: 300, height: 500 },
    ];
    const [chat, sidebar, tasks] = computePanelLayout(WORK_AREA, panels, 0);
    expect(chat!.x).toBe(10);
    expect(sidebar!.x).toBe(1620);
    expect(tasks!.x).toBe(1620);
    expect(tasks!.y).toBe(sidebar!.y + 48);
  });

  it("starts at the work area origin when the tallest panel is taller than the screen", () => {
    const panels = [
      { width: 100, height: 1000 },
      { width: 100, height: 1200 },
      { width: 100, height: 1000 },
    ];
    const positions = computePanelLayout({ x: 10, y: 20, width: 1000, height: 500 }, panels, 0);
    expect(positions[0]!.y).toBe(20);
    expect(positions[1]!.y).toBe(20);
  });
});

describe("computeLayout", () => {
  it("uses the display under the cursor", () => {
    mocks.cursor = { x: 2500, y: 300 };
    const layout = computeLayout();
    expect(layout.chat.x).toBe(1920 + Math.floor((2560 - 1936) / 2));
    expect(layout.chat.y).toBe(Math.floor((1440 - 760) / 2));
  });

  it("falls back to the primary display when the cursor is outside every display", () => {
    mocks.cursor = { x: -5000, y: -5000 };
    const layout = computeLayout();
    expect(layout.chat).toEqual({ x: 320, y: 160 });
    expect(layout.sidebar).toEqual({ x: 1600, y: 160 });
    expect(layout.tasks).toEqual({ x: 1600, y: 208 });
  });

  it("uses the cursor display even when it is not the primary one", () => {
    mocks.cursor = { x: 10, y: 10 };
    expect(computeLayout().chat.x).toBe(320);
  });
});
