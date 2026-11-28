export type SingleInstanceApp = {
  on(event: "second-instance", listener: () => void): void;
  quit(): void;
  requestSingleInstanceLock(): boolean;
};

/**
 * 重复启动时唤醒已在运行的实例，避免多开 Electron 进程；
 * 具体聚焦哪个窗口由调用方决定。拿到锁返回 true。
 */
export const installSingleInstanceGuard = (
  app: SingleInstanceApp,
  focusExistingWindow: () => void,
): boolean => {
  if (app.requestSingleInstanceLock()) {
    app.on("second-instance", focusExistingWindow);
    return true;
  }
  app.quit();
  return false;
};
