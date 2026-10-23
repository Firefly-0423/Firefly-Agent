import { BrowserWindow, screen, type NativeImage } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { createPetWindow, PET_WINDOW_BASE_HEIGHT, PET_WINDOW_BASE_WIDTH, type PetWindowSettingsSlice } from "../startup/create-pet-window";
import {
  showReactChatWindow,
  type ReactChatWindowHandle,
  loadReactChatWindowPage,
  createStickerManagerWindow,
  createSidebarWindow,
  createSettingsWindow,
  createReactChatWindowShell,
} from "./create-aux-windows";
import { CHAT_READY_TIMEOUT_MS, loadWindowForStartup } from "./startup-window-load";
import { broadcastToAllWindows } from "./broadcast";
import { PetWindowMoveController } from "./pet-window-movement";

export interface WindowManagerOptions {
  persistPetWindowPosition: (position: { x: number; y: number }) => void;
  loadPetWindowSettingsSlice: () => PetWindowSettingsSlice;
  /** 每创建一个新的聊天窗口壳就调用一次，早于页面加载。 */
  onChatWindowCreated?: (window: BrowserWindow) => void;
  isDev: boolean;
  getCurrentAppIconPath: () => string;
}

export interface WindowManager {
  dispose(): void;
  broadcast(channel: string, payload: unknown): void;
  getCursorScreenPosition(): { x: number; y: number };
  setIconForAllWindows(icon: NativeImage): void;

  onPetWindowMoved(handler: (position: { x: number; y: number }) => void): void;
  onPetWindowClosed(handler: () => void): void;
  onPetWindowReady(handler: (win: BrowserWindow) => void): void;

  isPetWindowSender(webContentsId: number): boolean;
  sendToPetWindow(channel: string, payload?: unknown): boolean;
  capturePetWindow(): Promise<Electron.NativeImage | null>;
  capturePetWindowFrame(): Promise<string | null>;
  applyPetWindowZoom(zoom: number): void;
  movePetWindowTo(x: number, y: number): void;
  movePetWindowRelative(dx: number, dy: number): void;
  setPetWindowDragging(isDragging: boolean): void;
  setPetWindowInteractive(interactive: boolean): void;
  setPetWindowAlwaysOnTop(alwaysOnTop: boolean): void;
  minimizePetWindow(): void;
  togglePetWindow(): void;
  hidePetWindow(): void;
  showPetWindow(): void;
  createPetWindow(showOnReady?: boolean): BrowserWindow;

  createStickerManagerWindow(): void;
  createSettingsWindow(section?: string): void;
  createSidebarWindow(): void;
  openReactChatWindow(sessionId?: string): Promise<BrowserWindow>;
  createReactChatWindowShell(): ReactChatWindowHandle;
}

type Point = { x: number; y: number };

export function createWindowManager(options: WindowManagerOptions): WindowManager {
  let pet: BrowserWindow | null = null;
  let chatHandle: ReactChatWindowHandle | null = null;
  let chatLoading: Promise<void> | null = null;
  const readyHooks: Array<(win: BrowserWindow) => void> = [];
  const closedHooks: Array<() => void> = [];
  const movedHooks: Array<(position: Point) => void> = [];

  const moveCtl = new PetWindowMoveController(
    () => pet,
    (position) => {
      options.persistPetWindowPosition(position);
    },
  );

  /** 桌宠窗口仅在存在且未销毁时才可用，否则返回 null */
  const livePet = (): BrowserWindow | null => (pet && !pet.isDestroyed() ? pet : null);

  /** 依次执行回调；单个回调抛错只记日志，不影响其余回调 */
  function fanOut<A extends unknown[]>(hooks: Array<(...args: A) => void>, label: string, ...args: A): void {
    for (const hook of hooks) {
      try {
        hook(...args);
      } catch (err) {
        console.error(`[WindowManager] ${label} handler failed:`, err);
      }
    }
  }

  function adoptPetWindow(win: BrowserWindow, showOnReady: boolean): void {
    pet = win;
    win.once("ready-to-show", () => {
      const current = livePet();
      if (!current) return;
      if (showOnReady) current.show();
      fanOut(readyHooks, "ready", current);
    });
    win.on("closed", () => {
      pet = null;
      fanOut(closedHooks, "closed");
    });
    win.on("moved", () => {
      const current = livePet();
      if (!current) return;
      try {
        const [x, y] = current.getPosition();
        fanOut(movedHooks, "moved", { x, y });
      } catch {
        // 位置读取失败（窗口正在销毁）时忽略
      }
    });
  }

  function ensureChatLoaded(window: BrowserWindow, sessionId?: string): Promise<void> {
    // 同一个窗口只加载一次；之后的 sessionId 通过 show() 分发
    if (chatLoading && !window.isDestroyed()) return chatLoading;
    chatLoading = loadWindowForStartup({
      timeoutMs: CHAT_READY_TIMEOUT_MS,
      load: () => loadReactChatWindowPage(window, sessionId),
      window,
    }).catch((failure) => {
      console.error("[WindowManager] chat page load failed:", failure);
      throw failure;
    });
    return chatLoading;
  }

  function obtainChatShell(): ReactChatWindowHandle {
    if (chatHandle && !chatHandle.window.isDestroyed()) return chatHandle;
    const window = createReactChatWindowShell();
    const shell: ReactChatWindowHandle = {
      show: (sessionId?: string) => showReactChatWindow(sessionId),
      load: (sessionId?: string) => ensureChatLoaded(window, sessionId),
      window,
    };
    chatHandle = shell;
    chatLoading = null;
    options.onChatWindowCreated?.(window);
    return shell;
  }

  const manager: WindowManager = {
    createPetWindow(showOnReady = true): BrowserWindow {
      const existing = livePet();
      if (existing) return existing;
      const win = createPetWindow(
        {
          getCurrentAppIconPath: options.getCurrentAppIconPath,
          isDev: options.isDev,
          loadGeneralSettings: options.loadPetWindowSettingsSlice,
        },
        { showOnReady },
      );
      adoptPetWindow(win, showOnReady);
      return win;
    },

    createStickerManagerWindow,
    createSettingsWindow,
    createSidebarWindow,
    createReactChatWindowShell: obtainChatShell,

    async openReactChatWindow(sessionId?: string): Promise<BrowserWindow> {
      const shell = manager.createReactChatWindowShell();
      await shell.load(sessionId);
      shell.show(sessionId);
      return shell.window;
    },

    showPetWindow(): void {
      const current = livePet();
      if (current) {
        current.show();
        return;
      }
      // 桌宠被意外销毁时重建，保证托盘和设置入口总能找回它
      manager.createPetWindow(true);
    },
    hidePetWindow(): void {
      livePet()?.hide();
    },
    togglePetWindow(): void {
      const current = livePet();
      if (!current) {
        manager.createPetWindow(true);
        return;
      }
      if (current.isVisible()) current.hide();
      else current.show();
    },
    minimizePetWindow(): void {
      livePet()?.minimize();
    },
    setPetWindowAlwaysOnTop(alwaysOnTop: boolean): void {
      const current = livePet();
      if (!current) return;
      current.setAlwaysOnTop(alwaysOnTop, alwaysOnTop ? "screen-saver" : "normal");
    },
    setPetWindowInteractive(interactive: boolean): void {
      const current = livePet();
      if (!current) return;
      current.setIgnoreMouseEvents(!interactive, { forward: true });
    },
    setPetWindowDragging(isDragging: boolean): void {
      const current = livePet();
      if (!current) return;
      if (!isDragging) moveCtl.finishDragging();
      try {
        current.setOpacity(isDragging ? 0.99 : 1.0);
      } catch (error) {
        console.warn("[WindowManager] Failed to update pet window dragging opacity:", error);
      }
    },
    movePetWindowRelative(dx: number, dy: number): void {
      moveCtl.moveRelative(dx, dy);
    },
    movePetWindowTo(x: number, y: number): void {
      moveCtl.queueAbsolute(x, y);
    },
    applyPetWindowZoom(zoom: number): void {
      const current = livePet();
      if (!current) return;
      current.setSize(Math.round(PET_WINDOW_BASE_WIDTH * zoom), Math.round(PET_WINDOW_BASE_HEIGHT * zoom));
      if (!current.isDestroyed()) current.webContents.send(IPC.PET_ZOOM, zoom);
    },
    async capturePetWindowFrame(): Promise<string | null> {
      const image = await manager.capturePetWindow();
      return image ? image.toDataURL() : null;
    },
    async capturePetWindow(): Promise<Electron.NativeImage | null> {
      const current = livePet();
      if (!current) return null;
      try {
        return await current.webContents.capturePage();
      } catch (err) {
        console.error("[WindowManager] capturePetWindow failed:", err);
        return null;
      }
    },
    setIconForAllWindows(icon: NativeImage): void {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.setIcon(icon);
      }
    },
    getCursorScreenPosition(): Point {
      return screen.getCursorScreenPoint();
    },
    sendToPetWindow(channel: string, payload?: unknown): boolean {
      const current = livePet();
      if (!current || current.webContents.isDestroyed()) return false;
      if (payload === undefined) current.webContents.send(channel);
      else current.webContents.send(channel, payload);
      return true;
    },
    isPetWindowSender(webContentsId: number): boolean {
      return livePet()?.webContents.id === webContentsId;
    },
    broadcast(channel: string, payload: unknown): void {
      broadcastToAllWindows(channel, payload);
    },

    onPetWindowReady(handler: (win: BrowserWindow) => void): void {
      readyHooks.push(handler);
      const current = livePet();
      if (current && current.isVisible()) fanOut([handler], "ready", current);
    },
    onPetWindowClosed(handler: () => void): void {
      closedHooks.push(handler);
    },
    onPetWindowMoved(handler: (position: Point) => void): void {
      movedHooks.push(handler);
    },

    dispose(): void {
      // 目前没有需要主动释放的资源
    },
  };

  return manager;
}
