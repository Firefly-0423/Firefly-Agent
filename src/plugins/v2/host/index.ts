import { mkdirSync } from "node:fs";
import { win32 } from "node:path";
import { createRpcEndpoint, type PluginRpc } from "../../../shared/plugin-rpc";
import { PluginError, type Frame } from "../../../shared/plugin-protocol";

export type PluginHostStatus = "disabled" | "starting" | "enabled" | "stopping" | "restarting" | "disabled-fault";
export type StopReason = "disabled" | "quit" | "upgrade" | "fault";
export interface HostPort {
  postMessage(frame: Frame): void;
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  removeListener(event: "message", listener: (event: { data: unknown }) => void): unknown;
  start(): void;
  close(): void;
}
export interface HostChild {
  readonly pid?: number;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  postMessage(message: unknown, ports: HostPort[]): void;
  kill(): boolean;
}
export interface PluginDefinition { entry: string; dataDir: string; memoryLimitMb?: number }
export interface HostDependencies {
  resolvePlugin(id: string): PluginDefinition;
  fork(entry: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; serviceName: string; stdio: "ignore" }): HostChild;
  createChannel(): { port1: HostPort; port2: HostPort };
  getAppMetrics(): Array<{ pid: number; memory: { workingSetSize: number } }>;
  prepareDataDir?(path: string): void;
  environment?: NodeJS.ProcessEnv;
  memoryPollMs?: number;
  configureRpc?(id: string, rpc: PluginRpc): void;
}

/** No host PATH, NODE_OPTIONS, proxy, app settings or credentials cross this boundary.
 * Windows needs its OS loader directories; POSIX uses only fixed system binaries.
 * TEMP/TMP are the only inherited writable locations, required by native runtimes.
 */
export function cleanPluginEnvironment(environment: NodeJS.ProcessEnv, platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const read = (name: string) => Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  if (platform === "win32") {
    const root = read("SystemRoot");
    if (root) { env.SystemRoot = root; env.PATH = `${win32.join(root, "System32")};${root}`; }
    else env.PATH = "";
  } else env.PATH = "/usr/bin:/bin";
  for (const key of ["TEMP", "TMP"]) { const value = read(key); if (value) env[key] = value; }
  return env;
}
interface Runtime {
  child: HostChild;
  rpc: PluginRpc;
  ports: HostPort[];
  crashed: boolean;
  finished: boolean;
  exit: () => void;
  spawn: () => void;
  rejectStartup: (error: PluginError) => void;
  startupTimer?: ReturnType<typeof setTimeout>;
  memoryTimer?: ReturnType<typeof setInterval>;
}
interface RecordState {
  state: PluginHostStatus;
  crashes: number[];
  restartAttempt: number;
  runtime?: Runtime;
  restartTimer?: ReturnType<typeof setTimeout>;
  starting?: Promise<void>;
  stopping?: Promise<void>;
}
const unavailable = () => new PluginError("ERR_UNAVAILABLE", "Plugin process is unavailable");

export class PluginHostManager {
  private readonly records = new Map<string, RecordState>();
  private readonly listeners = new Set<(event: { id: string; status: PluginHostStatus }) => void>();
  constructor(private readonly dependencies: HostDependencies) {}

  onStatusChange(listener: (event: { id: string; status: PluginHostStatus }) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  status(id: string): PluginHostStatus { return this.records.get(id)?.state ?? "disabled"; }

  start(id: string): Promise<void> {
    let record = this.records.get(id);
    if (record?.starting) return record.starting;
    if (record?.state === "enabled") return Promise.resolve();
    if (record?.stopping) return Promise.reject(unavailable());
    if (!record) {
      record = { state: "disabled", crashes: [], restartAttempt: 0 };
      this.records.set(id, record);
    }
    if (record.restartTimer) clearTimeout(record.restartTimer);
    record.restartTimer = undefined;
    const current = record;
    const started = this.launch(id, current);
    current.starting = started;
    void started.finally(() => { if (current.starting === started) current.starting = undefined; }).catch(() => {});
    return started;
  }

  stop(id: string, reason: StopReason = "disabled"): Promise<void> {
    const record = this.records.get(id);
    if (!record) return Promise.resolve();
    if (record.stopping) return record.stopping;
    if (record.restartTimer) clearTimeout(record.restartTimer);
    record.restartTimer = undefined;
    const runtime = record.runtime;
    if (!runtime) { this.setStatus(id, record, "disabled"); return Promise.resolve(); }
    this.setStatus(id, record, "stopping");
    runtime.rejectStartup(unavailable());
    if (runtime.startupTimer) clearTimeout(runtime.startupTimer);
    const stopped = (async () => {
      try { await runtime.rpc.call("deactivate", reason, { timeoutMs: 5000 }); } catch { /* Grace expired or plugin already exited. */ }
      this.finish(record, runtime, true);
      this.setStatus(id, record, "disabled");
    })();
    record.stopping = stopped;
    void stopped.finally(() => { record.stopping = undefined; }).catch(() => {});
    return stopped;
  }

  async call<T = unknown>(id: string, method: string, params: unknown, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T | { status: "unknown"; reason: string }> {
    const record = this.records.get(id), runtime = record?.runtime;
    if (record?.state !== "enabled" || !runtime) throw unavailable();
    try { return await runtime.rpc.call<T>(method, params, opts); }
    catch (error) {
      if (runtime.crashed && method === "tool.execute") return { status: "unknown", reason: "Plugin process exited during tool execution" };
      throw error;
    }
  }

  private setStatus(id: string, record: RecordState, status: PluginHostStatus): void {
    if (record.state === status) return;
    record.state = status;
    for (const listener of this.listeners) {
      // Observers must not prevent process cleanup or lifecycle transitions.
      try { listener({ id, status }); } catch { /* Observer failure is isolated. */ }
    }
  }
  private async launch(id: string, record: RecordState): Promise<void> {
    this.setStatus(id, record, "starting");
    let runtime: Runtime | undefined;
    let child: HostChild | undefined;
    let ports: { port1: HostPort; port2: HostPort } | undefined;
    try {
      const definition = this.dependencies.resolvePlugin(id);
      const limit = definition.memoryLimitMb ?? 512;
      if (!Number.isFinite(limit) || limit <= 0) throw new PluginError("ERR_INVALID_ARGUMENT", "Invalid plugin memory limit");
      (this.dependencies.prepareDataDir ?? (path => { mkdirSync(path, { recursive: true }); }))(definition.dataDir);
      const startedChild = child = this.dependencies.fork(definition.entry, [], {
        cwd: definition.dataDir, env: cleanPluginEnvironment(this.dependencies.environment ?? process.env), serviceName: `Firefly plugin ${id}`, stdio: "ignore",
      });
      const { port1, port2 } = ports = this.dependencies.createChannel();
      const rpc = createRpcEndpoint({
        post: frame => port1.postMessage(frame),
        onFrame: callback => {
          const listener = (event: { data: unknown }) => callback(event.data);
          port1.on("message", listener);
          return () => { port1.removeListener("message", listener); };
        },
      });
      let resolveStartup!: () => void, rejectStartup!: (error: PluginError) => void;
      const activated = new Promise<void>((resolve, reject) => { resolveStartup = resolve; rejectStartup = reject; });
      const deadline = Date.now() + 10_000;
      const active: Runtime = { child: startedChild, rpc, ports: [port1, port2], crashed: false, finished: false, rejectStartup,
        exit: () => this.crash(id, record, active),
        spawn: () => {
          if (active.finished || record.state !== "starting") return;
          try {
            port1.start();
            startedChild.postMessage({ type: "firefly-plugin-port" }, [port2]);
            void rpc.call("activate", { id, dataDir: definition.dataDir }, { timeoutMs: Math.max(1, deadline - Date.now()) }).then(() => resolveStartup(), rejectStartup);
          } catch { rejectStartup(new PluginError("ERR_INTERNAL", "Failed to connect plugin process")); }
        },
      };
      runtime = active; record.runtime = active;
      startedChild.on("exit", active.exit); startedChild.on("spawn", active.spawn);
      active.startupTimer = setTimeout(() => rejectStartup(new PluginError("ERR_TIMEOUT", "Plugin activation timed out")), 10_000);
      active.memoryTimer = setInterval(() => {
        const metric = this.dependencies.getAppMetrics().find(item => item.pid === startedChild.pid);
        // Electron reports workingSetSize in KiB, while configuration uses MiB.
        if (metric && metric.memory.workingSetSize > limit * 1024) this.crash(id, record, active, true);
      }, this.dependencies.memoryPollMs ?? 1000);
      this.dependencies.configureRpc?.(id, rpc);
      await activated;
      if (active.finished || record.state !== "starting") throw unavailable();
      clearTimeout(active.startupTimer);
      this.setStatus(id, record, "enabled");
    } catch (error) {
      if (runtime && record.runtime === runtime && record.state === "starting") {
        this.finish(record, runtime, true); this.setStatus(id, record, "disabled-fault");
      } else if (!runtime) {
        ports?.port1.close();
        ports?.port2.close();
        child?.kill();
        if (record.state === "starting") this.setStatus(id, record, "disabled-fault");
      }
      throw error instanceof PluginError ? error : new PluginError("ERR_INTERNAL", "Failed to start plugin process");
    }
  }
  private finish(record: RecordState, runtime: Runtime, kill: boolean): void {
    if (runtime.finished) return;
    runtime.finished = true;
    clearTimeout(runtime.startupTimer); clearInterval(runtime.memoryTimer);
    runtime.child.removeListener("spawn", runtime.spawn); runtime.child.removeListener("exit", runtime.exit);
    runtime.rpc.close(unavailable());
    for (const port of runtime.ports) port.close();
    if (record.runtime === runtime) record.runtime = undefined;
    if (kill) runtime.child.kill();
  }
  private crash(id: string, record: RecordState, runtime: Runtime, kill = false): void {
    if (runtime.finished || record.runtime !== runtime) return;
    if (record.state === "stopping") { this.finish(record, runtime, false); return; }
    runtime.crashed = true;
    runtime.rejectStartup(unavailable());
    this.finish(record, runtime, kill);
    const now = Date.now();
    record.crashes = record.crashes.filter(time => now - time <= 60_000);
    record.crashes.push(now);
    if (record.crashes.length >= 3) { this.setStatus(id, record, "disabled-fault"); return; }
    const delay = [1000, 5000, 30_000][Math.min(record.restartAttempt++, 2)];
    this.setStatus(id, record, "restarting");
    record.restartTimer = setTimeout(() => { record.restartTimer = undefined; void this.start(id).catch(() => {}); }, delay);
  }
}

/** Call in Electron's ready main process; kept lazy so unit tests need no Electron runtime.
 * https://www.electronjs.org/docs/latest/api/utility-process
 * https://www.electronjs.org/docs/latest/api/message-channel-main
 */
export function createElectronPluginHost(dependencies: Omit<HostDependencies, "fork" | "createChannel" | "getAppMetrics">): PluginHostManager {
  const { utilityProcess, MessageChannelMain, app } = require("electron") as typeof import("electron");
  return new PluginHostManager({ ...dependencies,
    fork: (entry, args, options) => utilityProcess.fork(entry, args, options) as unknown as HostChild,
    createChannel: () => new MessageChannelMain() as unknown as { port1: HostPort; port2: HostPort },
    getAppMetrics: () => app.getAppMetrics(),
  });
}
