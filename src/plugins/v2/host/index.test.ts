import { EventEmitter } from "node:events";
import { describe, it, expect, vi, afterEach } from "vitest";
import { PluginHostManager, cleanPluginEnvironment } from "./index";

class Port extends EventEmitter {
  peer!: Port;
  postMessage(data: unknown) { this.peer.emit("message", { data }); }
  start() {}
  close() {}
}
class Child extends EventEmitter {
  pid = 100;
  kill = vi.fn(() => true);
  frames: any[] = [];
  respond = true;
  postMessage(_message: unknown, ports: Port[]) {
    const port = ports[0];
    port.on("message", ({ data }) => {
      this.frames.push(data);
      if (data.type === "req" && this.respond && (data.method === "activate" || data.method === "deactivate")) {
        port.postMessage({ type: "res", id: data.id, ok: true, value: null });
      }
    });
    port.start();
  }
}
function setup(failChannel = false, forceKill = vi.fn()) {
  const children: Child[] = [];
  const options: any[] = [];
  let metrics: any[] = [];
  const manager = new PluginHostManager({
    resolvePlugin: () => ({ entry: "/plugin/index.cjs", dataDir: "/data/plugin" }),
    prepareDataDir: vi.fn(),
    fork: (_entry, _args, opts) => {
      options.push(opts);
      const child = new Child();
      children.push(child);
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
    createChannel: () => {
      if (failChannel) throw new Error("channel failed");
      const port1 = new Port(), port2 = new Port();
      port1.peer = port2; port2.peer = port1;
      return { port1, port2 };
    },
    getAppMetrics: () => metrics,
    environment: { SystemRoot: "C:\\Windows", SECRET: "secret", HTTP_PROXY: "proxy", FIREFLY_KEY: "key" },
    memoryPollMs: 100,
    forceKill,
  });
  return { manager, children, options, forceKill, setMetrics: (m: any[]) => { metrics = m; } };
}
afterEach(() => { vi.useRealTimers(); });
describe("plugin host", () => {
  it("kills the child if setting up its message channel fails", async () => {
    const { manager, children } = setup(true);
    await expect(manager.start("p")).rejects.toMatchObject({ code: "ERR_INTERNAL" });
    expect(children[0].kill).toHaveBeenCalledTimes(1);
    expect(manager.status("p")).toBe("disabled-fault");
  });
  it("only forwards system environment and runs in plugin data directory", async () => {
    const { manager, options } = setup();
    await manager.start("dev.test.plugin");
    expect(manager.status("dev.test.plugin")).toBe("enabled");
    expect(options[0].cwd).toBe("/data/plugin");
    // The manager uses the real platform; the explicit "win32" case below covers Windows scrubbing.
    expect(options[0].env).toEqual(process.platform === "win32"
      ? { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32;C:\\Windows" }
      : { PATH: "/usr/bin:/bin" });
    await manager.stop("dev.test.plugin", "disabled");
  });
  it("does not inherit host paths, Node injection switches, proxy or credentials", () => {
    expect(cleanPluginEnvironment({ SystemRoot: "C:\\Windows", PATH: "C:\\secret;C:\\Windows\\System32", TEMP: "C:\\temp", TMP: "C:\\tmp", NODE_OPTIONS: "--require evil", FIREFLY_KEY: "secret", HTTPS_PROXY: "user:pass", MY_VALUE: "private" }, "win32")).toEqual({ SystemRoot: "C:\\Windows", TEMP: "C:\\temp", TMP: "C:\\tmp", PATH: "C:\\Windows\\System32;C:\\Windows" });
  });
  it("marks interrupted tool execution unknown and stops restarting after three crashes within 60s", async () => {
    vi.useFakeTimers();
    const { manager, children } = setup();
    await manager.start("p");
    const tool = manager.call("p", "tool.execute", {}).then(value => value);
    children[0].emit("exit", 1);
    expect(await tool).toEqual({ status: "unknown", reason: "Plugin process exited during tool execution" });
    expect(manager.status("p")).toBe("restarting");
    await vi.advanceTimersByTimeAsync(999); expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(children).toHaveLength(2);
    children[1].emit("exit", 1);
    await vi.advanceTimersByTimeAsync(4999); expect(children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); expect(children).toHaveLength(3);
    children[2].emit("exit", 1);
    expect(manager.status("p")).toBe("disabled-fault");
    await vi.advanceTimersByTimeAsync(120_000); expect(children).toHaveLength(3);
  });
  it("uses 30 second backoff when previous crashes have aged out of the 60 second window", async () => {
    vi.useFakeTimers();
    const { manager, children } = setup(); await manager.start("p");
    children[0].emit("exit", 1); await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(60_001); children[1].emit("exit", 1);
    await vi.advanceTimersByTimeAsync(5000); children[2].emit("exit", 1);
    await vi.advanceTimersByTimeAsync(29_999); expect(children).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1); expect(children).toHaveLength(4);
    await manager.stop("p", "disabled");
  });
  it("kills only the matching pid above the memory limit and treats the kill as a crash", async () => {
    vi.useFakeTimers(); const { manager, children, setMetrics } = setup(); await manager.start("p");
    setMetrics([{ pid: 999, memory: { workingSetSize: 999999 } }, { pid: 100, memory: { workingSetSize: 512 * 1024 } }]);
    await vi.advanceTimersByTimeAsync(100); expect(children[0].kill).not.toHaveBeenCalled();
    setMetrics([{ pid: 100, memory: { workingSetSize: 512 * 1024 + 1 } }]);
    await vi.advanceTimersByTimeAsync(100); expect(children[0].kill).toHaveBeenCalledTimes(1);
    expect(manager.status("p")).toBe("restarting");
    await manager.stop("p", "disabled"); await vi.advanceTimersByTimeAsync(2000); expect(children).toHaveLength(1);
  });
  it("kills a child that exceeds the memory limit while it ignores deactivate during stop", async () => {
    vi.useFakeTimers(); const { manager, children, setMetrics } = setup(); await manager.start("p");
    children[0].respond = false;
    const stopping = manager.stop("p", "disabled");
    setMetrics([{ pid: 100, memory: { workingSetSize: 512 * 1024 + 1 } }]);
    await vi.advanceTimersByTimeAsync(100);
    expect(children[0].kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000); await stopping;
    expect(manager.status("p")).toBe("disabled");
    expect(children).toHaveLength(1);
  });
  it("force-kills a child that is still alive 750 ms after the termination request, and only then", async () => {
    vi.useFakeTimers(); const { manager, children, forceKill, setMetrics } = setup(); await manager.start("p");
    setMetrics([{ pid: 100, memory: { workingSetSize: 512 * 1024 + 1 } }]);
    await vi.advanceTimersByTimeAsync(100); expect(children[0].kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(749); expect(forceKill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(forceKill.mock.calls).toEqual([[100]]);
    await manager.stop("p", "disabled");
  });
  it("does not force-kill a child that exits after the termination request", async () => {
    vi.useFakeTimers(); const { manager, children, forceKill, setMetrics } = setup(); await manager.start("p");
    children[0].kill.mockImplementation(() => { queueMicrotask(() => children[0].emit("exit", 0)); return true; });
    setMetrics([{ pid: 100, memory: { workingSetSize: 512 * 1024 + 1 } }]);
    await vi.advanceTimersByTimeAsync(100);
    setMetrics([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(children[0].kill).toHaveBeenCalledTimes(1);
    expect(forceKill).not.toHaveBeenCalled();
    await manager.stop("p", "disabled");
  });
  it("fails activation at 10 seconds and kills the child without restarting", async () => {
    vi.useFakeTimers(); const { manager, children } = setup(); const started = manager.start("p");
    children[0].respond = false;
    const failure = expect(started).rejects.toMatchObject({ code: "ERR_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(9999); expect(children[0].kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await failure;
    expect(children[0].kill).toHaveBeenCalledTimes(1); expect(manager.status("p")).toBe("disabled-fault");
    await vi.advanceTimersByTimeAsync(30_000); expect(children).toHaveLength(1);
  });
  it("allows deactivate five seconds, then kills once and never restarts on its exit", async () => {
    vi.useFakeTimers(); const { manager, children } = setup(); await manager.start("p"); children[0].respond = false;
    const stopped = manager.stop("p", "disabled");
    await vi.advanceTimersByTimeAsync(4999); expect(children[0].kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await stopped;
    expect(children[0].frames.find(frame => frame.method === "deactivate").params).toBe("disabled");
    expect(children[0].kill).toHaveBeenCalledTimes(1); children[0].emit("exit", 0);
    expect(manager.status("p")).toBe("disabled");
    await vi.advanceTimersByTimeAsync(30_000); expect(children).toHaveLength(1);
  });
});
