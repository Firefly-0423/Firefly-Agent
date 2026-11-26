import type { BrowserWindow } from "electron";
import type { BackgroundMemoryHost } from "../../agent/memory-runtime/background-memory-ingress";
import type { IpcScope } from "../../base/ipc/ipc-scope";
import type { AgentRuntime } from "../../agent/runtime/agent-runtime";
import { toolRegistry } from "../../tooling/registry/tool-registry";
import type { LifecyclePublisher } from "../../agent/runtime/lifecycle-publisher";
import { getSchedulerStore } from "./scheduler-store";
import { createSchedulerRunner } from "./scheduler-runner";
import { registerSchedulerIpc, type PluginTaskEnableGuard } from "./scheduler-ipc";
import { SchedulerEngine, type SchedulerEngineDeps } from "./scheduler-engine";
import type { ScheduledRunResult, ScheduledTask } from "../../platform/schedule/schedule-types";

type StoreHandle = ReturnType<typeof getSchedulerStore>;
export type SchedulerSubsystemDeps = {
  publishLifecycle?: LifecyclePublisher;
  canRunTask?: (task: ScheduledTask) => boolean;
  /** Runs a task a plugin host owns; returns undefined when the host does not own it so the agent runner takes it. */
  runPluginTask?: (task: ScheduledTask, scheduledFireAt: Date, manual: boolean) => Promise<ScheduledRunResult> | undefined;
  /** Refuses to save an enabled plugin task the plugin host cannot run unattended (see PluginTaskEnableGuard). */
  guardPluginTaskEnable?: PluginTaskEnableGuard;
  ipc?: IpcScope;
  registerIpc?: typeof registerSchedulerIpc;
  createEngine?: (deps: SchedulerEngineDeps) => SchedulerEngine;
  store?: StoreHandle;
  getReactChatWindow(): BrowserWindow | null;
  memoryHost?: BackgroundMemoryHost;
  agentRuntime: AgentRuntime;
};
export type SchedulerSubsystem = {
  stop(): Promise<void>;
  start(): void;
  initialize(): void;
  engine: SchedulerEngine;
  /** The agent runner, for hosts that run `run` actions of plugin tasks themselves. */
  runAgentTask: SchedulerEngineDeps["runTask"];
  store: StoreHandle;
};

export function createSchedulerSubsystem(services: SchedulerSubsystemDeps): SchedulerSubsystem {
  const repository = services.store ?? getSchedulerStore();
  const executor = createSchedulerRunner({
    memoryHost: services.memoryHost,
    buildOptions: (job) => services.agentRuntime.buildSchedulerOptions(job),
    getChatWebContents: () => {
      const chat = services.getReactChatWindow();
      return chat && !chat.isDestroyed() ? chat.webContents : null;
    },
    recordHistory: (row) => repository.recordHistory(row),
    id: () => `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    now: () => new Date(),
    ...(services.publishLifecycle ? { publishLifecycle: services.publishLifecycle } : {}),
  });
  const wiring: SchedulerEngineDeps = {
    store: repository,
    runTask: (task, scheduledFireAt, manual) =>
      services.runPluginTask?.(task, scheduledFireAt, manual) ?? executor.runScheduledTask(task, scheduledFireAt, manual),
    ...(services.canRunTask ? { canRunTask: services.canRunTask } : {}),
  };
  const clockwork = services.createEngine ? services.createEngine(wiring) : new SchedulerEngine(wiring);
  const install = services.registerIpc ?? registerSchedulerIpc;
  let loaded = false;
  const initialize = (): void => {
    if (loaded) return;
    loaded = true;
    repository.load();
    install(repository, clockwork, () => toolRegistry.getAllTools(), services.ipc, services.guardPluginTaskEnable);
  };
  const start = (): void => { clockwork.start(); };
  const stop = async (): Promise<void> => {
    clockwork.stop();
    await executor.close();
  };
  return { store: repository, engine: clockwork, runAgentTask: executor.runScheduledTask, initialize, start, stop };
}
