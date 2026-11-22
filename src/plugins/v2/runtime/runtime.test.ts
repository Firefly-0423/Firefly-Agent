import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import { buildSync } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOST_TO_PLUGIN_METHODS as H,
  PLUGIN_TO_HOST_METHODS as P,
  PluginError,
  type Frame,
} from "../../../shared/plugin-protocol";
import { createRpcEndpoint, type RpcTransport } from "../../../shared/plugin-rpc";
import type { PluginContext } from "../../../../plugin-sdk/src/index";
import {
  attachPluginRuntime,
  connectParentPortRuntime,
  defaultPluginLoader,
  type ParentPortLike,
  type TransferredPortLike,
} from "./index";

function createMemoryRpcPair(): { hostTransport: RpcTransport; pluginTransport: RpcTransport } {
  const hostListeners = new Set<(frame: unknown) => void>();
  const pluginListeners = new Set<(frame: unknown) => void>();

  return {
    hostTransport: {
      post(frame: Frame) {
        queueMicrotask(() => {
          for (const listener of pluginListeners) listener(frame);
        });
      },
      onFrame(cb) {
        hostListeners.add(cb);
        return () => {
          hostListeners.delete(cb);
        };
      },
    },
    pluginTransport: {
      post(frame: Frame) {
        queueMicrotask(() => {
          for (const listener of hostListeners) listener(frame);
        });
      },
      onFrame(cb) {
        pluginListeners.add(cb);
        return () => {
          pluginListeners.delete(cb);
        };
      },
    },
  };
}

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("plugin child-process runtime", () => {
  it("runs full definePlugin + activate lifecycle over real createRpcEndpoint and proxies every ctx capability", async () => {
    const { hostTransport, pluginTransport } = createMemoryRpcPair();
    const hostRpc = createRpcEndpoint(hostTransport);
    const recordedCalls: Array<{ method: string; params: unknown }> = [];

    let observedContext!: PluginContext;
    const eventsSeen: unknown[] = [];
    const workspaceSeen: unknown[] = [];
    const triggersSeen: unknown[] = [];
    const channelStopped = vi.fn();

    hostRpc.handle(P.toolsRegister, (params) => {
      recordedCalls.push({ method: P.toolsRegister, params });
      return null;
    });
    hostRpc.handle(P.contextRegister, (params) => {
      recordedCalls.push({ method: P.contextRegister, params });
      return null;
    });
    hostRpc.handle(P.channelsRegister, (params) => {
      recordedCalls.push({ method: P.channelsRegister, params });
      return null;
    });
    hostRpc.handle(P.channelsReportState, (params) => {
      recordedCalls.push({ method: P.channelsReportState, params });
      return null;
    });
    hostRpc.handle(P.channelsDeliver, (params) => {
      recordedCalls.push({ method: P.channelsDeliver, params });
      return { accepted: true, sessionId: "ch-sess-1" };
    });
    hostRpc.handle(P.modelGenerate, (params) => {
      recordedCalls.push({ method: P.modelGenerate, params });
      if ((params as { stream?: boolean })?.stream) {
        return (async function* () {
          yield { delta: "Hel" };
          yield { delta: "lo" };
        })();
      }
      return { text: "generated", usage: { inputTokens: 2, outputTokens: 3 } };
    });
    hostRpc.handle(P.modelRun, (params) => {
      recordedCalls.push({ method: P.modelRun, params });
      return (async function* () {
        yield { type: "run.started", runId: "r-1", sessionId: "s-1", mode: "work", at: 1 };
        yield { type: "text.delta", delta: "ok" };
        yield { type: "run.ended", runId: "r-1", sessionId: "s-1", outcome: "completed", at: 2 };
        yield { type: "run.result", result: { runId: "r-1", sessionId: "s-1", reply: "done" } };
      })();
    });
    hostRpc.handle(P.eventsSubscribe, (params, { signal }) => {
      recordedCalls.push({ method: P.eventsSubscribe, params });
      return (async function* () {
        yield { type: "run.ended", runId: "r-1", sessionId: "s-1", outcome: "completed", at: 5 };
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      })();
    });
    hostRpc.handle(P.sessionsList, (params) => {
      recordedCalls.push({ method: P.sessionsList, params });
      return { items: [{ id: "s-1", title: "Session 1", mode: "work", updatedAt: 10 }] };
    });
    hostRpc.handle(P.sessionsMessages, (params) => {
      recordedCalls.push({ method: P.sessionsMessages, params });
      return { items: [{ id: "m-1", role: "user", content: "hi", createdAt: 11 }] };
    });
    hostRpc.handle(P.workspaceInfo, (params) => {
      recordedCalls.push({ method: P.workspaceInfo, params });
      return { sessionId: "s-1", mode: "code", root: "/ws", name: "ws" };
    });
    hostRpc.handle(P.workspaceWatch, (params, { signal }) => {
      recordedCalls.push({ method: P.workspaceWatch, params });
      return (async function* () {
        yield { sessionId: "s-1", mode: "code", root: "/ws2", name: "ws2" };
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      })();
    });
    hostRpc.handle(P.schedulesPropose, (params) => {
      recordedCalls.push({ method: P.schedulesPropose, params });
      return { taskId: "t-1", status: "pending_approval" };
    });
    hostRpc.handle(P.schedulesUpdate, (params) => {
      recordedCalls.push({ method: P.schedulesUpdate, params });
      return { status: "pending_approval" };
    });
    hostRpc.handle(P.schedulesRemove, (params) => {
      recordedCalls.push({ method: P.schedulesRemove, params });
      return true;
    });
    hostRpc.handle(P.schedulesList, (params) => {
      recordedCalls.push({ method: P.schedulesList, params });
      return [];
    });
    hostRpc.handle(P.schedulesOnTrigger, (params, { signal }) => {
      recordedCalls.push({ method: P.schedulesOnTrigger, params });
      return (async function* () {
        yield { taskId: "t-1", payload: { n: 1 } };
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      })();
    });
    hostRpc.handle(P.secretsSet, (params) => {
      recordedCalls.push({ method: P.secretsSet, params });
      return null;
    });
    hostRpc.handle(P.secretsGet, (params) => {
      recordedCalls.push({ method: P.secretsGet, params });
      return "secret-value";
    });
    hostRpc.handle(P.secretsDelete, (params) => {
      recordedCalls.push({ method: P.secretsDelete, params });
      return true;
    });
    hostRpc.handle(P.secretsKeys, (params) => {
      recordedCalls.push({ method: P.secretsKeys, params });
      return ["apiKey"];
    });
    hostRpc.handle(P.uiOpenWindow, (params) => {
      recordedCalls.push({ method: P.uiOpenWindow, params });
      return null;
    });
    hostRpc.handle(P.uiCloseWindow, (params) => {
      recordedCalls.push({ method: P.uiCloseWindow, params });
      return null;
    });
    hostRpc.handle(P.uiOnMessage, (_params, { signal }) => {
      return (async function* () {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      })();
    });
    hostRpc.handle(P.uiPost, (params) => {
      recordedCalls.push({ method: P.uiPost, params });
      return null;
    });

    const runtime = attachPluginRuntime(pluginTransport, {
      loader: {
        async load() {
          return {
            activate(ctx) {
              observedContext = ctx as unknown as PluginContext;
              ctx.tools.register({
                name: "echo",
                description: "Echo input",
                parameters: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
                async execute(args, call) {
                  return {
                    status: "succeeded",
                    output: { msg: args.msg, callId: call.callId, caller: call.caller, mode: call.mode },
                  };
                },
              });
              ctx.context.register({
                id: "ctx_1",
                modes: ["work"],
                sources: ["user"],
                async provide(req) {
                  return { heading: "Ctx", content: `${req.sessionId}:${req.mode}` };
                },
              });
              ctx.channels.register({
                id: "ch_1",
                async start(chHost) {
                  chHost.reportState({ state: "connected" });
                  await chHost.deliver({
                    externalMessageId: "m1",
                    chat: { type: "private", id: "u1" },
                    sender: { id: "u1", name: "Alice" },
                    text: "hello",
                    timestamp: 1000,
                  });
                },
                async stop() {
                  channelStopped();
                },
                async send() {
                  return { externalMessageId: "sent-1" };
                },
              });
              ctx.events.on("run.ended", (e) => eventsSeen.push(e));
              ctx.workspace.onChange((info) => workspaceSeen.push(info));
              ctx.schedules.onTrigger(async (e) => {
                triggersSeen.push(e.payload);
              });
              ctx.ui.onMessage(async (e) => ({ ok: true, method: e.method }));
            },
          };
        },
      },
    });

    try {
      await hostRpc.call(H.activate, {
        id: "dev.firefly.sample",
        version: "1.2.0",
        dataDir: "/data/dev.firefly.sample",
        main: "/fake/index.mjs",
        permissions: ["secrets", "model.generate"],
      });

      expect(observedContext.id).toBe("dev.firefly.sample");
      expect(observedContext.version).toBe("1.2.0");
      expect(observedContext.dataDir).toBe("/data/dev.firefly.sample");
      expect(observedContext.signal.aborted).toBe(false);
      expect(observedContext.has("secrets")).toBe(true);
      expect(observedContext.has("schedules")).toBe(false);

      // Host -> Plugin tool.execute
      const toolRes = await hostRpc.call(H.toolExecute, {
        name: "echo",
        args: { msg: "ping" },
        callId: "call-42",
        sessionId: "sess-9",
        mode: "code",
        caller: { partnerId: "p1", partnerName: "Partner" },
      });
      expect(toolRes).toEqual({
        status: "succeeded",
        output: { msg: "ping", callId: "call-42", caller: { partnerId: "p1", partnerName: "Partner" }, mode: "code" },
      });

      // Host -> Plugin context.provide
      const ctxRes = await hostRpc.call(H.contextProvide, {
        id: "ctx_1",
        sessionId: "sess-9",
        mode: "work",
        source: "user",
      });
      expect(ctxRes).toEqual({ heading: "Ctx", content: "sess-9:work" });

      // Host -> Plugin channel lifecycle
      await hostRpc.call(H.channelStart, { id: "ch_1" });
      expect(
        await hostRpc.call(H.channelSend, {
          id: "ch_1",
          message: { chat: { type: "private", id: "u1" }, text: "hi" },
        }),
      ).toEqual({
        externalMessageId: "sent-1",
      });
      await hostRpc.call(H.channelStop, { id: "ch_1" });
      expect(channelStopped).toHaveBeenCalledTimes(1);

      // Host -> Plugin ui.message
      expect(
        await hostRpc.call(H.uiMessage, { from: { kind: "settings", id: "settings" }, method: "save", params: { a: 1 } }),
      ).toEqual({ ok: true, method: "save" });

      // Plugin -> Host model, sessions, workspace, schedules, secrets, ui
      expect(await observedContext.model.generate({ prompt: "hello" })).toEqual({
        text: "generated",
        usage: { inputTokens: 2, outputTokens: 3 },
      });
      const chunks: string[] = [];
      for await (const chunk of observedContext.model.generateStream({ prompt: "hello" })) {
        chunks.push(chunk.delta);
      }
      expect(chunks).toEqual(["Hel", "lo"]);

      const runHandle = observedContext.model.run({ objective: "go", mode: "work" });
      const runEvents: unknown[] = [];
      for await (const ev of runHandle.events) runEvents.push(ev);
      expect(runEvents).toHaveLength(3);
      expect(await runHandle.result).toEqual({ runId: "r-1", sessionId: "s-1", reply: "done" });

      expect(await observedContext.sessions.list({ limit: 5 })).toMatchObject({ items: [{ id: "s-1" }] });
      expect(await observedContext.sessions.messages("s-1")).toMatchObject({ items: [{ id: "m-1" }] });
      expect(await observedContext.workspace.current("s-1")).toMatchObject({ root: "/ws" });
      expect(await observedContext.schedules.propose({
        title: "t",
        schedule: { kind: "interval", minutes: 10 },
        action: { type: "callback" },
      })).toEqual({ taskId: "t-1", status: "pending_approval" });
      expect(await observedContext.schedules.update("t-1", { title: "t2" })).toEqual({ status: "pending_approval" });
      expect(await observedContext.schedules.list()).toEqual([]);
      expect(await observedContext.schedules.remove("t-1")).toBe(true);

      await observedContext.secrets.set("apiKey", "v");
      expect(await observedContext.secrets.get("apiKey")).toBe("secret-value");
      expect(await observedContext.secrets.keys()).toEqual(["apiKey"]);
      expect(await observedContext.secrets.delete("apiKey")).toBe(true);

      const win = await observedContext.ui.openWindow("radar", { zoom: 2 });
      await win.post({ cmd: "refresh" });
      await win.close();
      await observedContext.ui.post({ kind: "settings", id: "settings" }, { saved: true });

      // Wait a tick for streamed events/workspace/triggers
      await new Promise((r) => setTimeout(r, 20));
      expect(eventsSeen).toHaveLength(1);
      expect(workspaceSeen).toEqual([{ sessionId: "s-1", mode: "code", root: "/ws2", name: "ws2" }]);
      expect(triggersSeen).toEqual([{ n: 1 }]);
      expect(recordedCalls.some((c) => c.method === P.toolsRegister)).toBe(true);
      expect(recordedCalls.some((c) => c.method === P.secretsGet)).toBe(true);

      await hostRpc.call(H.deactivate, "disabled");
      expect(observedContext.signal.aborted).toBe(true);
    } finally {
      runtime.dispose();
      hostRpc.dispose();
    }
  });

  it("aborts ctx.signal and forwards exact deactivate reason to plugin.deactivate", async () => {
    const { hostTransport, pluginTransport } = createMemoryRpcPair();
    const hostRpc = createRpcEndpoint(hostTransport);
    const reasons: string[] = [];
    let signalAtDeactivate = false;
    let capturedSignal!: AbortSignal;

    const runtime = attachPluginRuntime(pluginTransport, {
      loader: {
        async load() {
          return {
            activate(ctx) {
              capturedSignal = ctx.signal;
            },
            deactivate(reason) {
              signalAtDeactivate = capturedSignal.aborted;
              reasons.push(reason);
            },
          };
        },
      },
    });

    try {
      await hostRpc.call(H.activate, {
        id: "dev.firefly.lifecycle",
        dataDir: "/tmp/data",
        main: "/tmp/index.mjs",
      });
      expect(capturedSignal.aborted).toBe(false);

      await hostRpc.call(H.deactivate, "upgrade");
      expect(capturedSignal.aborted).toBe(true);
      expect(signalAtDeactivate).toBe(true);
      expect(reasons).toEqual(["upgrade"]);
    } finally {
      runtime.dispose();
      hostRpc.dispose();
    }
  });

  it("returns ERR_UNDECLARED when calling undeclared capabilities or registering undeclared tools", async () => {
    const { hostTransport, pluginTransport } = createMemoryRpcPair();
    const hostRpc = createRpcEndpoint(hostTransport);

    // Host rejects undeclared tools.register and does not expose secrets
    hostRpc.handle(P.toolsRegister, (params) => {
      const name = (params as { name?: string })?.name;
      if (name !== "allowed_tool") {
        throw new PluginError("ERR_UNDECLARED", `Tool "${name}" is not declared`);
      }
      return null;
    });

    let capturedCtx!: PluginContext;
    const runtime = attachPluginRuntime(pluginTransport, {
      loader: {
        async load(mainPath) {
          if (mainPath.endsWith("bad-tool.mjs")) {
            return {
              activate(ctx) {
                ctx.tools.register({
                  name: "undeclared_tool",
                  description: "bad",
                  parameters: { type: "object", properties: {} },
                  execute: async () => ({ status: "succeeded", output: "no" }),
                });
              },
            };
          }
          return {
            activate(ctx) {
              capturedCtx = ctx as unknown as PluginContext;
            },
          };
        },
      },
    });

    try {
      // Case 1: undeclared tool registration inside activate -> rejects with ERR_UNDECLARED
      await expect(
        hostRpc.call(H.activate, { id: "dev.firefly.bad", dataDir: "/tmp/d", main: "/tmp/bad-tool.mjs" }),
      ).rejects.toMatchObject({ code: "ERR_UNDECLARED" });

      // Case 2: activate clean plugin, then call undeclared capability -> ERR_UNDECLARED
      await hostRpc.call(H.activate, { id: "dev.firefly.good", dataDir: "/tmp/d", main: "/tmp/good.mjs", permissions: [] });
      await expect(capturedCtx.secrets.get("token")).rejects.toMatchObject({ code: "ERR_UNDECLARED" });
      await expect(capturedCtx.model.generate({ prompt: "hi" })).rejects.toMatchObject({ code: "ERR_UNDECLARED" });
      await expect(hostRpc.call(H.toolExecute, { name: "missing", args: {}, callId: "1" })).rejects.toMatchObject({
        code: "ERR_UNDECLARED",
      });
    } finally {
      runtime.dispose();
      hostRpc.dispose();
    }
  });

  it("connects via parentPort MessagePort transfer and loads a real .mjs plugin module from disk", async () => {
    const dir = makeTempDir("ff-runtime-port-");
    const pluginFile = join(dir, "plugin.mjs");
    writeFileSync(
      pluginFile,
      `export default {
        activate(ctx) {
          ctx.tools.register({
            name: "hello",
            description: "Greet",
            parameters: { type: "object", properties: { who: { type: "string" } } },
            async execute(args) {
              const prefix = await ctx.secrets.get("prefix");
              return { status: "succeeded", output: prefix + " " + args.who };
            },
          });
        },
        deactivate(reason) {
          globalThis.__lastDeactivateReason = reason;
        },
      };\n`,
      "utf8",
    );

    const { port1, port2 } = new MessageChannel();
    const fakeParentPort = new EventEmitter();
    const hostRpc = createRpcEndpoint({
      post: (frame) => port1.postMessage(frame),
      onFrame: (cb) => {
        const listener = (data: unknown) => cb(data);
        port1.on("message", listener);
        return () => port1.off("message", listener);
      },
    });
    port1.start();

    hostRpc.handle(P.toolsRegister, () => null);
    hostRpc.handle(P.secretsGet, () => "Hello");

    const wrappedPort2: TransferredPortLike = {
      postMessage: (frame) => port2.postMessage(frame),
      on: (_ev, cb) => port2.on("message", (data) => cb({ data })),
      off: (_ev, cb) => port2.off("message", cb as never),
      start: () => port2.start(),
      close: () => port2.close(),
    };

    const attachedPromise = connectParentPortRuntime(fakeParentPort as unknown as ParentPortLike);
    fakeParentPort.emit("message", { ports: [wrappedPort2] });
    const attached = await attachedPromise;

    try {
      await hostRpc.call(H.activate, {
        id: "dev.firefly.disk",
        version: "1.0.0",
        dataDir: dir,
        main: pluginFile,
        permissions: ["secrets"],
      });

      const res = await hostRpc.call(H.toolExecute, {
        name: "hello",
        args: { who: "Firefly" },
        callId: "c1",
      });
      expect(res).toEqual({ status: "succeeded", output: "Hello Firefly" });

      await hostRpc.call(H.deactivate, "quit");
      expect((globalThis as { __lastDeactivateReason?: string }).__lastDeactivateReason).toBe("quit");
    } finally {
      delete (globalThis as { __lastDeactivateReason?: string }).__lastDeactivateReason;
      attached.dispose();
      hostRpc.dispose();
      port1.close();
      port2.close();
    }
  });

  it("evaluates a top-level throwing plugin module only once and propagates its original error", async () => {
    const dir = makeTempDir("ff-runtime-throw-");
    const pluginFile = join(dir, "broken.mjs");
    writeFileSync(
      pluginFile,
      `globalThis.__ffLoaderEvalCount = (globalThis.__ffLoaderEvalCount ?? 0) + 1;
await Promise.resolve();
throw new Error("top-level plugin failure");\n`,
      "utf8",
    );
    const cjsPluginFile = join(dir, "broken.cjs");
    writeFileSync(
      cjsPluginFile,
      `globalThis.__ffLoaderCjsEvalCount = (globalThis.__ffLoaderCjsEvalCount ?? 0) + 1;
throw new Error("top-level cjs failure");\n`,
      "utf8",
    );

    try {
      await expect(defaultPluginLoader.load(pluginFile)).rejects.toThrow("top-level plugin failure");
      expect((globalThis as { __ffLoaderEvalCount?: number }).__ffLoaderEvalCount).toBe(1);
    } finally {
      delete (globalThis as { __ffLoaderEvalCount?: number }).__ffLoaderEvalCount;
    }

    // Also verify the real CJS compiled path (where new Function import() executes directly in Node):
    const cjsRunner = join(dir, "loader-cjs-check.cjs");
    buildSync({
      stdin: {
        contents: `
const assert = require("node:assert/strict");
const { defaultPluginLoader } = require("./src/plugins/v2/runtime/runtime.ts");
(async () => {
  let caughtMjs;
  try {
    await defaultPluginLoader.load(${JSON.stringify(pluginFile)});
  } catch (err) {
    caughtMjs = err;
  }
  assert.ok(caughtMjs instanceof Error);
  assert.equal(caughtMjs.message, "top-level plugin failure");
  assert.equal(globalThis.__ffLoaderEvalCount, 1);

  let caughtCjs;
  try {
    await defaultPluginLoader.load(${JSON.stringify(cjsPluginFile)});
  } catch (err) {
    caughtCjs = err;
  }
  assert.ok(caughtCjs instanceof Error);
  assert.equal(caughtCjs.message, "top-level cjs failure");
  assert.equal(globalThis.__ffLoaderCjsEvalCount, 1);
  console.log("CJS_LOADER_SINGLE_EVAL_OK");
})();
`,
        resolveDir: process.cwd(),
      },
      outfile: cjsRunner,
      platform: "node",
      bundle: true,
      format: "cjs",
    });
    const res = spawnSync(process.execPath, [cjsRunner], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    expect({ status: res.status, stderr: res.stderr }).toMatchObject({ status: 0 });
    expect(res.stdout).toContain("CJS_LOADER_SINGLE_EVAL_OK");

    // Simulate dynamicImport rejecting with a real module error on a valid plugin file:
    // defaultPluginLoader must rethrow immediately instead of falling back to import().
    const validPluginFile = join(dir, "valid.mjs");
    writeFileSync(validPluginFile, "export default { activate() {} };\n", "utf8");
    const functionSpy = vi
      .spyOn(globalThis, "Function")
      .mockImplementationOnce(function () {
        return () => Promise.reject(new Error("simulated module throw"));
      } as never);
    try {
      await expect(defaultPluginLoader.load(validPluginFile)).rejects.toThrow("simulated module throw");
    } finally {
      functionSpy.mockRestore();
    }
  });

  it("sends tools.unregister and context.unregister and removes local handlers when disposed", async () => {
    const { hostTransport, pluginTransport } = createMemoryRpcPair();
    const hostRpc = createRpcEndpoint(hostTransport);
    const unregisteredTools: unknown[] = [];
    const unregisteredContexts: unknown[] = [];

    hostRpc.handle(P.toolsRegister, () => null);
    hostRpc.handle(P.contextRegister, () => null);
    hostRpc.handle(P.toolsUnregister, (params) => {
      unregisteredTools.push(params);
      return null;
    });
    hostRpc.handle(P.contextUnregister, (params) => {
      unregisteredContexts.push(params);
      return null;
    });

    let toolHandle!: { dispose(): void };
    let contextHandle!: { dispose(): void };

    const runtime = attachPluginRuntime(pluginTransport, {
      loader: {
        async load() {
          return {
            activate(ctx) {
              toolHandle = ctx.tools.register({
                name: "temp_tool",
                description: "Temp",
                parameters: { type: "object", properties: {} },
                async execute() {
                  return { status: "succeeded", output: "ok" };
                },
              });
              contextHandle = ctx.context.register({
                id: "temp_ctx",
                modes: ["work"],
                sources: ["user"],
                async provide() {
                  return { heading: "H", content: "C" };
                },
              });
            },
          };
        },
      },
    });

    try {
      await hostRpc.call(H.activate, {
        id: "dev.firefly.dispose",
        version: "1.0.0",
        dataDir: "/tmp/dispose",
        main: "/tmp/dispose.mjs",
        permissions: [],
      });

      expect(await hostRpc.call(H.toolExecute, { name: "temp_tool", args: {}, callId: "1" })).toEqual({
        status: "succeeded",
        output: "ok",
      });
      expect(await hostRpc.call(H.contextProvide, { id: "temp_ctx", sessionId: "s1", mode: "work", source: "user" })).toEqual({
        heading: "H",
        content: "C",
      });

      toolHandle.dispose();
      toolHandle.dispose();
      contextHandle.dispose();
      contextHandle.dispose();

      await new Promise((r) => setTimeout(r, 20));
      expect(unregisteredTools).toEqual([{ name: "temp_tool" }]);
      expect(unregisteredContexts).toEqual([{ id: "temp_ctx" }]);

      await expect(hostRpc.call(H.toolExecute, { name: "temp_tool", args: {}, callId: "2" })).rejects.toMatchObject({
        code: "ERR_UNDECLARED",
      });
      await expect(
        hostRpc.call(H.contextProvide, { id: "temp_ctx", sessionId: "s1", mode: "work", source: "user" }),
      ).rejects.toMatchObject({ code: "ERR_UNDECLARED" });

      // Disposing after deactivation is a safe no-op with no unhandled rejection
      await hostRpc.call(H.deactivate, "disabled");
      toolHandle.dispose();
      contextHandle.dispose();
    } finally {
      runtime.dispose();
      hostRpc.dispose();
    }
  });

  it("logs stream subscription refusals and exposes rejection observably via disposable.closed", async () => {
    const { hostTransport, pluginTransport } = createMemoryRpcPair();
    const hostRpc = createRpcEndpoint(hostTransport);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    hostRpc.handle(P.eventsSubscribe, () => {
      throw new PluginError("ERR_UNDECLARED", "events permission not declared");
    });
    hostRpc.handle(P.workspaceWatch, () => {
      throw new PluginError("ERR_PERMISSION", "workspace.read permission revoked");
    });
    hostRpc.handle(P.schedulesOnTrigger, (_params, { signal }) => {
      return (async function* () {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      })();
    });

    let eventSub!: { dispose(): void; closed?: Promise<void> };
    let ignoredWorkspaceSub!: { dispose(): void; closed?: Promise<void> };
    let scheduleSub!: { dispose(): void; closed?: Promise<void> };

    const runtime = attachPluginRuntime(pluginTransport, {
      loader: {
        async load() {
          return {
            activate(ctx) {
              eventSub = ctx.events.on("run.ended", () => {});
              // Deliberately do not await `closed` on workspace.onChange to verify no unhandledRejection crash.
              ignoredWorkspaceSub = ctx.workspace.onChange(() => {});
              scheduleSub = ctx.schedules.onTrigger(async () => {});
            },
          };
        },
      },
    });

    try {
      await hostRpc.call(H.activate, {
        id: "dev.firefly.streams",
        version: "1.0.0",
        dataDir: "/tmp/streams",
        main: "/tmp/streams.mjs",
        permissions: ["schedules"],
      });

      await expect(eventSub.closed).rejects.toMatchObject({
        code: "ERR_UNDECLARED",
        message: "events permission not declared",
      });

      // Give the ignored subscription a tick to settle and verify it logged without crashing.
      await new Promise((r) => setTimeout(r, 20));
      expect(ignoredWorkspaceSub.closed).toBeInstanceOf(Promise);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Stream subscription "events.subscribe" failed:'),
        expect.objectContaining({ code: "ERR_UNDECLARED" }),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Stream subscription "workspace.watch" failed:'),
        expect.objectContaining({ code: "ERR_PERMISSION" }),
      );

      // Disposing a healthy subscription resolves `closed` cleanly without warning.
      const warnsBeforeDispose = warnSpy.mock.calls.length;
      scheduleSub.dispose();
      await expect(scheduleSub.closed).resolves.toBeUndefined();
      expect(warnSpy.mock.calls.length).toBe(warnsBeforeDispose);
    } finally {
      warnSpy.mockRestore();
      runtime.dispose();
      hostRpc.dispose();
    }
  });

  it("fails activation when the host refuses a registration while activate() is still awaiting its own setup", async () => {
    const { hostTransport, pluginTransport } = createMemoryRpcPair();
    const hostRpc = createRpcEndpoint(hostTransport);
    hostRpc.handle(P.toolsRegister, () => {
      throw new PluginError("ERR_UNDECLARED", "Tool is not declared");
    });
    const runtime = attachPluginRuntime(pluginTransport, {
      loader: {
        async load() {
          return {
            async activate(ctx) {
              ctx.tools.register({
                name: "late_refused",
                description: "refused by the host before setup finishes",
                parameters: { type: "object", properties: {} },
                execute: async () => ({ status: "succeeded", output: "never" }),
              });
              // The refusal lands during this wait, before activate() returns.
              await new Promise((resolve) => setTimeout(resolve, 20));
            },
          };
        },
      },
    });
    try {
      await expect(
        hostRpc.call(H.activate, { id: "dev.firefly.late", dataDir: "/tmp/d", main: "/tmp/late.mjs" }),
      ).rejects.toMatchObject({ code: "ERR_UNDECLARED" });
    } finally {
      runtime.dispose();
      hostRpc.dispose();
    }
  });

  it("lets model.generate and generateStream run past the 10 s RPC default", async () => {
    const { hostTransport, pluginTransport } = createMemoryRpcPair();
    const hostRpc = createRpcEndpoint(hostTransport);
    const slow = () => new Promise((resolve) => setTimeout(resolve, 10_500));
    hostRpc.handle(P.modelGenerate, async (params) => {
      if ((params as { stream?: boolean }).stream) {
        return (async function* () {
          await slow();
          yield { delta: "late" };
        })();
      }
      await slow();
      return { text: "late answer" };
    });
    let ctx!: PluginContext;
    const runtime = attachPluginRuntime(pluginTransport, {
      loader: { async load() { return { activate(c) { ctx = c as unknown as PluginContext; } }; } },
    });
    try {
      await hostRpc.call(H.activate, { id: "dev.firefly.slow", dataDir: "/tmp/d", main: "/tmp/slow.mjs", permissions: ["model.generate"] });
      vi.useFakeTimers();
      const generated = ctx.model.generate({ prompt: "hi" });
      const streamed = (async () => {
        const chunks: unknown[] = [];
        for await (const chunk of ctx.model.generateStream({ prompt: "hi" })) chunks.push(chunk);
        return chunks;
      })();
      await vi.advanceTimersByTimeAsync(10_500);
      await expect(generated).resolves.toEqual({ text: "late answer" });
      await expect(streamed).resolves.toEqual([{ delta: "late" }]);
    } finally {
      vi.useRealTimers();
      runtime.dispose();
      hostRpc.dispose();
    }
  });
});

const require = createRequire(import.meta.url);
let electron: string | undefined;
try {
  electron = require("electron") as string;
} catch {
  /* Electron binary is optional on test-only machines. */
}

it.skipIf(!electron || !existsSync(electron))(
  "runs child-process runtime inside a real Electron utilityProcess via createElectronPluginHost",
  () => {
    const directory = makeTempDir("ff-runtime-electron-");
    const dataDir = join(directory, "data");
    mkdirSync(dataDir);
    const pluginEntry = join(directory, "my-plugin.mjs");
    const runtimeEntry = join(directory, "runtime-entry.cjs");
    const runner = join(directory, "runner.cjs");

    writeFileSync(
      pluginEntry,
      `export default {
        activate(ctx) {
          ctx.tools.register({
            name: "ping",
            description: "Ping",
            parameters: { type: "object", properties: {} },
            async execute(_args, call) {
              if (call.signal.aborted) return { status: "not_executed", reason: "aborted" };
              return { status: "succeeded", output: "pong:" + ctx.id };
            },
          });
        },
      };\n`,
      "utf8",
    );

    const runtimeShim = `
const { connectParentPortRuntime } = require("./src/plugins/v2/runtime/index.ts");
connectParentPortRuntime(process.parentPort);
`;
    buildSync({
      stdin: { contents: runtimeShim, resolveDir: process.cwd() },
      outfile: runtimeEntry,
      platform: "node",
      bundle: true,
      format: "cjs",
    });

    const runnerSource = `
const assert = require("node:assert/strict");
const { app } = require("electron");
const { createElectronPluginHost } = require("./src/plugins/v2/host/index.ts");
const { HOST_TO_PLUGIN_METHODS, PLUGIN_TO_HOST_METHODS } = require("./src/shared/plugin-protocol.ts");

app.setPath("userData", ${JSON.stringify(dataDir)});
app.whenReady().then(async () => {
  const registeredTools = [];
  const host = createElectronPluginHost({
    resolvePlugin: () => ({
      entry: ${JSON.stringify(runtimeEntry)},
      main: ${JSON.stringify(pluginEntry)},
      version: "1.0.0",
      permissions: [],
      dataDir: ${JSON.stringify(dataDir)},
    }),
    configureRpc: (_id, rpc) => {
      rpc.handle(PLUGIN_TO_HOST_METHODS.toolsRegister, (params) => {
        registeredTools.push(params);
        return null;
      });
    },
  });
  try {
    await host.start("dev.firefly.echo");
    assert.equal(host.status("dev.firefly.echo"), "enabled");
    assert.equal(registeredTools.length, 1);
    assert.equal(registeredTools[0].name, "ping");
    const result = await host.call("dev.firefly.echo", HOST_TO_PLUGIN_METHODS.toolExecute, {
      name: "ping",
      args: {},
      callId: "c-1",
    });
    assert.deepEqual(result, { status: "succeeded", output: "pong:dev.firefly.echo" });
    console.log("RUNTIME_UTILITY_PROCESS_OK");
  } finally {
    await host.stop("dev.firefly.echo", "disabled");
  }
}).then(() => app.exit(0), (err) => { console.error(err); app.exit(1); });
`;
    buildSync({
      stdin: { contents: runnerSource, resolveDir: process.cwd() },
      outfile: runner,
      platform: "node",
      bundle: true,
      external: ["electron"],
      format: "cjs",
    });

    const env = { ...process.env };
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    const result = spawnSync(electron!, [runner], { env, timeout: 20_000, encoding: "utf8", windowsHide: true });
    expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toMatchObject({
      status: 0,
      error: undefined,
    });
    expect(result.stdout).toContain("RUNTIME_UTILITY_PROCESS_OK");
  },
  25_000,
);
