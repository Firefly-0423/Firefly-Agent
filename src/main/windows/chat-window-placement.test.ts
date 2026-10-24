import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const display = vi.hoisted(() => ({
  cursor: { x: 100, y: 100 },
  areas: [{ x: 0, y: 0, width: 1920, height: 1040 }],
}));
vi.mock("electron", () => ({
  screen: {
    getCursorScreenPoint: () => display.cursor,
    getAllDisplays: () => display.areas.map(workArea => ({ workArea })),
    getPrimaryDisplay: () => ({ workArea: display.areas[0] }),
  },
}));

const storage = vi.hoisted(() => ({ file: "" as string | undefined }));
vi.mock("../storage-context", () => ({
  getStorageContext: () => {
    if (storage.file === undefined) throw new Error("FIREFLY_STORAGE_NOT_INITIALIZED");
    return { files: { chatWindowState: storage.file } };
  },
}));

import { resolveInitialChatWindow, trackChatWindowState } from "./chat-window-placement";

class FakeWindow extends EventEmitter {
  destroyed = false; minimized = false; fullScreen = false; maximized = false;
  bounds = { x: 120, y: 80, width: 1300, height: 820 };
  isDestroyed() { return this.destroyed; }
  isMinimized() { return this.minimized; }
  isFullScreen() { return this.fullScreen; }
  isMaximized() { return this.maximized; }
  getNormalBounds() { return this.bounds; }
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-window-"));
  storage.file = path.join(dir, "chat-window-state.json");
  display.areas = [{ x: 0, y: 0, width: 1920, height: 1040 }];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

const asWindow = (window: FakeWindow) => window as unknown as Parameters<typeof trackChatWindowState>[0];
const saved = () => JSON.parse(fs.readFileSync(storage.file!, "utf8"));

describe("chat window placement", () => {
  it("opens centred at the first-run size when nothing was saved", () => {
    const resolved = resolveInitialChatWindow();
    expect(resolved.maximized).toBe(false);
    expect(resolved.bounds.x + resolved.bounds.width / 2).toBe(960);
  });

  it("writes the window state shortly after it stops moving, then restores it next launch", () => {
    const window = new FakeWindow();
    trackChatWindowState(asWindow(window));
    window.emit("resize");
    window.emit("move");
    expect(fs.existsSync(storage.file!)).toBe(false);
    vi.advanceTimersByTime(500);
    expect(saved()).toEqual({ x: 120, y: 80, width: 1300, height: 820, maximized: false });
    expect(resolveInitialChatWindow().bounds).toEqual({ x: 120, y: 80, width: 1300, height: 820 });
  });

  it("saves immediately on close and records the maximised flag with the restored bounds", () => {
    const window = new FakeWindow();
    trackChatWindowState(asWindow(window));
    window.maximized = true;
    window.emit("close");
    expect(saved()).toEqual({ x: 120, y: 80, width: 1300, height: 820, maximized: true });
    expect(resolveInitialChatWindow()).toEqual({ bounds: { x: 120, y: 80, width: 1300, height: 820 }, maximized: true });
  });

  it("does not record a minimised or full-screen window", () => {
    const window = new FakeWindow();
    trackChatWindowState(asWindow(window));
    window.minimized = true;
    window.emit("close");
    expect(fs.existsSync(storage.file!)).toBe(false);
  });

  it("falls back to a centred window when the saved file is corrupt", () => {
    fs.writeFileSync(storage.file!, "{ not json");
    expect(resolveInitialChatWindow().maximized).toBe(false);
    fs.writeFileSync(storage.file!, JSON.stringify({ x: "left", y: 0, width: 1, height: 1, maximized: false }));
    expect(resolveInitialChatWindow().bounds.width).toBeGreaterThanOrEqual(960);
  });

  it("sets a corrupt state file aside and saves a fresh one instead of staying broken", () => {
    fs.writeFileSync(storage.file!, "{ not json");
    const window = new FakeWindow();
    trackChatWindowState(asWindow(window));
    window.emit("close");
    expect(saved()).toEqual({ x: 120, y: 80, width: 1300, height: 820, maximized: false });
    expect(fs.readFileSync(`${storage.file}.invalid`, "utf8")).toBe("{ not json");
    expect(resolveInitialChatWindow().bounds).toEqual({ x: 120, y: 80, width: 1300, height: 820 });
  });

  it("never throws when storage is not ready", () => {
    storage.file = undefined;
    expect(() => resolveInitialChatWindow()).not.toThrow();
    const window = new FakeWindow();
    expect(() => { trackChatWindowState(asWindow(window)); window.emit("close"); }).not.toThrow();
  });
});
