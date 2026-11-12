/**
 * Shell 阶段：搭出最小可见的外壳，供后续阶段挂载功能。
 * 步骤顺序：启动日志、Loading 窗口（记录实际显示时刻）、IPC Scope、
 * WindowManager、未载入页面的聊天窗口、绑定激活动作（此时不放行）、
 * 协议与壳层 IPC、托盘、退出清理登记，最后推进到 shell-ready。
 * 本阶段不加载任何功能页面，也不启动较重的后台能力。
 */

import type { BrowserWindow, Tray } from "electron";
import { createWindowLifecycleTracker, type TrackedBrowserWindowLike } from "../platform/windows/electron-window-lifecycle";
import { attachWindowsSessionEndHandlers } from "./electron-lifecycle";
import type { IpcScope } from "../base/ipc/ipc-scope";
import type { StartupReadiness } from "./readiness";
import type { ShutdownCoordinator } from "./shutdown";
import type { WindowActivationBroker, WindowActivationRequest } from "../platform/windows/window-activation";
import type { ReactChatWindowHandle } from "../platform/windows/create-aux-windows";
import type { WindowManager } from "../platform/windows/window-manager";

export type Live2dWindowLifecycle = ReturnType<typeof createWindowLifecycleTracker<TrackedBrowserWindowLike>>;

export interface ShellIpcRegistrationInput {
  live2dWindowLifecycle: Live2dWindowLifecycle;
  windowManager: WindowManager;
  ipc: IpcScope;
}

export interface ShellDependencies {
  writeStartupLog(): void;
  flushTokenUsage(): void;
  createTray(input: {
    requestActivation(request: WindowActivationRequest): void;
    togglePetWindow(): void;
  }): Tray;
  registerShellIpc(input: ShellIpcRegistrationInput): void;
  registerProtocolHandlers(): void;
  createChatShell(windowManager: WindowManager): ReactChatWindowHandle;
  createWindowManager(): WindowManager;
  createSplashWindow(options: { onShown(at: number): void }): BrowserWindow | null;
  onWillQuit(callback: () => void): void;
  createIpcScope(): IpcScope;
  shutdown: ShutdownCoordinator;
  activation: WindowActivationBroker;
  readiness: StartupReadiness;
}

export interface ShellResult {
  live2dWindowLifecycle: Live2dWindowLifecycle;
  tray: Tray;
  chat: ReactChatWindowHandle;
  windowManager: WindowManager;
  loadingShownAt: number | undefined;
  splashWindow: BrowserWindow | null;
  ipc: IpcScope;
}

type ActivateFn = (request: WindowActivationRequest) => Promise<void>;

function wireEmergencySessionFlush(chat: ReactChatWindowHandle, shutdown: ShutdownCoordinator): void {
  attachWindowsSessionEndHandlers({
    window: chat.window as unknown as Parameters<typeof attachWindowsSessionEndHandlers>[0]["window"],
    coordinator: shutdown,
  });
}

function makeActivate(windowManager: WindowManager): ActivateFn {
  return async (request) => {
    if (request.kind === "chat") {
      await windowManager.openReactChatWindow(request.sessionId);
    } else if (request.kind === "settings") {
      windowManager.createSettingsWindow(request.section);
    } else if (request.kind === "music") {
      windowManager.createSettingsWindow("music");
    }
    // sidebar：状态窗口已下线，无需处理
  };
}

export async function startShell(deps: ShellDependencies): Promise<ShellResult> {
  const { readiness, activation, shutdown } = deps;

  deps.writeStartupLog();

  // Loading 窗口：最短展示时间以真实 show 的时刻为起点
  const shownAt: { value: number | undefined } = { value: undefined };
  const splashWindow = deps.createSplashWindow({
    onShown(at) {
      shownAt.value = at;
    },
  });

  const ipc = deps.createIpcScope();
  deps.onWillQuit(() => ipc.dispose());
  const windowManager = deps.createWindowManager();
  const chat = deps.createChatShell(windowManager);

  const live2dWindowLifecycle = createWindowLifecycleTracker<TrackedBrowserWindowLike>("live2d-main", {
    onClosed: () => { /* 桌宠关闭后自行清理，与聊天窗口无关 */ },
  });

  // 只绑定动作；放行（markReady）由 core 阶段在窗口 reveal 之后执行
  activation.bind({
    focusLoading() {
      if (!splashWindow || splashWindow.isDestroyed()) return;
      splashWindow.show();
      splashWindow.focus();
    },
    activate: makeActivate(windowManager),
  });

  deps.registerProtocolHandlers();
  deps.registerShellIpc({ ipc, windowManager, live2dWindowLifecycle });

  // 托盘里的窗口入口统一走激活代理，退出菜单由应用层处理
  const tray = deps.createTray({
    requestActivation: (request) => activation.request(request),
    togglePetWindow: () => windowManager.togglePetWindow(),
  });

  // 登记退出清理，阶段固定
  const cleanups: Array<[string, Parameters<ShutdownCoordinator["register"]>[0]["phase"], () => void]> = [
    ["window-activation", "quiesce", () => activation.stop()],
    ["window-manager", "stopLocalResources", () => windowManager.dispose()],
    ["tray", "stopLocalResources", () => { if (!tray.isDestroyed()) tray.destroy(); }],
    ["token-usage", "flushPersistence", () => deps.flushTokenUsage()],
  ];
  for (const [id, phase, action] of cleanups) {
    shutdown.register({
      id,
      phase,
      dispose: async () => {
        action();
      },
    });
  }
  shutdown.registerEmergencyFlush("token-usage", () => deps.flushTokenUsage());

  wireEmergencySessionFlush(chat, shutdown);

  readiness.transition("shell-ready");

  return {
    ipc,
    splashWindow,
    // 异步显示事件可能在返回后到达，因此每次都读取最新时刻。
    get loadingShownAt() { return shownAt.value; },
    windowManager,
    chat,
    tray,
    live2dWindowLifecycle,
  };
}
