/**
 * 后台启动阶段：首屏之后的软启动，不阻塞界面。
 * 每个任务都经由 BackgroundTaskRunner 登记：获得中止信号，退出时被 abort，
 * 来不及结算的任务若稍后返回了 dispose，会被立即调用。
 *
 * 四个任务组并发执行，组内严格串行：
 *   A: MCP 清理、内置同步、MCP 恢复（30 秒屏障）、channels、scheduler、主动触发器
 *   B: 记忆协调、向量索引刷新、重排序器初始化
 *   C: 截图预热
 *   D: 更新检查
 * 四组全部落定后推进到 ready；任何失败只记为降级，不影响聊天。
 */

import type { StartupReadiness } from "./readiness";
import type { ShutdownCoordinator } from "./shutdown";
import type { CoreResult } from "./core-bootstrap";
import type { ChannelsSubsystem } from "../channels/bootstrap";
import type { SchedulerSubsystem } from "../scheduler/bootstrap";

/** MCP 恢复屏障的最长等待；超时后 channels 与 scheduler 照常启动，MCP 标记为降级。 */
export const MCP_RESTORE_BARRIER_TIMEOUT_MS = 30_000;

export interface BackgroundDependencies {
  startProactiveTrigger(signal: AbortSignal): Promise<{ dispose(): void | Promise<void> } | void>;
  scheduleUpdateCheck(signal: AbortSignal): Promise<{ dispose(): void | Promise<void> } | void>;
  prewarmScreenshot(signal: AbortSignal): Promise<void>;
  initializeReranker(signal: AbortSignal): Promise<void>;
  scheduleEmbeddingRefresh(signal: AbortSignal): Promise<{ dispose(): void | Promise<void> } | void>;
  reconcileMemory(signal: AbortSignal): Promise<void>;
  restoreMcp(signal: AbortSignal): Promise<void>;
  syncBuiltInMcp(signal: AbortSignal): Promise<void>;
  pruneRemovedMcp(signal: AbortSignal): Promise<void>;
  shutdown: ShutdownCoordinator;
  readiness: StartupReadiness;
  scheduler: SchedulerSubsystem;
  channels: ChannelsSubsystem;
  core: CoreResult;
}

export interface BackgroundHandle {
  stop(signal?: AbortSignal): Promise<void>;
  settled: Promise<void>;
}

export interface BackgroundTaskRunner {
  stop(signal?: AbortSignal): Promise<void>;
  run<T>(id: string, task: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

interface RunnerEntry {
  promise: Promise<unknown>;
  id: string;
}

type OptionalDisposer = { dispose(): void | Promise<void> } | void | undefined;

// 任务在停止之后才完成时，对它返回的可释放对象做一次兜底清理
async function releaseLateResult(result: unknown): Promise<void> {
  const holder = result as { dispose?: unknown } | null | undefined;
  if (!holder || typeof holder.dispose !== "function") return;
  try {
    await (holder as { dispose(): void | Promise<void> }).dispose();
  } catch (error) {
    console.error("[Background] late dispose failed:", error);
  }
}

/**
 * 带登记的任务运行器：
 * 停止后拒绝新任务；stop 会中止共享信号并等待已登记任务落定
 * （若传入了信号，则最多等到该信号中止）。
 */
export function createBackgroundTaskRunner(): BackgroundTaskRunner {
  const abortAll = new AbortController();
  const running = new Map<string, RunnerEntry>();
  let closed = false;

  return {
    run<T>(id: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (closed) {
        return Promise.reject(new Error(`background runner stopped: task ${id} not started`));
      }
      const tracked = task(abortAll.signal).then(
        async (value) => {
          if (closed) await releaseLateResult(value);
          running.delete(id);
          return value;
        },
        (reason) => {
          running.delete(id);
          throw reason;
        },
      );
      running.set(id, { id, promise: tracked });
      return tracked;
    },

    async stop(signal?: AbortSignal): Promise<void> {
      closed = true;
      abortAll.abort();
      const inflight = Array.from(running.values());
      if (!inflight.length) return;

      const allDone = Promise.allSettled(inflight.map((e) => e.promise.catch(() => undefined)));
      if (!signal) {
        await allDone;
        return;
      }
      const giveUp = new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await Promise.race([allDone, giveUp]);
    },
  };
}

async function disposeIfAny(maybe: OptionalDisposer): Promise<void> {
  if (maybe && typeof maybe.dispose === "function") await maybe.dispose();
}

export function startBackground(deps: BackgroundDependencies): BackgroundHandle {
  const { readiness, shutdown, channels, scheduler } = deps;
  const runner = createBackgroundTaskRunner();

  const disposers: {
    proactive: OptionalDisposer;
    updateCheck: OptionalDisposer;
    embedding: OptionalDisposer;
  } = { proactive: undefined, updateCheck: undefined, embedding: undefined };

  const winding = (): boolean => ["stopping", "stopped", "failed"].includes(readiness.getPhase());

  // 启动耗时埋点，便于排查启动性能
  const reportTiming = (label: string, startedAt: number): void => {
    const now = performance.now();
    console.log(`[StartupTiming] ${label} ${Math.round(now - startedAt)}ms (at ${Math.round(now)}ms)`);
  };

  // 跑单个任务：出错时登记降级（若正在退出则只写日志），并让组内后续任务继续
  const track = async <T>(
    id: string,
    capability: string,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> => {
    const startedAt = performance.now();
    try {
      const value = await runner.run(id, task);
      reportTiming(`bg/${id}`, startedAt);
      return value;
    } catch (error) {
      if (winding()) {
        console.warn(`[Background] ${id} aborted during shutdown`);
      } else {
        console.error(`[Background] ${id} failed:`, error);
        const message = error instanceof Error ? error.message : String(error);
        readiness.markDegraded({ capability, message, at: Date.now(), error });
      }
      return undefined;
    }
  };

  // 关停登记：quiesce 先停掉后台任务，周期性的生产者放在 stopProducers。
  // 尚未落定的任务若之后返回 dispose，由 runner 负责兜底。
  const registrations: Array<[string, "quiesce" | "stopProducers", (signal: AbortSignal) => Promise<void>]> = [
    ["background-runner", "quiesce", (signal) => runner.stop(signal)],
    ["proactive-trigger", "stopProducers", async () => { await disposeIfAny(disposers.proactive); }],
    ["scheduler", "stopProducers", async () => { await scheduler.stop(); }],
    ["embedding-refresh", "stopProducers", async () => { await disposeIfAny(disposers.embedding); }],
    ["update-check-timer", "stopProducers", async () => { await disposeIfAny(disposers.updateCheck); }],
  ];
  for (const [id, phase, dispose] of registrations) {
    shutdown.register({ id, phase, dispose });
  }

  const runGroupA = async (): Promise<void> => {
    await track("mcp-prune", "mcp", (signal) => deps.pruneRemovedMcp(signal));
    await track("mcp-sync-builtin", "mcp", (signal) => deps.syncBuiltInMcp(signal));

    // 恢复屏障：等恢复尝试结算（成功、失败或 30 秒超时）。
    // 超时后恢复任务仍留在 runner 里，所有权不丢。
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), MCP_RESTORE_BARRIER_TIMEOUT_MS);
    });
    const outcome = await Promise.race([
      track("mcp-restore", "mcp", (signal) => deps.restoreMcp(signal)).then(() => "settled" as const),
      expired,
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome === "timeout") {
      const barrierNote = `MCP restore barrier timeout after ${MCP_RESTORE_BARRIER_TIMEOUT_MS}ms`;
      console.error(`[Background] ${barrierNote}; continuing degraded`);
      readiness.markDegraded({ capability: "mcp", message: barrierNote, at: Date.now() });
    }

    await track("channels-start", "channels", async (signal) => {
      if (signal.aborted) throw new Error("aborted before channels start");
      await channels.start(signal);
    });
    await track("scheduler-start", "scheduler", (signal) => {
      if (signal.aborted) throw new Error("aborted before scheduler start");
      scheduler.start();
      return Promise.resolve();
    });
    await track("proactive-trigger", "proactive", async (signal) => {
      if (signal.aborted) throw new Error("aborted before proactive trigger start");
      disposers.proactive = await deps.startProactiveTrigger(signal);
    });
  };

  const runGroupB = async (): Promise<void> => {
    await track("memory-reconcile", "memory", (signal) => deps.reconcileMemory(signal));
    await track("embedding-refresh", "embedding", async (signal) => {
      disposers.embedding = await deps.scheduleEmbeddingRefresh(signal);
    });
    await track("reranker-init", "reranker", (signal) => deps.initializeReranker(signal));
  };

  const runGroupC = async (): Promise<void> => {
    await track("screenshot-prewarm", "screenshot", (signal) => deps.prewarmScreenshot(signal));
  };

  const runGroupD = async (): Promise<void> => {
    await track("update-check", "update-check", async (signal) => {
      disposers.updateCheck = await deps.scheduleUpdateCheck(signal);
    });
  };

  const settled = (async () => {
    await Promise.allSettled([runGroupA(), runGroupB(), runGroupC(), runGroupD()]);
    try {
      if (readiness.getPhase() === "background-starting") readiness.transition("ready");
    } catch (error) {
      console.warn("[Background] readiness transition to ready failed:", error);
    }
  })();

  return {
    settled,
    stop(signal?: AbortSignal) {
      return runner.stop(signal);
    },
  };
}
