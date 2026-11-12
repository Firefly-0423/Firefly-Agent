export type StartupWindowLike = {
  show(): void;
  close(): void;
  isDestroyed(): boolean;
};

export type RevealStartupWindowsOptions = {
  /** 聊天主窗口，reveal 只负责显示，不负责加载页面 */
  chatWindow: StartupWindowLike;
  /** Loading 窗口，创建失败时为 null，此时既不关闭也不等待最短展示 */
  splashWindow: StartupWindowLike | null;
  minimumDurationMs: number;
  /** Loading 实际显示时的单调时钟读数；未记录时不做最短展示等待 */
  loadingShownAt?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

const realSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 关闭 Loading 并显示聊天窗口。
 * 最短展示时长只补足从实际显示起尚欠的部分；
 * 桌宠不在这里处理，由启动编排器按 petVisible 单独创建与显示。
 */
export async function revealStartupWindows(options: RevealStartupWindowsOptions): Promise<void> {
  const { splashWindow, chatWindow, loadingShownAt, minimumDurationMs } = options;
  const clock = options.now ?? (() => performance.now());
  const pause = options.sleep ?? realSleep;

  const owed = loadingShownAt === undefined ? 0 : Math.max(0, minimumDurationMs - (clock() - loadingShownAt));
  if (owed > 0) await pause(owed);

  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  if (!chatWindow.isDestroyed()) chatWindow.show();
}
