import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import { registerWindowSystemIpc } from "./window-system-ipc";

const tokenMock = vi.hoisted(() => ({
  getUsageReport: vi.fn(),
  clearUsage: vi.fn(),
  getUsageHistory: vi.fn(),
  getSessionStats: vi.fn(),
}));
const chatsMock = vi.hoisted(() => ({ listSessions: vi.fn() }));
const windowsMock = vi.hoisted(() => ({
  sidebar: null as any,
  settings: null as any,
}));

vi.mock("../storage/token-usage-store", () => tokenMock);
vi.mock("../chats/chats-store", () => chatsMock);
vi.mock("./window-state", () => ({
  get sidebarWindow() {
    return windowsMock.sidebar;
  },
  get settingsWindow() {
    return windowsMock.settings;
  },
}));

type Handler = (...args: any[]) => any;
const handlers = new Map<string, Handler>();
const listeners = new Map<string, Handler>();
const scope = {
  handle: vi.fn((channel: string, handler: Handler) => {
    handlers.set(channel, handler);
  }),
  on: vi.fn((channel: string, listener: Handler) => {
    listeners.set(channel, listener);
  }),
  removeHandler: vi.fn(),
  dispose: vi.fn(),
};

let manager: any = null;
registerWindowSystemIpc({
  get windowManager() {
    return manager;
  },
  ipc: scope as never,
  quit: vi.fn(),
});

function invoke(channel: string, ...args: any[]): any {
  const handler = handlers.get(channel);
  expect(handler, channel).toBeDefined();
  return handler!(...args);
}

function emit(channel: string, ...args: any[]): void {
  const listener = listeners.get(channel);
  expect(listener, channel).toBeDefined();
  listener!(...args);
}

function petWindow(overrides: Record<string, any> = {}) {
  return {
    minimize: vi.fn(),
    close: vi.fn(),
    isAlwaysOnTop: vi.fn(() => false),
    setAlwaysOnTop: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  manager = null;
  windowsMock.sidebar = null;
  windowsMock.settings = null;
});

describe("pet window controls", () => {
  it("forwards interactive, move and drag requests to the window manager", () => {
    manager = {
      setPetWindowInteractive: vi.fn(),
      movePetWindowTo: vi.fn(),
      setPetWindowDragging: vi.fn(),
      minimizePetWindow: vi.fn(),
    };

    invoke(IPC.WINDOW_SET_INTERACTIVE, null, false);
    emit(IPC.WINDOW_MOVE_TO, null, 10, 20);
    emit(IPC.WINDOW_SET_DRAGGING, null, true);
    emit(IPC.WINDOW_MINIMIZE, null);

    expect(manager.setPetWindowInteractive).toHaveBeenCalledWith(false);
    expect(manager.movePetWindowTo).toHaveBeenCalledWith(10, 20);
    expect(manager.setPetWindowDragging).toHaveBeenCalledWith(true);
    expect(manager.minimizePetWindow).toHaveBeenCalledTimes(1);
  });

  it("does not throw when no window manager exists", () => {
    expect(() => invoke(IPC.WINDOW_SET_INTERACTIVE, null, true)).not.toThrow();
    expect(() => emit(IPC.WINDOW_MOVE_TO, null, 1, 2)).not.toThrow();
    expect(() => emit(IPC.WINDOW_SET_DRAGGING, null, true)).not.toThrow();
    expect(() => emit(IPC.WINDOW_MINIMIZE, null)).not.toThrow();
  });

  it("returns the cursor position or a zero fallback", () => {
    manager = { getCursorScreenPosition: vi.fn(() => ({ x: 30, y: 40 })) };
    expect(invoke(IPC.WINDOW_GET_CURSOR_POSITION)).toEqual({ x: 30, y: 40 });

    manager = null;
    expect(invoke(IPC.WINDOW_GET_CURSOR_POSITION)).toEqual({ x: 0, y: 0 });
  });
});

describe("sidebar and settings controls", () => {
  it("minimizes and closes the sidebar only when it exists", () => {
    expect(() => emit(IPC.SIDEBAR_MINIMIZE, null)).not.toThrow();
    expect(() => emit(IPC.SIDEBAR_CLOSE, null)).not.toThrow();

    const sidebar = petWindow();
    windowsMock.sidebar = sidebar;
    emit(IPC.SIDEBAR_MINIMIZE, null);
    emit(IPC.SIDEBAR_CLOSE, null);

    expect(sidebar.minimize).toHaveBeenCalledTimes(1);
    expect(sidebar.close).toHaveBeenCalledTimes(1);
  });

  it("toggles sidebar always-on-top and returns the new state", () => {
    expect(invoke(IPC.SIDEBAR_TOGGLE_ALWAYS_ON_TOP)).toBe(false);

    const sidebar = petWindow({ isAlwaysOnTop: vi.fn(() => false) });
    windowsMock.sidebar = sidebar;
    expect(invoke(IPC.SIDEBAR_TOGGLE_ALWAYS_ON_TOP)).toBe(true);
    expect(sidebar.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");

    const pinned = petWindow({ isAlwaysOnTop: vi.fn(() => true) });
    windowsMock.sidebar = pinned;
    expect(invoke(IPC.SIDEBAR_TOGGLE_ALWAYS_ON_TOP)).toBe(false);
    expect(pinned.setAlwaysOnTop).toHaveBeenCalledWith(false, "normal");
  });

  it("opens settings from the sidebar and returns true from music entry points", () => {
    manager = { createSettingsWindow: vi.fn() };

    emit(IPC.SIDEBAR_OPEN_SETTINGS, null, "api");
    expect(manager.createSettingsWindow).toHaveBeenCalledWith("api");

    emit(IPC.SIDEBAR_OPEN_SETTINGS, null);
    expect(manager.createSettingsWindow).toHaveBeenLastCalledWith(undefined);

    expect(invoke(IPC.MUSIC_OPEN_PLAYER)).toBe(true);
    expect(manager.createSettingsWindow).toHaveBeenLastCalledWith("music");

    expect(invoke(IPC.MUSIC_OPEN_SETTINGS, null, "music")).toBe(true);
    expect(manager.createSettingsWindow).toHaveBeenLastCalledWith("music");

    manager = null;
    expect(invoke(IPC.MUSIC_OPEN_PLAYER)).toBe(true);
    expect(invoke(IPC.MUSIC_OPEN_SETTINGS, null, "music")).toBe(true);
  });

  it("minimizes and closes the settings window only when it exists", () => {
    expect(() => emit(IPC.SETTINGS_MINIMIZE, null)).not.toThrow();
    expect(() => emit(IPC.SETTINGS_CLOSE, null)).not.toThrow();

    const settings = petWindow();
    windowsMock.settings = settings;
    emit(IPC.SETTINGS_MINIMIZE, null);
    emit(IPC.SETTINGS_CLOSE, null);

    expect(settings.minimize).toHaveBeenCalledTimes(1);
    expect(settings.close).toHaveBeenCalledTimes(1);
  });
});

describe("token usage handlers", () => {
  it("clamps usage report days to 1..90 with a 7-day default", () => {
    tokenMock.getUsageReport.mockReturnValue({ total: 1 });
    const cases: Array<[any, number]> = [
      [0, 7],
      [undefined, 7],
      [Number.NaN, 7],
      [-5, 1],
      [1, 1],
      [90, 90],
      [120, 90],
      ["30", 30],
      ["abc", 7],
    ];
    for (const [input, expected] of cases) {
      invoke(IPC.TOKEN_USAGE_GET, null, input);
      expect(tokenMock.getUsageReport).toHaveBeenLastCalledWith(expected);
    }
  });

  it("clears usage", () => {
    invoke(IPC.TOKEN_USAGE_CLEAR);
    expect(tokenMock.clearUsage).toHaveBeenCalledTimes(1);
  });

  it("attaches session titles to usage history and falls back to null", () => {
    tokenMock.getUsageHistory.mockReturnValue({
      total: 2,
      sessions: [{ id: "s1" }, { id: "s2" }],
    });
    chatsMock.listSessions.mockReturnValue([{ id: "s1", title: "First" }]);

    expect(invoke(IPC.TOKEN_USAGE_HISTORY, null, 0)).toEqual({
      total: 2,
      sessions: [
        { id: "s1", title: "First" },
        { id: "s2", title: null },
      ],
    });
    expect(tokenMock.getUsageHistory).toHaveBeenLastCalledWith(7);

    chatsMock.listSessions.mockImplementation(() => {
      throw new Error("synthetic session failure");
    });
    tokenMock.getUsageHistory.mockReturnValue({ sessions: [{ id: "s1" }] });
    expect(invoke(IPC.TOKEN_USAGE_HISTORY, null, 999)).toEqual({
      sessions: [{ id: "s1", title: null }],
    });
    expect(tokenMock.getUsageHistory).toHaveBeenLastCalledWith(90);
  });

  it("returns session stats only for string session ids", () => {
    tokenMock.getSessionStats.mockReturnValue({ requests: 2 });

    expect(invoke(IPC.TOKEN_USAGE_SESSION_STATS, null, "session-1")).toEqual({ requests: 2 });
    expect(tokenMock.getSessionStats).toHaveBeenCalledWith("session-1");

    tokenMock.getSessionStats.mockClear();
    for (const value of [null, undefined, 42, {}, ["session-1"]]) {
      expect(invoke(IPC.TOKEN_USAGE_SESSION_STATS, null, value)).toBeNull();
    }
    expect(tokenMock.getSessionStats).not.toHaveBeenCalled();
  });
});
