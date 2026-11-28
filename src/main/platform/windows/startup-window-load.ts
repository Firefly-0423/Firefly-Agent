/**
 * 启动阶段加载窗口页面：同时管理三件事——页面加载本身、ready-to-show 的时限等待、
 * 主框架加载失败的判定。聊天窗口壳可以先建好，等 IPC 注册完毕再真正加载页面。
 */

type FailListener = (_event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => void;

export interface StartupLoadWindowLike {
  webContents: {
    removeListener(event: "did-fail-load", listener: FailListener): void;
    once(event: "did-fail-load", listener: FailListener): void;
  };
  removeListener(event: "ready-to-show", listener: () => void): void;
  once(event: "ready-to-show", listener: () => void): void;
}

export interface LoadWindowForStartupInput {
  clearTimeout?: typeof globalThis.clearTimeout;
  setTimeout?: typeof globalThis.setTimeout;
  timeoutMs: number;
  load(): Promise<void>;
  window: StartupLoadWindowLike;
}

/**
 * 调用 load 后，在 timeoutMs 内等待 ready-to-show。
 * - load 抛出的错误原样向外传递；
 * - 只有主框架的 did-fail-load 会让 Promise 失败，子框架的失败忽略；
 * - 超时的错误信息固定为 "ready-to-show timeout"。
 */
export function loadWindowForStartup(input: LoadWindowForStartupInput): Promise<void> {
  const { window, load, timeoutMs } = input;
  const schedule =
    input.setTimeout ?? ((run: () => void, ms: number) => globalThis.setTimeout(run, ms));
  const cancel =
    input.clearTimeout ?? ((handle: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(handle));

  return new Promise<void>((resolve, reject) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (action: () => void): void => {
      if (finished) return;
      finished = true;
      window.removeListener("ready-to-show", handleReady);
      window.webContents.removeListener("did-fail-load", handleFail);
      if (timer !== undefined) cancel(timer);
      action();
    };

    const handleReady = (): void => finish(resolve);

    const handleFail: FailListener = (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame) return;
      finish(() => reject(new Error(`chat page did-fail-load ${code}: ${description} ${url}`)));
    };

    // 先挂监听再触发加载，否则可能漏掉很快的失败事件。
    window.once("ready-to-show", handleReady);
    window.webContents.once("did-fail-load", handleFail);
    timer = schedule(() => finish(() => reject(new Error("ready-to-show timeout"))), timeoutMs);

    Promise.resolve()
      .then(load)
      .catch((error) => finish(() => reject(error)));
  });
}

/** 聊天窗口等待 ready-to-show 的上限（毫秒）。 */
export const CHAT_READY_TIMEOUT_MS = 20_000;
