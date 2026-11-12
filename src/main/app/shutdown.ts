// 受控关停协调器：
// 清理项按固定阶段依次执行（与注册先后无关），同阶段内并行并等待全部落定；
// 某一项失败只记日志，不影响后续阶段。总超时到达时发出中止信号，
// 列出尚未完成的资源后不再等待。

import type { StartupReadiness } from "./readiness";

export type ShutdownPhase =
  | "flushPersistence"
  | "stopLocalResources"
  | "stopExternalProviders"
  | "stopExternalConsumers"
  | "stopActiveWork"
  | "stopProducers"
  | "quiesce";

// 阶段顺序是固定的，不能改成倒序注册
const PHASES_IN_ORDER: readonly ShutdownPhase[] = [
  "quiesce",
  "stopProducers",
  "stopActiveWork",
  "stopExternalConsumers",
  "stopExternalProviders",
  "stopLocalResources",
  "flushPersistence",
];

export interface ShutdownCoordinator {
  isFinalizing(): boolean;
  isStopping(): boolean;
  emergencyFlush(): void;
  requestControlledShutdown(input: {
    reason: string;
    finalAction(): void;
  }): Promise<boolean>;
  registerEmergencyFlush(id: string, flush: () => void): () => void;
  register(input: {
    id: string;
    phase: ShutdownPhase;
    dispose(signal: AbortSignal): void | Promise<void>;
  }): () => void;
}

interface Registration {
  dispose(signal: AbortSignal): void | Promise<void>;
  phase: ShutdownPhase;
  id: string;
}

export interface CreateShutdownCoordinatorOptions {
  log?: (message: string, error?: unknown) => void;
  clearTimeout?: typeof globalThis.clearTimeout;
  setTimeout?: typeof globalThis.setTimeout;
  timeoutMs?: number;
  beforeShutdown?: () => Promise<boolean>;
  readiness: StartupReadiness;
}

const DEFAULT_TIMEOUT_MS = 10_000;

type ShutdownRequest = { reason: string; finalAction(): void };

export function createShutdownCoordinator(options: CreateShutdownCoordinatorOptions): ShutdownCoordinator {
  const { readiness } = options;
  const limitMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const schedule = options.setTimeout ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const unschedule = options.clearTimeout ?? ((h: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(h));
  const log = options.log ?? ((message, error) => console.error(message, error));

  const entries = new Map<string, Registration>();
  const flushers = new Map<string, () => void>();
  const flags = { stopping: false, finalizing: false, flushed: false };
  let running: Promise<boolean> | null = null;
  let asking: Promise<boolean> | null = null;
  let initiator: ShutdownRequest | null = null;

  const runOne = async (entry: Registration, signal: AbortSignal, unfinished: Set<string>): Promise<void> => {
    try {
      await entry.dispose(signal);
    } catch (error) {
      log(`shutdown: dispose failed for ${entry.id} (${entry.phase})`, error);
    } finally {
      unfinished.delete(entry.id);
    }
  };

  const runAllPhases = async (signal: AbortSignal, unfinished: Set<string>): Promise<void> => {
    for (const phase of PHASES_IN_ORDER) {
      if (signal.aborted) return;
      const group = Array.from(entries.values()).filter((e) => e.phase === phase);
      if (!group.length) continue;
      group.forEach((e) => unfinished.add(e.id));
      await Promise.allSettled(group.map((e) => runOne(e, signal, unfinished)));
    }
  };

  const finish = (): void => {
    if (flags.finalizing) return;
    try {
      if (readiness.getPhase() === "stopping") readiness.transition("stopped");
    } catch (error) {
      log("shutdown: readiness transition to stopped failed", error);
    }
    flags.finalizing = true;
    if (!initiator) return;
    try {
      initiator.finalAction();
    } catch (error) {
      log(`shutdown: finalAction failed (${initiator.reason})`, error);
    }
  };

  const begin = (request: ShutdownRequest): Promise<boolean> => {
    initiator = request;
    flags.stopping = true;
    try {
      if (readiness.getPhase() !== "stopped") readiness.transition("stopping");
    } catch (error) {
      log("shutdown: readiness transition to stopping failed", error);
    }

    const abort = new AbortController();
    const unfinished = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timer = schedule(() => {
        abort.abort();
        log(`shutdown: total timeout (${limitMs}ms) reached, incomplete resources: ${Array.from(unfinished).join(", ") || "(none)"}`);
        resolve();
      }, limitMs);
    });

    running = Promise.race([runAllPhases(abort.signal, unfinished), timedOut]).then(() => {
      if (timer !== undefined) unschedule(timer);
      finish();
      return true;
    });
    return running;
  };

  return {
    register({ id, phase, dispose }) {
      entries.set(id, { id, phase, dispose });
      return () => {
        entries.delete(id);
      };
    },

    registerEmergencyFlush(id, flush) {
      flushers.set(id, flush);
      return () => {
        flushers.delete(id);
      };
    },

    requestControlledShutdown(input) {
      // 重复请求共用同一个 Promise，finalAction 只取首个请求的
      if (running) return running;
      if (!options.beforeShutdown) return begin(input);
      if (asking) return asking;
      // Keep isStopping false and retain every IPC/resource while the user decides.
      // Assignment precedes invocation, so repeated quit/update requests share one prompt.
      asking = Promise.resolve()
        .then(() => options.beforeShutdown!())
        .then((ok) => (ok ? begin(input) : false))
        .catch((error) => {
          log("shutdown: preflight failed; shutdown cancelled", error);
          return false;
        })
        .finally(() => {
          asking = null;
        });
      return asking;
    },

    // 同步幂等的紧急落盘，不等网络，也不走完整关停流程
    emergencyFlush() {
      if (flags.flushed) return;
      flags.flushed = true;
      flushers.forEach((flush, id) => {
        try {
          flush();
        } catch (error) {
          log(`shutdown: emergency flush failed for ${id}`, error);
        }
      });
    },

    isStopping: () => flags.stopping,
    isFinalizing: () => flags.finalizing,
  };
}
