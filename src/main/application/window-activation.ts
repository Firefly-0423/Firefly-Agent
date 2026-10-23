// 窗口激活代理：启动期间把激活请求按 kind 去重缓存（后到覆盖先到），
// 每次缓存时提示一次“加载中”；就绪后按插入顺序依次放行。
// stop 后丢弃队列且不再接受请求。桌宠不走这里，可见性由设置开关管理。

export type WindowActivationRequest =
  | { kind: "music" }
  | { kind: "settings"; section?: string }
  | { kind: "sidebar" }
  | { kind: "chat"; sessionId?: string };

export interface WindowActivationActions {
  activate(request: WindowActivationRequest): void | Promise<void>;
  focusLoading(): void;
}

export interface WindowActivationBroker {
  isReady(): boolean;
  stop(): void;
  markReady(): Promise<void>;
  request(request: WindowActivationRequest): void;
  bind(actions: WindowActivationActions): void;
}

type RequestKind = WindowActivationRequest["kind"];

export function createWindowActivationBroker(): WindowActivationBroker {
  const queue = new Map<RequestKind, WindowActivationRequest>();
  const state = { actions: null as WindowActivationActions | null, ready: false, stopped: false };

  const swallow = (): void => {
    // 失败由动作实现自行处理，这里不让它影响启动状态
  };

  const fireAndForget = (req: WindowActivationRequest): void => {
    const target = state.actions;
    if (!target) return;
    Promise.resolve()
      .then(() => target.activate(req))
      .catch(swallow);
  };

  return {
    bind(next) {
      state.actions = next;
    },

    request(req) {
      if (state.stopped) return;
      if (state.ready) return fireAndForget(req);
      state.actions?.focusLoading();
      queue.set(req.kind, req);
    },

    markReady() {
      if (state.ready || state.stopped) return Promise.resolve();
      state.ready = true;

      const backlog = Array.from(queue.values());
      queue.clear();
      const done = backlog.reduce<Promise<void>>(
        (prev, req) =>
          prev.then(() => {
            const target = state.actions;
            if (!target) return;
            return Promise.resolve(target.activate(req)).catch(swallow);
          }),
        Promise.resolve(),
      );
      return done.then(() => undefined);
    },

    stop() {
      state.stopped = true;
      queue.clear();
    },

    isReady: () => state.ready,
  };
}
