export type PluginEventBusListener = (payload: unknown) => void | Promise<void>;

const EVENT_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export const PLUGIN_EVENT_LISTENER_TIMEOUT_MS = 5_000;

type ErrorSink = (event: string, error: unknown) => void;

/** 带超时地执行单个监听器，避免它拖住后续监听器或宿主的停止流程。 */
async function runEventListener(listener: PluginEventBusListener, payload: unknown, event: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`事件监听器 ${event} 执行超时（${PLUGIN_EVENT_LISTENER_TIMEOUT_MS}ms）`)),
      PLUGIN_EVENT_LISTENER_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([Promise.resolve().then(() => listener(payload)), expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 普通发布时派发单个监听器：同步调用，返回的 Promise 不阻塞派发循环。
 * 异步结果另外挂超时与错误日志；超时只是忽略迟到的结果，管不了监听器自己的同步执行。
 */
function dispatchListener(listener: PluginEventBusListener, payload: unknown, event: string, onListenerError: ErrorSink): void {
  let outcome: void | Promise<void>;
  try {
    outcome = listener(payload);
  } catch (error) {
    onListenerError(event, error);
    return;
  }
  if (!outcome || typeof (outcome as Promise<void>).then !== "function") return;

  let finished = false;
  const settleOnce = (after?: () => void): void => {
    if (finished) return;
    finished = true;
    after?.();
  };
  const watchdog = setTimeout(() => {
    settleOnce(() =>
      onListenerError(event, new Error(`事件监听器 ${event} 异步执行超时（${PLUGIN_EVENT_LISTENER_TIMEOUT_MS}ms）`)),
    );
  }, PLUGIN_EVENT_LISTENER_TIMEOUT_MS);
  // 这个旁路计时器不应阻止主进程退出
  watchdog.unref?.();

  Promise.resolve(outcome).then(
    () => settleOnce(() => clearTimeout(watchdog)),
    (error) =>
      settleOnce(() => {
        clearTimeout(watchdog);
        onListenerError(event, error);
      }),
  );
}

function validateQualifiedEventName(event: string): void {
  // 完整事件名只开放 host 与 plugin 两个命名空间，杜绝无主的全局事件
  const parts = event.split(":");
  if (parts.length < 2 || !parts.every((part) => EVENT_SEGMENT_RE.test(part))) {
    throw new Error(`非法插件事件名: ${event}`);
  }
  const [root] = parts;
  if (root !== "host" && root !== "plugin") {
    throw new Error(`插件事件名必须使用 host 或 plugin 命名空间: ${event}`);
  }
  if (root === "plugin" && parts.length < 3) {
    throw new Error(`plugin 事件名必须包含插件 id 和事件名: ${event}`);
  }
}

export type PluginEventBus = {
  clear(): void;
  /**
   * 生命周期屏障发布：逐个等待监听器完成（各自带超时）才返回。
   * 仅用于插件系统的 ready/stopping，普通宿主事件不得走这个阻塞入口。
   */
  emitLifecycleBarrier(event: string, payload: unknown): Promise<void>;
  /**
   * 普通发布（旁路）：监听器在 setImmediate 宏任务里按快照顺序派发，
   * 发布函数返回时当前调用栈不会进入任何第三方监听器，也不等待它们的异步结果。
   * 返回的 Promise 在所有监听器都被调用之后兑现。
   */
  emit(event: string, payload: unknown): Promise<void>;
  on(event: string, listener: PluginEventBusListener): () => void;
};

type Subscription = { listener: PluginEventBusListener };

export function createPluginEventBus(
  onListenerError: ErrorSink = (event, error) => {
    console.warn(`[plugins] 事件监听器处理 ${event} 失败`, error);
  },
): PluginEventBus {
  const registry = new Map<string, Set<Subscription>>();

  // 每轮发布前固定快照：监听器在回调里退订不会打乱已开始的发布顺序
  const snapshotOf = (event: string): Subscription[] => [...(registry.get(event) ?? [])];

  const on: PluginEventBus["on"] = (event, listener) => {
    validateQualifiedEventName(event);
    if (typeof listener !== "function") throw new Error("插件事件监听器必须是函数");

    const bucket = registry.get(event) ?? new Set<Subscription>();
    const subscription: Subscription = { listener };
    bucket.add(subscription);
    registry.set(event, bucket);

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      bucket.delete(subscription);
      if (bucket.size === 0) registry.delete(event);
    };
  };

  const emit: PluginEventBus["emit"] = (event, payload) =>
    // 名称校验失败以 Promise 拒绝的形式返回，与既有调用方的错误约定一致
    new Promise<void>((resolve, reject) => {
      try {
        validateQualifiedEventName(event);
      } catch (error) {
        reject(error);
        return;
      }
      const targets = snapshotOf(event);
      // 先把当前调用栈还给事件循环，监听器从后续调度的任务里开始执行
      setImmediate(() => {
        targets.forEach((sub) => dispatchListener(sub.listener, payload, event, onListenerError));
        resolve();
      });
    });

  const emitLifecycleBarrier: PluginEventBus["emitLifecycleBarrier"] = async (event, payload) => {
    validateQualifiedEventName(event);
    for (const sub of snapshotOf(event)) {
      try {
        await runEventListener(sub.listener, payload, event);
      } catch (error) {
        onListenerError(event, error);
      }
    }
  };

  return { on, emit, emitLifecycleBarrier, clear: () => registry.clear() };
}

export function qualifyPluginEvent(pluginId: string, event: string): string {
  // 插件侧只能给出一个短名称，所有者前缀由框架生成
  if (!EVENT_SEGMENT_RE.test(event)) throw new Error(`非法插件自定义事件名: ${event}`);
  return `plugin:${pluginId}:${event}`;
}

export function qualifyHostEvent(event: string): string {
  // 宿主只传主题，不能自行指定或覆盖根命名空间
  const full = `host:${event}`;
  validateQualifiedEventName(full);
  return full;
}
