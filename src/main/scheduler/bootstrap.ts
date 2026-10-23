import type { BrowserWindow } from "electron";
import type { BackgroundMemoryHost } from "../memory-context/background-memory-ingress";
import type { IpcScope } from "../application/ipc-scope";
import type { AgentRuntime } from "../orchestrator/agent-runtime";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import type { LifecyclePublisher } from "../plugin-host/lifecycle-publisher";
import { getSchedulerStore } from "./scheduler-store";
import { createSchedulerRunner } from "./scheduler-runner";
import { registerSchedulerIpc } from "./scheduler-ipc";
import { SchedulerEngine, type SchedulerEngineDeps } from "./scheduler-engine";
import type { ScheduledTask } from "./types";

type StoreHandle = ReturnType<typeof getSchedulerStore>;
export type SchedulerSubsystemDeps = {
  publishLifecycle?: LifecyclePublisher;
  canRunTask?: (task: ScheduledTask) => boolean;
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
    runTask: executor.runScheduledTask,
    ...(services.canRunTask ? { canRunTask: services.canRunTask } : {}),
  };
  const clockwork = services.createEngine ? services.createEngine(wiring) : new SchedulerEngine(wiring);
  const install = services.registerIpc ?? registerSchedulerIpc;
  let loaded = false;
  const initialize = (): void => {
    if (loaded) return;
    loaded = true;
    repository.load();
    install(repository, clockwork, () => toolRegistry.getAllTools(), services.ipc);
  };
  const start = (): void => { clockwork.start(); };
  const stop = async (): Promise<void> => {
    clockwork.stop();
    await executor.close();
  };
  return { store: repository, engine: clockwork, initialize, start, stop };
}
