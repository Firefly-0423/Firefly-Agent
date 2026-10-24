import { describe, expect, it } from "vitest";
import { CHAT_MIN_HEIGHT, CHAT_MIN_WIDTH, defaultChatBounds, isChatWindowState, resolveChatWindow, type ChatWindowState } from "./chat-window-state";

const main = { x: 0, y: 0, width: 1920, height: 1040 };
const second = { x: 1920, y: 0, width: 1920, height: 1040 };
const saved = (overrides: Partial<ChatWindowState> = {}): ChatWindowState => ({ x: 200, y: 100, width: 1300, height: 800, maximized: false, ...overrides });

describe("first-run chat window", () => {
  it("is centred on the work area and capped on big screens", () => {
    const bounds = defaultChatBounds(main);
    expect(bounds).toEqual({ width: 1440, height: 894, x: 240, y: 73 });
    expect(bounds.x + bounds.width / 2).toBe(960);
  });

  it("scales down on a small screen but never below the window minimum", () => {
    const laptop = { x: 0, y: 0, width: 1366, height: 728 };
    const bounds = defaultChatBounds(laptop);
    expect(bounds.width).toBe(1120);
    expect(bounds.height).toBe(626);
    expect(bounds.width).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH);
    expect(bounds.height).toBeGreaterThanOrEqual(CHAT_MIN_HEIGHT);
  });

  it("fits inside a work area smaller than the usual minimum", () => {
    const tiny = { x: 0, y: 0, width: 800, height: 480 };
    expect(defaultChatBounds(tiny)).toEqual({ x: 0, y: 0, width: 800, height: 480 });
  });

  it("opens on the screen under the cursor when nothing was saved", () => {
    const resolved = resolveChatWindow(undefined, [main, second], second, main);
    expect(resolved.maximized).toBe(false);
    expect(resolved.bounds.x).toBeGreaterThanOrEqual(second.x);
  });
});

describe("restoring the last window", () => {
  it("brings back the saved size and position", () => {
    expect(resolveChatWindow(saved(), [main], main, main)).toEqual({ bounds: { x: 200, y: 100, width: 1300, height: 800 }, maximized: false });
  });

  it("keeps the maximised flag, with the restored bounds underneath", () => {
    expect(resolveChatWindow(saved({ maximized: true }), [main], main, main).maximized).toBe(true);
  });

  it("restores onto a second monitor while it is still attached", () => {
    const onSecond = saved({ x: 2100 });
    expect(resolveChatWindow(onSecond, [main, second], main, main).bounds.x).toBe(2100);
  });

  it("returns to the primary screen, centred, when its monitor is gone", () => {
    const resolved = resolveChatWindow(saved({ x: 2100 }), [main], main, main);
    expect(resolved.bounds).toEqual({ width: 1300, height: 800, x: 310, y: 120 });
  });

  it("returns to the primary screen when a resolution change left it off screen", () => {
    const resolved = resolveChatWindow(saved({ x: 1800, y: 900 }), [{ x: 0, y: 0, width: 1280, height: 720 }], { x: 0, y: 0, width: 1280, height: 720 }, { x: 0, y: 0, width: 1280, height: 720 });
    expect(resolved.bounds.x).toBeGreaterThanOrEqual(0);
    expect(resolved.bounds.x + resolved.bounds.width).toBeLessThanOrEqual(1280);
    expect(resolved.bounds.y + resolved.bounds.height).toBeLessThanOrEqual(720);
  });

  it("shrinks an oversized window to the work area and pulls it back inside", () => {
    const resolved = resolveChatWindow(saved({ x: 600, y: 500, width: 5000, height: 4000 }), [main], main, main);
    expect(resolved.bounds).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
  });

  it("does not shrink below the window minimum", () => {
    const resolved = resolveChatWindow(saved({ width: 10, height: 10 }), [main], main, main);
    expect(resolved.bounds.width).toBe(CHAT_MIN_WIDTH);
    expect(resolved.bounds.height).toBe(CHAT_MIN_HEIGHT);
  });
});

describe("saved state validation", () => {
  it("accepts a well-formed state", () => {
    expect(isChatWindowState(saved())).toBe(true);
  });

  it.each([
    ["null", null],
    ["a string", "x"],
    ["missing maximized", { x: 0, y: 0, width: 1, height: 1 }],
    ["non-integer", { x: 0.5, y: 0, width: 1, height: 1, maximized: false }],
    ["NaN", { x: Number.NaN, y: 0, width: 1, height: 1, maximized: false }],
    ["zero width", { x: 0, y: 0, width: 0, height: 1, maximized: false }],
    ["string number", { x: "0", y: 0, width: 1, height: 1, maximized: false }],
  ])("rejects %s", (_name, value) => {
    expect(isChatWindowState(value)).toBe(false);
  });
});
