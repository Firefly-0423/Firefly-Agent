import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { HOST_TO_PLUGIN_METHODS, PLUGIN_TO_HOST_METHODS } from "../../../shared/plugin-protocol";
import { attachPluginRuntime } from "../runtime";
import { PluginHostManager, cleanPluginEnvironment } from "./index";

class Port extends EventEmitter {
  peer!: Port;
  postMessage(data: unknown) {
    queueMicrotask(() => {
      this.peer.emit("message", { data });
    });
  }
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
function setup(failChannel = false, forceKill = vi.fn(), configureRpc?: () => (() => void)) {
  const children: Child[] = [];
  const options: any[] = [];
  let metrics: any[] = [];
  const manager = new PluginHostManager({
    resolvePlugin: () => ({
      entry: "/plugin/runtime-main.js",
      main: "/plugin/dist/index.mjs",
      version: "1.2.3",
      permissions: ["secrets", "model.generate"],
      dataDir: "/data/plugin",
    }),
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
    forceKill, configureRpc,
  });
  return { manager, children, options, forceKill, setMetrics: (m: any[]) => { metrics = m; } };
}
afterEach(() => { vi.useRealTimers(); });
describe("plugin host", () => {
  it("disposes service registrations exactly once on stop and crash before restarting", async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn(); const configure = vi.fn(() => cleanup);
    const { manager, children } = setup(false, vi.fn(), configure);
    await manager.start("p"); await manager.stop("p");
    expect(cleanup).toHaveBeenCalledTimes(1);
    await manager.start("p"); children[1].emit("exit", 1);
    expect(cleanup).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(configure).toHaveBeenCalledTimes(3);
    await manager.stop("p"); expect(cleanup).toHaveBeenCalledTimes(3);
  });
  it("kills the child if setting up its message channel fails", async () => {
    const { manager, children } = setup(true);
    await expect(manager.start("p")).rejects.toMatchObject({ code: "ERR_INTERNAL" });
    expect(children[0].kill).toHaveBeenCalledTimes(1);
    expect(manager.status("p")).toBe("disabled-fault");
  });
  it("only forwards system environment and runs in plugin data directory", async () => {
    const { manager, children, options } = setup();
    await manager.start("dev.test.plugin");
    expect(manager.status("dev.test.plugin")).toBe("enabled");
    expect(options[0].cwd).toBe("/data/plugin");
    // The manager uses the real platform; the explicit "win32" case below covers Windows scrubbing.
    expect(options[0].env).toEqual(process.platform === "win32"
      ? { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32;C:\\Windows" }
      : { PATH: "/usr/bin:/bin" });
    const activateFrame = children[0].frames.find(frame => frame.method === HOST_TO_PLUGIN_METHODS.activate);
    expect(activateFrame?.params).toEqual({
      id: "dev.test.plugin",
      dataDir: "/data/plugin",
      main: "/plugin/dist/index.mjs",
      version: "1.2.3",
      permissions: ["secrets", "model.generate"],
    });
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

  it("activates real attachPluginRuntime over an in-memory port pair, preserves permissions, and executes a tool end-to-end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-host-runtime-int-"));
    const pluginMain = join(dir, "plugin.mjs");
    writeFileSync(
      pluginMain,
      `export default {
        activate(ctx) {
          ctx.tools.register({
            name: "check_ctx",
            description: "Inspect context and echo input",
            parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
            async execute(args, call) {
              return {
                status: "succeeded",
                output: {
                  id: ctx.id,
                  version: ctx.version,
                  dataDir: ctx.dataDir,
                  hasSecrets: ctx.has("secrets"),
                  hasModelGenerate: ctx.has("model.generate"),
                  hasSchedules: ctx.has("schedules"),
                  value: args.value,
                  callId: call.callId,
                },
              };
            },
          });
        },
      };\n`,
      "utf8",
    );

    const registeredTools: unknown[] = [];
    let attachedRuntime: ReturnType<typeof attachPluginRuntime> | undefined;
    const manager = new PluginHostManager({
      resolvePlugin: () => ({
        entry: "dist/main/plugins/v2/runtime/main.js",
        main: pluginMain,
        version: "2.4.0",
        permissions: ["secrets", "model.generate"],
        dataDir: dir,
      }),
      prepareDataDir: vi.fn(),
      fork: () => {
        const child = new EventEmitter() as any;
        child.pid = 200;
        child.kill = vi.fn(() => {
          attachedRuntime?.dispose();
          return true;
        });
        child.postMessage = (_msg: unknown, ports: Port[]) => {
          const port2 = ports[0];
          attachedRuntime = attachPluginRuntime({
            post: (frame) => port2.postMessage(frame),
            onFrame: (cb) => {
              const listener = (event: { data: unknown }) => cb(event.data);
              port2.on("message", listener);
              return () => { port2.removeListener("message", listener); };
            },
          });
          port2.start();
        };
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
      createChannel: () => {
        const port1 = new Port(), port2 = new Port();
        port1.peer = port2;
        port2.peer = port1;
        return { port1, port2 };
      },
      getAppMetrics: () => [],
      configureRpc: (_id, rpc) => {
        rpc.handle(PLUGIN_TO_HOST_METHODS.toolsRegister, (params) => {
          registeredTools.push(params);
          return null;
        });
      },
    });

    try {
      await manager.start("dev.firefly.integration");
      expect(manager.status("dev.firefly.integration")).toBe("enabled");
      expect(registeredTools).toHaveLength(1);

      const result = await manager.call("dev.firefly.integration", HOST_TO_PLUGIN_METHODS.toolExecute, {
        name: "check_ctx",
        args: { value: "hello" },
        callId: "c-int-1",
        sessionId: "s-int-1",
        mode: "work",
        caller: "firefly",
      });
      expect(result).toEqual({
        status: "succeeded",
        output: {
          id: "dev.firefly.integration",
          version: "2.4.0",
          dataDir: dir,
          hasSecrets: true,
          hasModelGenerate: true,
          hasSchedules: false,
          value: "hello",
          callId: "c-int-1",
        },
      });
      await manager.stop("dev.firefly.integration", "disabled");
      expect(manager.status("dev.firefly.integration")).toBe("disabled");
    } finally {
      attachedRuntime?.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
