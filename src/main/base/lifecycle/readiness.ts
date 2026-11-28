// 启动就绪状态机。
// 阶段推进和“能力降级”是两条独立的线：降级只登记原因，不影响阶段。

export type StartupPhase =
  | "failed"
  | "stopped"
  | "stopping"
  | "preparing"
  | "shell-ready"
  | "core-ready"
  | "background-starting"
  | "ready";

export interface DegradedReason {
  at: number;
  capability: string;
  error?: unknown;
  message: string;
}

export interface StartupReadiness {
  clearDegraded(capability: string): void;
  getDegradedReasons(): ReadonlyMap<string, DegradedReason>;
  getPhase(): StartupPhase;
  markDegraded(reason: DegradedReason): void;
  transition(next: StartupPhase): void;
  waitFor(target: "core-ready" | "ready", signal?: AbortSignal): Promise<void>;
}

export interface CreateStartupReadinessOptions {
  /** 测试可注入时钟，默认 Date.now */
  now?: () => number;
}

// 合法迁移表：正常启动是一条直线，除 stopped 外任何阶段都可以进入 stopping，
// 启动中的阶段还可以直接失败。
const ALLOWED_TRANSITIONS: Readonly<Record<StartupPhase, readonly StartupPhase[]>> = {
  stopped: [],
  failed: ["stopping"],
  stopping: ["stopped"],
  ready: ["stopping"],
  "background-starting": ["failed", "stopping", "ready"],
  "core-ready": ["failed", "stopping", "background-starting"],
  "shell-ready": ["failed", "stopping", "core-ready"],
  preparing: ["failed", "stopping", "shell-ready"],
};

// 启动线上的序号，用来判断“是否已到达”；退出和失败阶段不在此表中
const STARTUP_RANK: Readonly<Record<string, number>> = {
  ready: 4,
  "background-starting": 3,
  "core-ready": 2,
  "shell-ready": 1,
  preparing: 0,
};

// 这些阶段会让所有等待者失败
const ABORT_TEXT: Readonly<Partial<Record<StartupPhase, string>>> = {
  stopped: "startup aborted: stopped",
  stopping: "startup aborted: stopping",
  failed: "startup failed",
};

interface Waiter {
  cleanup: () => void;
  reject: (error: unknown) => void;
  resolve: () => void;
  target: "core-ready" | "ready";
}

export function createStartupReadiness(options: CreateStartupReadinessOptions = {}): StartupReadiness {
  const clock = options.now ?? Date.now;
  const degradedMap = new Map<string, DegradedReason>();
  const waiting = new Set<Waiter>();
  let current: StartupPhase = "preparing";

  const flushWaiters = (): void => {
    if (!waiting.size) return;

    const abortText = ABORT_TEXT[current];
    if (abortText !== undefined) {
      const snapshot = Array.from(waiting);
      waiting.clear();
      snapshot.forEach((w) => {
        w.cleanup();
        w.reject(new Error(abortText));
      });
      return;
    }

    const rank = STARTUP_RANK[current];
    if (rank === undefined) return;
    Array.from(waiting)
      .filter((w) => rank >= STARTUP_RANK[w.target])
      .forEach((w) => {
        waiting.delete(w);
        w.cleanup();
        w.resolve();
      });
  };

  return {
    getPhase: () => current,

    transition(next) {
      if (!ALLOWED_TRANSITIONS[current].includes(next)) {
        throw new Error(`invalid startup phase transition: ${current} -> ${next}`);
      }
      current = next;
      flushWaiters();
    },

    waitFor(target, signal) {
      const abortText = ABORT_TEXT[current];
      if (abortText !== undefined) return Promise.reject(new Error(abortText));

      const rank = STARTUP_RANK[current];
      if (rank !== undefined && rank >= STARTUP_RANK[target]) return Promise.resolve();

      if (signal?.aborted) return Promise.reject(new Error("startup wait aborted"));

      return new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          waiting.delete(waiter);
          reject(new Error("startup wait aborted"));
        };
        const waiter: Waiter = {
          cleanup: () => {
            signal?.removeEventListener("abort", onAbort);
          },
          reject,
          resolve,
          target,
        };
        waiting.add(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },

    markDegraded(reason) {
      degradedMap.set(reason.capability, { ...reason, at: reason.at ?? clock() });
    },

    clearDegraded(capability) {
      degradedMap.delete(capability);
    },

    getDegradedReasons: () => degradedMap,
  };
}
