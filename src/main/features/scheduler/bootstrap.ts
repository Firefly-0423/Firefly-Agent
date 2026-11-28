import type { BrowserWindow } from "electron";
import type { BackgroundMemoryHost } from "../../agent/memory-runtime/background-memory-ingress";
import type { IpcScope } from "../../base/ipc/ipc-scope";
import type { AgentRuntime } from "../../agent/runtime/agent-runtime";
import { toolRegistry } from "../../tooling/registry/tool-registry";
import type { LifecyclePublisher } from "../../agent/runtime/lifecycle-publisher";
import { IPC } from "../../../shared/ipc-channels";
import { getSchedulerStore } from "./scheduler-store";
import { createSchedulerRunner } from "./scheduler-runner";
import { registerSchedulerIpc, type PluginTaskEnableGuard } from "./scheduler-ipc";
import { SchedulerEngine, type SchedulerEngineDeps } from "./scheduler-engine";
import type { ScheduledRunResult, ScheduledTask } from "../../platform/schedule/schedule-types";

/** Sent to the chat window after the plugin host finished a scheduled run; the task panel re-reads that task and its history. */
export const PLUGIN_TASK_FINISHED_EVENT = "scheduler.plugin_task_finished";

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
  // The agent runner sends its own run events; a run the plugin host performs does not, so tell the chat panel to re-read afterwards.
  const announcePluginTaskFinished = (taskId: string): void => {
    const chat = services.getReactChatWindow();
    if (chat && !chat.isDestroyed()) {
      chat.webContents.send(IPC.SCHEDULER_EVENT, { type: "CUSTOM", name: PLUGIN_TASK_FINISHED_EVENT, schedulerTaskId: taskId });
    }
  };
  const wiring: SchedulerEngineDeps = {
    store: repository,
    runTask: (task, scheduledFireAt, manual) => {
      const delegated = services.runPluginTask?.(task, scheduledFireAt, manual);
      if (!delegated) return executor.runScheduledTask(task, scheduledFireAt, manual);
      return delegated.finally(() => announcePluginTaskFinished(task.id));
    },
    ...(services.canRunTask ? { canRunTask: services.canRunTask } : {}),
  };
  const clockwork = services.createEngine ? services.createEngine(wiring) : new SchedulerEngine(wiring);
  const install = services.registerIpc ?? registerSchedulerIpc;
  let loaded = false;
  const initialize = (): void => {
    if (loaded) return;
    loaded = true;
    repository.load();
    install(repository, clockwork, () => toolRegistry.getAllTools(), services.ipc, services.guardPluginTaskEnable, services.canRunTask);
  };
  const start = (): void => { clockwork.start(); };
  const stop = async (): Promise<void> => {
    clockwork.stop();
    await executor.close();
  };
  return { store: repository, engine: clockwork, runAgentTask: executor.runScheduledTask, initialize, start, stop };
}
