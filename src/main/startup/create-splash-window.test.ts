import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

interface FakeWindow {
  options: Record<string, unknown>;
  loadedUrl?: string;
  loadedFile?: string;
  ignoredMouse: boolean;
  shown: number;
  focused: number;
  destroyed: boolean;
  emit(event: string): void;
  listeners: Map<string, Array<() => void>>;
}

const mocks = vi.hoisted(() => ({
  instances: [] as FakeWindow[],
  throwOnConstruct: false,
  appPath: "C:/firefly-app",
  screen: { width: 1920, height: 1080 },
}));
vi.mock("electron", () => {
  class BrowserWindow implements FakeWindow {
    options: Record<string, unknown>;
    loadedUrl?: string;
    loadedFile?: string;
    ignoredMouse = false;
    shown = 0;
    focused = 0;
    destroyed = false;
    listeners = new Map<string, Array<() => void>>();
    constructor(options: Record<string, unknown>) {
      if (mocks.throwOnConstruct) throw new Error("synthetic constructor failure");
      this.options = options;
      mocks.instances.push(this);
    }
    setIgnoreMouseEvents(value: boolean) {
      this.ignoredMouse = value;
    }
    loadURL(url: string) {
      this.loadedUrl = url;
      return Promise.resolve();
    }
    loadFile(file: string) {
      this.loadedFile = file;
      return Promise.resolve();
    }
    once(event: string, listener: () => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    }
    emit(event: string) {
      for (const listener of this.listeners.get(event) ?? []) listener();
    }
    isDestroyed() {
      return this.destroyed;
    }
    show() {
      this.shown++;
    }
    focus() {
      this.focused++;
    }
  }
  return {
    app: { getAppPath: () => mocks.appPath },
    screen: {
      getPrimaryDisplay: () => ({ workAreaSize: { width: mocks.screen.width, height: mocks.screen.height } }),
    },
    BrowserWindow,
  };
});

import { createSplashWindow } from "./create-splash-window";

beforeEach(() => {
  mocks.instances.length = 0;
  mocks.throwOnConstruct = false;
  mocks.appPath = "C:/firefly-app";
  mocks.screen = { width: 1920, height: 1080 };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createSplashWindow", () => {
  it("creates a 520x520 centered, frameless splash that starts hidden", () => {
    const window = createSplashWindow({ isDev: false });
    expect(window).not.toBeNull();
    const instance = mocks.instances[0]!;
    expect(instance.options).toMatchObject({
      width: 520,
      height: 520,
      x: Math.round((1920 - 520) / 2),
      y: Math.round((1080 - 520) / 2),
      transparent: true,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    expect(instance.ignoredMouse).toBe(true);
  });

  it("loads the Vite splash URL in development", () => {
    createSplashWindow({ isDev: true });
    expect(mocks.instances[0]!.loadedUrl).toBe("http://localhost:5173/splash.html");
    expect(mocks.instances[0]!.loadedFile).toBeUndefined();
  });

  it("loads the packaged splash file outside development", () => {
    createSplashWindow({ isDev: false });
    expect(mocks.instances[0]!.loadedFile).toBe(path.join("C:/firefly-app", "dist", "renderer", "splash.html"));
    expect(mocks.instances[0]!.loadedUrl).toBeUndefined();
  });

  it("shows and focuses on ready-to-show and reports the injected clock", () => {
    const onShown = vi.fn();
    const window = createSplashWindow({ isDev: false, onShown, now: () => 4242 });
    window!.emit("ready-to-show");
    expect(mocks.instances[0]!.shown).toBe(1);
    expect(mocks.instances[0]!.focused).toBe(1);
    expect(onShown).toHaveBeenCalledWith(4242);
  });

  it("does not touch a window destroyed before ready-to-show", () => {
    const onShown = vi.fn();
    const window = createSplashWindow({ isDev: false, onShown });
    mocks.instances[0]!.destroyed = true;
    window!.emit("ready-to-show");
    expect(mocks.instances[0]!.shown).toBe(0);
    expect(mocks.instances[0]!.focused).toBe(0);
    expect(onShown).not.toHaveBeenCalled();
  });

  it("swallows an onShown callback failure after showing", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const window = createSplashWindow({
      isDev: false,
      onShown: () => {
        throw new Error("listener failure");
      },
    });
    window!.emit("ready-to-show");
    expect(mocks.instances[0]!.shown).toBe(1);
    expect(consoleError).toHaveBeenCalledWith("[Splash] onShown callback failed:", expect.any(Error));
  });

  it("returns null and logs when window construction fails", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.throwOnConstruct = true;
    expect(createSplashWindow({ isDev: false })).toBeNull();
    expect(consoleError).toHaveBeenCalledWith("[Splash] Failed to create splash window:", expect.any(Error));
  });
});
