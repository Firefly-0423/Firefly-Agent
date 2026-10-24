// 把 Electron 的退出相关事件接到统一的关停协调器上。
// before-quit 仅作兜底：第一次触发时拦截并转入受控关停，
// 进入最终阶段后再触发的退出一律放行。
// Windows 会话结束只允许同步紧急落盘，不能等待耗时清理。

import type { ShutdownCoordinator } from "./shutdown";

type Preventable = { preventDefault(): void };
type SessionEndEvent = "query-session-end" | "session-end";

export interface AppLifecycleLike {
  quit(): void;
  removeListener(event: "before-quit", listener: (event: Preventable) => void): void;
  on(event: "before-quit", listener: (event: Preventable) => void): void;
}

export interface SessionEndWindowLike {
  removeListener(event: SessionEndEvent, listener: (event: Preventable) => void): void;
  on(event: SessionEndEvent, listener: (event: Preventable) => void): void;
}

export function installAppShutdownHandlers(input: {
  coordinator: ShutdownCoordinator;
  app: AppLifecycleLike;
}): () => void {
  const { coordinator, app } = input;

  const handler = (evt: { preventDefault(): void }): void => {
    if (coordinator.isFinalizing()) return;
    evt.preventDefault();
    void coordinator.requestControlledShutdown({
      reason: "before-quit",
      finalAction: () => app.quit(),
    });
  };

  app.on("before-quit", handler);
  return () => {
    app.removeListener("before-quit", handler);
  };
}

export function attachWindowsSessionEndHandlers(input: {
  coordinator: ShutdownCoordinator;
  window: SessionEndWindowLike;
}): () => void {
  const { coordinator, window } = input;
  const events = ["query-session-end", "session-end"] as const;

  // 仅同步幂等落盘，不拦截系统退出
  const flush = (): void => {
    coordinator.emergencyFlush();
  };

  events.forEach((name) => window.on(name, flush));
  return () => {
    events.forEach((name) => window.removeListener(name, flush));
  };
}

export interface UpdateLifecycleLike {
  on(event: "before-quit-for-update", listener: () => void): void;
  removeListener(event: "before-quit-for-update", listener: () => void): void;
}

/**
 * 更新安装兜底：若有路径绕过更新 IPC 直接 quitAndInstall，
 * updater 会先发出 before-quit-for-update，这里把它并入同一个幂等协调器，
 * 使清理和安装仍然遵循受控关停顺序。
 */
export function installUpdateShutdownFallback(input: {
  finalAction(): void;
  coordinator: ShutdownCoordinator;
  updater: UpdateLifecycleLike;
}): () => void {
  const { finalAction, coordinator, updater } = input;

  const handler = (): void => {
    if (coordinator.isStopping()) return;
    void coordinator.requestControlledShutdown({ reason: "update-install", finalAction });
  };

  updater.on("before-quit-for-update", handler);
  return () => {
    updater.removeListener("before-quit-for-update", handler);
  };
}
