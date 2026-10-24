import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createPetWindow: vi.fn(),
  createChatShell: vi.fn(),
  createSidebarWindow: vi.fn(),
  createSettingsWindow: vi.fn(),
  createStickerManagerWindow: vi.fn(),
  loadReactChatWindowPage: vi.fn(),
  showReactChatWindow: vi.fn(),
  loadWindowForStartup: vi.fn(),
  broadcastToAllWindows: vi.fn(),
  getAllWindows: vi.fn(),
  cursor: { x: 11, y: 22 },
  moveRelative: vi.fn(),
  queueAbsolute: vi.fn(),
  finishDragging: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: mocks.getAllWindows },
  screen: { getCursorScreenPoint: () => mocks.cursor },
}));
vi.mock("../startup/create-pet-window", () => ({
  createPetWindow: mocks.createPetWindow,
  PET_WINDOW_BASE_WIDTH: 100,
  PET_WINDOW_BASE_HEIGHT: 200,
}));
vi.mock("./create-aux-windows", () => ({
  createReactChatWindowShell: mocks.createChatShell,
  createSettingsWindow: mocks.createSettingsWindow,
  createSidebarWindow: mocks.createSidebarWindow,
  createStickerManagerWindow: mocks.createStickerManagerWindow,
  loadReactChatWindowPage: mocks.loadReactChatWindowPage,
  showReactChatWindow: mocks.showReactChatWindow,
}));
vi.mock("./startup-window-load", () => ({
  CHAT_READY_TIMEOUT_MS: 1234,
  loadWindowForStartup: mocks.loadWindowForStartup,
}));
vi.mock("./broadcast", () => ({ broadcastToAllWindows: mocks.broadcastToAllWindows }));
vi.mock("./pet-window-movement", () => ({
  PetWindowMoveController: class {
    moveRelative = mocks.moveRelative;
    queueAbsolute = mocks.queueAbsolute;
    finishDragging = mocks.finishDragging;
  },
}));

import { IPC } from "../../shared/ipc-channels";
import { createWindowManager, type WindowManagerOptions } from "./window-manager";

class FakeWindow extends EventEmitter {
  destroyed = false;
  visible = true;
  position = [10, 20];
  id = 7;
  webContents = Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: (): boolean => false,
    send: vi.fn(),
    capturePage: vi.fn(),
  });
  show = vi.fn(() => { this.visible = true; });
  hide = vi.fn(() => { this.visible = false; });
  minimize = vi.fn();
  setAlwaysOnTop = vi.fn();
  setIgnoreMouseEvents = vi.fn();
  setOpacity = vi.fn();
  setSize = vi.fn();
  setIcon = vi.fn();
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  getPosition = vi.fn(() => this.position);
}

function makeManager(overrides: Partial<WindowManagerOptions> = {}) {
  const options: WindowManagerOptions = {
    getCurrentAppIconPath: vi.fn(() => "icon.png"),
    isDev: true,
    onChatWindowCreated: vi.fn(),
    loadPetWindowSettingsSlice: vi.fn(() => ({ petZoom: 1 })),
    persistPetWindowPosition: vi.fn(),
    ...overrides,
  };
  return { manager: createWindowManager(options), options };
}

function makePet(): FakeWindow {
  const window = new FakeWindow();
  mocks.createPetWindow.mockReturnValue(window);
  return window;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadWindowForStartup.mockResolvedValue(undefined);
  mocks.getAllWindows.mockReturnValue([]);
});

describe("pet window lifecycle", () => {
  it("creates the pet window once and passes the startup context through", () => {
    const { manager, options } = makeManager();
    const window = makePet();

    expect(manager.createPetWindow(false)).toBe(window);
    expect(mocks.createPetWindow).toHaveBeenCalledWith(
      {
        getCurrentAppIconPath: options.getCurrentAppIconPath,
        isDev: true,
        loadGeneralSettings: options.loadPetWindowSettingsSlice,
      },
      { showOnReady: false },
    );
    expect(manager.createPetWindow()).toBe(window);
    expect(mocks.createPetWindow).toHaveBeenCalledTimes(1);
  });

  it("recreates the pet window after it was destroyed", () => {
    const { manager } = makeManager();
    const first = makePet();
    manager.createPetWindow();
    first.destroyed = true;

    const second = new FakeWindow();
    mocks.createPetWindow.mockReturnValue(second);
    expect(manager.createPetWindow()).toBe(second);
    expect(mocks.createPetWindow).toHaveBeenCalledTimes(2);
  });

  it("shows a started window when ready and notifies ready handlers", () => {
    const { manager } = makeManager();
    const handler = vi.fn();
    manager.onPetWindowReady(handler);
    const window = makePet();
    window.visible = false;

    manager.createPetWindow(true);
    window.emit("ready-to-show");

    expect(window.show).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(window);
  });

  it("keeps a window hidden on ready but still notifies ready handlers", () => {
    const { manager } = makeManager();
    const handler = vi.fn();
    manager.onPetWindowReady(handler);
    const window = makePet();
    window.visible = false;

    manager.createPetWindow(false);
    window.emit("ready-to-show");

    expect(window.show).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(window);
  });

  it("invokes a ready handler immediately for an existing visible window", () => {
    const { manager } = makeManager();
    const window = makePet();
    manager.createPetWindow();
    const handler = vi.fn();

    manager.onPetWindowReady(handler);

    expect(handler).toHaveBeenCalledWith(window);
  });

  it("does not invoke a ready handler immediately for a hidden window", () => {
    const { manager } = makeManager();
    const window = makePet();
    manager.createPetWindow();
    window.visible = false;
    const handler = vi.fn();

    manager.onPetWindowReady(handler);

    expect(handler).not.toHaveBeenCalled();
  });

  it("does not let a throwing ready or closed handler break the window", () => {
    const { manager } = makeManager();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    manager.onPetWindowReady(() => { throw new Error("ready failed"); });
    manager.onPetWindowClosed(() => { throw new Error("closed failed"); });
    const window = makePet();
    manager.createPetWindow();

    expect(() => window.emit("ready-to-show")).not.toThrow();
    expect(() => window.emit("closed")).not.toThrow();
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("forgets the window on close and recreates it on demand", () => {
    const { manager } = makeManager();
    const closed = vi.fn();
    manager.onPetWindowClosed(closed);
    const first = makePet();
    manager.createPetWindow();

    first.emit("closed");

    expect(closed).toHaveBeenCalledTimes(1);
    const second = new FakeWindow();
    mocks.createPetWindow.mockReturnValue(second);
    manager.showPetWindow();
    expect(mocks.createPetWindow).toHaveBeenCalledTimes(2);
    second.visible = false;
    second.emit("ready-to-show");
    expect(second.show).toHaveBeenCalledTimes(1);
  });

  it("reports moved positions and ignores moves from a destroyed window", () => {
    const { manager } = makeManager();
    const moved = vi.fn();
    manager.onPetWindowMoved(moved);
    const window = makePet();
    manager.createPetWindow();

    window.position = [33, 44];
    window.emit("moved");
    expect(moved).toHaveBeenCalledWith({ x: 33, y: 44 });

    window.destroyed = true;
    window.emit("moved");
    expect(moved).toHaveBeenCalledTimes(1);
  });

  it("swallows position-read failures in the moved handler", () => {
    const { manager } = makeManager();
    const moved = vi.fn();
    manager.onPetWindowMoved(moved);
    const window = makePet();
    manager.createPetWindow();
    window.getPosition.mockImplementation(() => { throw new Error("no position"); });

    expect(() => window.emit("moved")).not.toThrow();
    expect(moved).not.toHaveBeenCalled();
  });

  it("recreates the pet window from show when it is missing", () => {
    const { manager } = makeManager();
    const window = makePet();
    manager.showPetWindow();
    expect(mocks.createPetWindow).toHaveBeenCalledTimes(1);
    expect(mocks.createPetWindow).toHaveBeenCalledWith(expect.anything(), { showOnReady: true });
    window.visible = false;
    window.emit("ready-to-show");
    expect(window.show).toHaveBeenCalledTimes(1);
  });

  it("shows and hides an existing pet window", () => {
    const { manager } = makeManager();
    const window = makePet();
    manager.createPetWindow();

    manager.showPetWindow();
    expect(window.show).toHaveBeenCalledTimes(1);

    manager.hidePetWindow();
    expect(window.hide).toHaveBeenCalledTimes(1);

    window.destroyed = true;
    expect(() => manager.hidePetWindow()).not.toThrow();
  });

  it("toggles visibility and falls back to creating a missing window", () => {
    const { manager } = makeManager();
    const window = makePet();
    manager.createPetWindow();

    window.visible = true;
    manager.togglePetWindow();
    expect(window.hide).toHaveBeenCalledTimes(1);

    window.visible = false;
    manager.togglePetWindow();
    expect(window.show).toHaveBeenCalledTimes(1);

    window.destroyed = true;
    manager.togglePetWindow();
    expect(mocks.createPetWindow).toHaveBeenCalledTimes(2);
  });

  it("minimizes only a usable window", () => {
    const { manager } = makeManager();
    const window = makePet();
    manager.minimizePetWindow();
    expect(window.minimize).not.toHaveBeenCalled();

    manager.createPetWindow();
    manager.minimizePetWindow();
    expect(window.minimize).toHaveBeenCalledTimes(1);
  });
});

describe("pet window behavior", () => {
  it("maps always-on-top to the screen-saver level", () => {
    const { manager } = makeManager();
    const window = makePet();
    manager.setPetWindowAlwaysOnTop(true);
    expect(window.setAlwaysOnTop).not.toHaveBeenCalled();

    manager.createPetWindow();
    manager.setPetWindowAlwaysOnTop(true);
    manager.setPetWindowAlwaysOnTop(false);
    expect(window.setAlwaysOnTop).toHaveBeenNthCalledWith(1, true, "screen-saver");
    expect(window.setAlwaysOnTop).toHaveBeenNthCalledWith(2, false, "normal");
  });

  it("sets mouse-event transparency with forwarding", () => {
    const { manager } = makeManager();
    const window = makePet();
    manager.createPetWindow();
    manager.setPetWindowInteractive(false);
    manager.setPetWindowInteractive(true);
    expect(window.setIgnoreMouseEvents).toHaveBeenNthCalledWith(1, true, { forward: true });
    expect(window.setIgnoreMouseEvents).toHaveBeenNthCalledWith(2, false, { forward: true });
  });

  it("fades slightly while dragging and persists the position when dragging ends", () => {
    const { manager } = makeManager();
    const window = makePet();
    manager.createPetWindow();

    manager.setPetWindowDragging(true);
    expect(window.setOpacity).toHaveBeenLastCalledWith(0.99);
    expect(mocks.finishDragging).not.toHaveBeenCalled();

    manager.setPetWindowDragging(false);
    expect(window.setOpacity).toHaveBeenLastCalledWith(1);
    expect(mocks.finishDragging).toHaveBeenCalledTimes(1);
  });

  it("tolerates a platform that refuses the dragging opacity", () => {
    const { manager } = makeManager();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const window = makePet();
    window.setOpacity.mockImplementation(() => { throw new Error("opacity unsupported"); });
    manager.createPetWindow();

    expect(() => manager.setPetWindowDragging(true)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      "[WindowManager] Failed to update pet window dragging opacity:",
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it("delegates relative and absolute movement to the move controller", () => {
    const { manager } = makeManager();
    manager.movePetWindowRelative(5, -3);
    manager.movePetWindowTo(100, 200);
    expect(mocks.moveRelative).toHaveBeenCalledWith(5, -3);
    expect(mocks.queueAbsolute).toHaveBeenCalledWith(100, 200);
  });

  it("resizes to the zoom-scaled base size and notifies the renderer", () => {
    const { manager } = makeManager();
    const window = makePet();
    manager.applyPetWindowZoom(1.5);
    expect(window.setSize).not.toHaveBeenCalled();

    manager.createPetWindow();
    manager.applyPetWindowZoom(1.5);
    expect(window.setSize).toHaveBeenCalledWith(150, 300);
    expect(window.webContents.send).toHaveBeenCalledWith(IPC.PET_ZOOM, 1.5);
  });

  it("does not send the zoom event when the window was destroyed during resize", () => {
    const { manager } = makeManager();
    const window = makePet();
    manager.createPetWindow();
    window.setSize.mockImplementation(() => { window.destroyed = true; });

    manager.applyPetWindowZoom(2);

    expect(window.setSize).toHaveBeenCalledWith(200, 400);
    expect(window.webContents.send).not.toHaveBeenCalled();
  });

  it("captures a frame as a data URL", async () => {
    const { manager } = makeManager();
    const image = { toDataURL: vi.fn(() => "data:image/png;base64,frame") };
    const window = makePet();
    manager.createPetWindow();
    window.webContents.capturePage.mockResolvedValue(image);

    await expect(manager.capturePetWindow()).resolves.toBe(image);
    await expect(manager.capturePetWindowFrame()).resolves.toBe("data:image/png;base64,frame");
  });

  it("returns null when there is no window or capture fails", async () => {
    const { manager } = makeManager();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(manager.capturePetWindow()).resolves.toBeNull();
    await expect(manager.capturePetWindowFrame()).resolves.toBeNull();

    const window = makePet();
    manager.createPetWindow();
    window.webContents.capturePage.mockRejectedValue(new Error("capture failed"));
    await expect(manager.capturePetWindow()).resolves.toBeNull();
    await expect(manager.capturePetWindowFrame()).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith("[WindowManager] capturePetWindow failed:", expect.any(Error));
    error.mockRestore();
  });

  it("reads the cursor position from the screen module", () => {
    const { manager } = makeManager();
    expect(manager.getCursorScreenPosition()).toEqual({ x: 11, y: 22 });
    mocks.cursor = { x: 1, y: 2 };
    expect(manager.getCursorScreenPosition()).toEqual({ x: 1, y: 2 });
  });

  it("applies the icon to every live window only", () => {
    const { manager } = makeManager();
    const live = new FakeWindow();
    const destroyed = new FakeWindow();
    destroyed.destroyed = true;
    mocks.getAllWindows.mockReturnValue([live, destroyed]);

    manager.setIconForAllWindows({ id: 1 } as never);

    expect(live.setIcon).toHaveBeenCalledWith({ id: 1 });
    expect(destroyed.setIcon).not.toHaveBeenCalled();
  });
});

describe("messages to the pet window", () => {
  it("reports delivery failures when no usable window exists", () => {
    const { manager } = makeManager();
    expect(manager.sendToPetWindow("channel", 1)).toBe(false);

    const window = makePet();
    manager.createPetWindow();
    window.webContents.isDestroyed = () => true;
    expect(manager.sendToPetWindow("channel", 1)).toBe(false);
  });

  it("omits the payload argument when the payload is undefined", () => {
    const { manager } = makeManager();
    const window = makePet();
    manager.createPetWindow();

    expect(manager.sendToPetWindow("without-payload")).toBe(true);
    expect(window.webContents.send).toHaveBeenCalledWith("without-payload");
    expect(manager.sendToPetWindow("with-payload", null)).toBe(true);
    expect(window.webContents.send).toHaveBeenLastCalledWith("with-payload", null);
  });

  it("identifies the pet window's webContents sender", () => {
    const { manager } = makeManager();
    expect(manager.isPetWindowSender(7)).toBe(false);

    const window = makePet();
    window.webContents.id = 7;
    manager.createPetWindow();
    expect(manager.isPetWindowSender(7)).toBe(true);
    expect(manager.isPetWindowSender(8)).toBe(false);
  });

  it("broadcasts through the shared window broadcaster", () => {
    const { manager } = makeManager();
    manager.broadcast("event", { value: 1 });
    expect(mocks.broadcastToAllWindows).toHaveBeenCalledWith("event", { value: 1 });
  });
});

describe("chat window shell", () => {
  it("creates one shell, notifies the hook and reuses it", () => {
    const { manager, options } = makeManager();
    const window = new FakeWindow();
    mocks.createChatShell.mockReturnValue(window);

    const handle = manager.createReactChatWindowShell();

    expect(handle.window).toBe(window);
    expect(options.onChatWindowCreated).toHaveBeenCalledWith(window);
    expect(manager.createReactChatWindowShell()).toBe(handle);
    expect(mocks.createChatShell).toHaveBeenCalledTimes(1);
  });

  it("creates a fresh shell after the previous one was destroyed", () => {
    const { manager, options } = makeManager();
    const first = new FakeWindow();
    mocks.createChatShell.mockReturnValueOnce(first);
    const handle = manager.createReactChatWindowShell();

    first.destroyed = true;
    const second = new FakeWindow();
    mocks.createChatShell.mockReturnValueOnce(second);
    const replacement = manager.createReactChatWindowShell();

    expect(replacement).not.toBe(handle);
    expect(replacement.window).toBe(second);
    expect(options.onChatWindowCreated).toHaveBeenCalledTimes(2);
  });

  it("loads the page only once and passes the session to the page loader", async () => {
    const { manager } = makeManager();
    const window = new FakeWindow();
    mocks.createChatShell.mockReturnValue(window);
    const handle = manager.createReactChatWindowShell();

    await handle.load("session-1");
    await handle.load("session-2");

    expect(mocks.loadWindowForStartup).toHaveBeenCalledTimes(1);
    const input = mocks.loadWindowForStartup.mock.calls[0][0];
    expect(input.window).toBe(window);
    expect(input.timeoutMs).toBe(1234);
    input.load();
    expect(mocks.loadReactChatWindowPage).toHaveBeenCalledWith(window, "session-1");
  });

  it("shows and dispatches the session through the aux-window helper", () => {
    const { manager } = makeManager();
    const window = new FakeWindow();
    mocks.createChatShell.mockReturnValue(window);
    const handle = manager.createReactChatWindowShell();

    handle.show("session-9");

    expect(mocks.showReactChatWindow).toHaveBeenCalledWith("session-9");
  });

  it("propagates a page-load failure and logs it", async () => {
    const { manager } = makeManager();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const window = new FakeWindow();
    mocks.createChatShell.mockReturnValue(window);
    mocks.loadWindowForStartup.mockRejectedValue(new Error("renderer bootstrap failed"));
    const handle = manager.createReactChatWindowShell();

    await expect(handle.load()).rejects.toThrow("renderer bootstrap failed");
    expect(error).toHaveBeenCalledWith(
      "[WindowManager] chat page load failed:",
      expect.any(Error),
    );
    error.mockRestore();
  });

  it("opens the chat window by loading it before showing and dispatching", async () => {
    const { manager } = makeManager();
    const window = new FakeWindow();
    mocks.createChatShell.mockReturnValue(window);

    await expect(manager.openReactChatWindow("session-3")).resolves.toBe(window);

    expect(mocks.loadWindowForStartup).toHaveBeenCalledTimes(1);
    expect(mocks.showReactChatWindow).toHaveBeenCalledWith("session-3");
    expect(mocks.loadWindowForStartup.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.showReactChatWindow.mock.invocationCallOrder[0]);
  });
});

describe("auxiliary windows and disposal", () => {
  it("delegates sidebar, settings and sticker-manager creation", () => {
    const { manager } = makeManager();
    manager.createSidebarWindow();
    manager.createSettingsWindow("plugins");
    manager.createStickerManagerWindow();
    expect(mocks.createSidebarWindow).toHaveBeenCalledTimes(1);
    expect(mocks.createSettingsWindow).toHaveBeenCalledWith("plugins");
    expect(mocks.createStickerManagerWindow).toHaveBeenCalledTimes(1);
  });

  it("has an idempotent, side-effect-free dispose", () => {
    const { manager } = makeManager();
    expect(() => { manager.dispose(); manager.dispose(); }).not.toThrow();
  });
});
