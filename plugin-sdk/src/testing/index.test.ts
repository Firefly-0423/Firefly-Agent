import { describe, expect, it, vi } from "vitest";
import { definePlugin, PluginError, type PluginContext } from "../index";
import { createTestHost, evaluateToolPermission, type TestHostManifest } from "./index";

const baseManifest: TestHostManifest = {
  id: "dev.firefly.weather",
  name: "Weather",
  version: "1.0.0",
  tools: [
    { name: "get_weather", title: "Get Weather", risk: ["network"], modes: ["work", "code"] },
    { name: "write_report", title: "Write Report", risk: ["fs-write"], modes: ["work"] },
    { name: "run_probe", title: "Run Probe", risk: ["shell"], modes: ["code"] },
  ],
  context: [
    { id: "weather_ctx", title: "Weather Context", modes: ["chat", "work"], sources: ["user", "schedule"] },
  ],
  channels: [
    { id: "chat_bridge", title: "Chat Bridge" },
  ],
  permissions: ["model.generate", "model.run", "events", "sessions.read", "workspace.read", "schedules", "secrets", "ui.windows"],
  ui: {
    settings: { entry: "ui/settings.html", title: "Settings" },
    windows: [{ id: "radar", entry: "ui/radar.html", title: "Radar" }],
  },
};

describe("createTestHost", () => {
  it("keeps an approved task unchanged until its update is approved", async () => {
    let ctx!: PluginContext;
    const host = createTestHost({ manifest: baseManifest });
    await host.activate(definePlugin({ activate(c: PluginContext) { ctx = c; } }));
    const { taskId } = await ctx.schedules.propose({
      title: "Morning", schedule: { kind: "cron", expression: "0 8 * * *" }, action: { type: "callback" },
    });
    host.approveSchedule(taskId);
    await expect(ctx.schedules.update(taskId, { title: "Evening" })).resolves.toEqual({ status: "pending_approval" });
    expect((await ctx.schedules.list()).map((task) => [task.title, task.status])).toEqual([["Morning", "active"]]);
    host.approveSchedule(taskId);
    expect((await ctx.schedules.list()).map((task) => [task.title, task.status])).toEqual([["Evening", "active"]]);
  });

  it("stops a started channel when its registration is disposed", async () => {
    let started: AbortSignal | undefined;
    const stop = vi.fn(async () => {});
    let registration!: { dispose(): void };
    const host = createTestHost({ manifest: baseManifest });
    await host.activate(definePlugin({
      activate(ctx: PluginContext) {
        registration = ctx.channels.register({
          id: "chat_bridge", start: async (_h, signal) => { started = signal; }, stop,
          send: async () => ({ externalMessageId: "x" }),
        });
      },
    }));
    await host.startChannel("chat_bridge");
    registration.dispose();
    await Promise.resolve(); await Promise.resolve();
    expect(started?.aborted).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("aborts schedule triggers and channel sends on deactivate, and the previous start when a channel restarts", async () => {
    const signals: Record<string, AbortSignal[]> = { trigger: [], send: [], start: [] };
    const waitForAbort = (signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    const host = createTestHost({ manifest: baseManifest });
    await host.activate(definePlugin({
      activate(ctx: PluginContext) {
        ctx.schedules.onTrigger(async (e) => { signals.trigger.push(e.signal); await waitForAbort(e.signal); });
        ctx.channels.register({
          id: "chat_bridge",
          start: async (_host, signal) => { signals.start.push(signal); },
          stop: async () => {},
          send: async (_msg, signal) => { signals.send.push(signal); await waitForAbort(signal); return { externalMessageId: "x" }; },
        });
      },
    }));
    await host.startChannel("chat_bridge");
    await host.startChannel("chat_bridge");
    expect(signals.start.map((s) => s.aborted)).toEqual([true, false]);
    const trigger = host.triggerSchedule("task-1");
    const send = host.sendChannel("chat_bridge", { chatId: "c", text: "hi" } as never);
    await Promise.resolve();
    await host.deactivate("disabled");
    await Promise.all([trigger, send]);
    expect([...signals.trigger, ...signals.send, ...signals.start].every((s) => s.aborted)).toBe(true);
  });

  it("aborts the signal a model stand-in receives when the host is deactivated", async () => {
    let received: AbortSignal | undefined;
    let ctx!: PluginContext;
    const host = createTestHost({
      manifest: baseManifest,
      model: {
        generate: (req) => new Promise((resolve) => {
          received = req.signal;
          req.signal?.addEventListener("abort", () => resolve({ text: "stopped" }), { once: true });
        }),
      },
    });
    await host.activate(definePlugin({ activate(c: PluginContext) { ctx = c; } }));
    const pending = ctx.model.generate({ prompt: "hi" });
    await Promise.resolve();
    expect(received?.aborted).toBe(false);
    await host.deactivate("disabled");
    expect(received?.aborted).toBe(true);
    await expect(pending).resolves.toEqual({ text: "stopped" });
  });

  it("aborts a channel started during an activation that then fails", async () => {
    let channelSignal: AbortSignal | undefined;
    const host = createTestHost({ manifest: baseManifest });
    await expect(host.activate(definePlugin({
      async activate(ctx: PluginContext) {
        ctx.channels.register({
          id: "chat_bridge",
          start: async (_host, signal) => { channelSignal = signal; },
          stop: async () => {},
          send: async () => ({ externalMessageId: "x" }),
        });
        await host.startChannel("chat_bridge");
        throw new Error("setup failed");
      },
    }))).rejects.toThrow("setup failed");
    expect(channelSignal?.aborted).toBe(true);
  });

  it("clears listeners from a failed activation so a later activation does not call them", async () => {
    const stale = vi.fn();
    const host = createTestHost({ manifest: baseManifest });
    await expect(host.activate(definePlugin({
      activate(ctx: PluginContext) {
        ctx.events.on("run.ended", stale);
        throw new Error("setup failed");
      },
    }))).rejects.toThrow("setup failed");
    await host.activate(definePlugin({ activate() {} }));
    host.emitEvent({ type: "run.ended", runId: "r", sessionId: "s", outcome: "completed", at: 1 });
    expect(stale).not.toHaveBeenCalled();
  });

  it("does not run a tool whose approval resolves after the plugin was stopped", async () => {
    let approve!: (decision: "allow") => void;
    const execute = vi.fn(async () => ({ status: "succeeded" as const, output: "ran" }));
    const host = createTestHost({
      manifest: baseManifest, mode: "work", level: "per-action",
      approvalDecision: () => new Promise((resolve) => { approve = resolve; }),
    });
    await host.activate(definePlugin({
      activate(ctx: PluginContext) {
        ctx.tools.register({ name: "get_weather", description: "w", parameters: { type: "object", properties: {} }, execute });
      },
    }));
    const pending = host.callTool("get_weather", {});
    await Promise.resolve();
    await host.deactivate("disabled");
    approve("allow");
    await expect(pending).resolves.toMatchObject({ status: "not_executed" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("cancels a running tool call when the host is deactivated", async () => {
    let seen: AbortSignal | undefined;
    const host = createTestHost({ manifest: baseManifest, mode: "work", level: "full" });
    await host.activate(definePlugin({
      activate(ctx: PluginContext) {
        ctx.tools.register({
          name: "get_weather", description: "waits for cancel", parameters: { type: "object", properties: {} },
          execute: (_args, call) => new Promise((resolve) => {
            seen = call.signal;
            call.signal.addEventListener("abort", () => resolve({ status: "not_executed", reason: "cancelled" }), { once: true });
          }),
        });
      },
    }));
    const pending = host.callTool("get_weather", {});
    await Promise.resolve();
    await host.deactivate("disabled");
    expect(seen?.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ status: "not_executed" });
  });

  it("restores model quota after the one-minute window", async () => {
    vi.useFakeTimers();
    try {
      let ctx!: PluginContext;
      const host = createTestHost({ manifest: baseManifest, rateLimitPerMinute: 1 });
      await host.activate(definePlugin({ activate(c: PluginContext) { ctx = c; } }));
      await ctx.model.generate({ prompt: "one" });
      await vi.advanceTimersByTimeAsync(59_999);
      await expect(ctx.model.generate({ prompt: "two" })).rejects.toMatchObject({ code: "ERR_RATE_LIMITED" });
      await vi.advanceTimersByTimeAsync(1);
      await expect(ctx.model.generate({ prompt: "three" })).resolves.toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the previous activation's tools, context providers and channels when the host is activated again", async () => {
    const execute = vi.fn(async () => ({ status: "succeeded" as const, output: "old" }));
    const host = createTestHost({ manifest: baseManifest, mode: "work", level: "full" });
    await host.activate(definePlugin({
      activate(ctx: PluginContext) {
        ctx.tools.register({ name: "get_weather", description: "old", parameters: { type: "object", properties: {} }, execute });
      },
    }));
    await host.deactivate("upgrade");
    await host.activate(definePlugin({ activate() {} }));
    await expect(host.callTool("get_weather", {})).rejects.toMatchObject({ code: "ERR_UNDECLARED" });
    await host.crash();
    await host.activate(definePlugin({ activate() {} }));
    await expect(host.callTool("get_weather", {})).rejects.toMatchObject({ code: "ERR_UNDECLARED" });
    expect(execute).not.toHaveBeenCalled();
  });
  it("supports weather-style plugin lifecycle, call recording, and deactivation", async () => {
    const weatherPlugin = definePlugin({
      activate(ctx: PluginContext) {
        ctx.tools.register<{ city: string }>({
          name: "get_weather",
          description: "Query weather by city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
          async execute(args) {
            if (!args.city.trim()) {
              return { status: "failed", error: "city is required" };
            }
            const summary = await ctx.model.generate({ prompt: `Weather in ${args.city}` });
            return { status: "succeeded", output: summary.text };
          },
        });
      },
    });

    const host = createTestHost({
      manifest: baseManifest,
      mode: "work",
      level: "per-action",
      model: { generate: async (req) => ({ text: `Sunny (${req.prompt})` }) },
    });

    await host.activate(weatherPlugin);
    const failed = await host.callTool("get_weather", { city: "" });
    expect(failed).toEqual({ status: "failed", error: expect.any(String) });
    expect(host.calls.filter((c) => c.method === "model.generate")).toEqual([]);

    const ok = await host.callTool("get_weather", { city: "Shanghai" });
    expect(ok).toEqual({ status: "succeeded", output: "Sunny (Weather in Shanghai)" });
    expect(host.calls.filter((c) => c.method === "model.generate")).toHaveLength(1);

    await host.deactivate("disabled");
    expect(host.contextSignal.aborted).toBe(true);
  });

  it("enforces modes (chat blocks tools; work/code only expose matching tools)", async () => {
    const executeSpy = vi.fn(async () => ({ status: "succeeded" as const, output: "ok" }));
    const plugin = definePlugin({
      activate(ctx) {
        ctx.tools.register({
          name: "write_report",
          description: "Write a report",
          parameters: { type: "object", properties: {} },
          execute: executeSpy,
        });
      },
    });

    const host = createTestHost({ manifest: baseManifest, mode: "chat", level: "full" });
    await host.activate(plugin);

    const chatResult = await host.callTool("write_report", {});
    expect(chatResult.status).toBe("not_executed");
    expect(executeSpy).not.toHaveBeenCalled();

    host.setMode("code");
    const codeResult = await host.callTool("write_report", {});
    expect(codeResult.status).toBe("not_executed");
    expect(executeSpy).not.toHaveBeenCalled();

    host.setMode("work");
    const workResult = await host.callTool("write_report", {});
    expect(workResult).toEqual({ status: "succeeded", output: "ok" });
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("simulates all 3 permission levels and approval rejection without calling execute", async () => {
    expect(evaluateToolPermission("read-only", ["fs-read"])).toBe("allow");
    expect(evaluateToolPermission("read-only", ["network"])).toBe("allow");
    expect(evaluateToolPermission("read-only", ["shell"])).toBe("ask");
    expect(evaluateToolPermission("read-only", ["fs-write"])).toBe("deny");
    expect(evaluateToolPermission("read-only", ["input-control"])).toBe("deny");
    expect(evaluateToolPermission("read-only", ["fs-read", "fs-write"])).toBe("deny");
    expect(evaluateToolPermission("per-action", ["fs-read"])).toBe("ask");
    expect(evaluateToolPermission("full", ["input-control"])).toBe("allow");

    const executeWrite = vi.fn(async () => ({ status: "succeeded" as const, output: "wrote" }));
    const executeProbe = vi.fn(async () => ({ status: "succeeded" as const, output: "probed" }));
    const plugin = definePlugin({
      activate(ctx) {
        ctx.tools.register({
          name: "write_report",
          description: "Write",
          parameters: { type: "object", properties: {} },
          execute: executeWrite,
        });
        ctx.tools.register({
          name: "run_probe",
          description: "Probe",
          parameters: { type: "object", properties: {} },
          execute: executeProbe,
        });
      },
    });

    const host = createTestHost({
      manifest: baseManifest,
      mode: "work",
      level: "read-only",
      approvalDecision: "reject",
    });
    await host.activate(plugin);

    // fs-write under read-only -> denied
    const denied = await host.callTool("write_report", {});
    expect(denied).toMatchObject({ status: "not_executed", reason: expect.stringContaining("ERR_PERMISSION") });
    expect(executeWrite).not.toHaveBeenCalled();

    // shell under read-only -> ask -> rejected
    host.setMode("code");
    const rejected = await host.callTool("run_probe", {});
    expect(rejected).toMatchObject({ status: "not_executed", reason: expect.stringContaining("ERR_REJECTED") });
    expect(executeProbe).not.toHaveBeenCalled();

    // full level -> allowed without ask
    host.setLevel("full");
    expect(await host.callTool("run_probe", {})).toEqual({ status: "succeeded", output: "probed" });
    expect(executeProbe).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid tool arguments via schema before calling execute", async () => {
    const executeSpy = vi.fn(async () => ({ status: "succeeded" as const, output: "ok" }));
    const plugin = definePlugin({
      activate(ctx) {
        ctx.tools.register({
          name: "get_weather",
          description: "Weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
            additionalProperties: false,
          },
          execute: executeSpy,
        });
      },
    });

    const host = createTestHost({ manifest: baseManifest, mode: "work", level: "full" });
    await host.activate(plugin);

    const bad = await host.callTool("get_weather", { city: 123 });
    expect(bad).toMatchObject({ status: "not_executed", reason: expect.stringContaining("ERR_INVALID_ARGUMENT") });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("supports cancellation and crash simulation (resolving in-flight tool call as unknown)", async () => {
    let observedAbort = false;
    let releaseCrashTool!: () => void;
    const plugin = definePlugin({
      activate(ctx) {
        ctx.tools.register({
          name: "get_weather",
          description: "Weather",
          parameters: { type: "object", properties: { mode: { type: "string" } } },
          async execute(args, call) {
            if (args.mode === "cancel") {
              await new Promise<void>((resolve) => {
                call.signal.addEventListener("abort", () => {
                  observedAbort = true;
                  resolve();
                }, { once: true });
              });
              return { status: "not_executed", reason: "cancelled" };
            }
            await new Promise<void>((resolve) => {
              releaseCrashTool = resolve;
            });
            return { status: "succeeded", output: "late" };
          },
        });
      },
    });

    const host = createTestHost({ manifest: baseManifest, mode: "work", level: "full" });
    await host.activate(plugin);

    const cancelPromise = host.callTool("get_weather", { mode: "cancel" }, { callId: "c1" });
    await Promise.resolve();
    expect(host.cancelTool("c1")).toBe(true);
    expect(await cancelPromise).toEqual({ status: "not_executed", reason: "cancelled" });
    expect(observedAbort).toBe(true);

    const inflight = host.callTool("get_weather", { mode: "crash" }, { callId: "c2" });
    await host.crash();
    expect(await inflight).toMatchObject({ status: "unknown" });
    expect(host.status).toBe("crashed");
    expect(host.contextSignal.aborted).toBe(true);
    releaseCrashTool?.();

    const afterCrash = await host.callTool("get_weather", { mode: "cancel" });
    expect(afterCrash.status).toBe("not_executed");
  });

  it("enforces manifest declarations (ERR_UNDECLARED) and revoked permissions (ERR_PERMISSION)", async () => {
    const restrictedManifest: TestHostManifest = {
      id: "dev.firefly.restricted",
      permissions: ["secrets"],
      tools: [],
      context: [],
      channels: [],
    };
    const host = createTestHost({ manifest: restrictedManifest });

    let capturedCtx!: PluginContext;
    await host.activate({
      activate(ctx) {
        capturedCtx = ctx;
      },
    });

    expect(capturedCtx.has("secrets")).toBe(true);
    expect(capturedCtx.has("model.generate")).toBe(false);

    expect(() =>
      capturedCtx.tools.register({
        name: "undeclared_tool",
        description: "x",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ status: "succeeded", output: "x" }),
      }),
    ).toThrowError(PluginError);

    await expect(capturedCtx.model.generate({ prompt: "hi" })).rejects.toMatchObject({ code: "ERR_UNDECLARED" });
    await expect(capturedCtx.sessions.list()).rejects.toMatchObject({ code: "ERR_UNDECLARED" });
    await expect(capturedCtx.workspace.current()).rejects.toMatchObject({ code: "ERR_UNDECLARED" });
    await expect(capturedCtx.schedules.list()).rejects.toMatchObject({ code: "ERR_UNDECLARED" });
    await expect(capturedCtx.ui.openWindow("radar")).rejects.toMatchObject({ code: "ERR_UNDECLARED" });

    // Declared secret works, then fails with ERR_PERMISSION once revoked
    await capturedCtx.secrets.set("apiKey", "secret-val");
    expect(await capturedCtx.secrets.get("apiKey")).toBe("secret-val");
    host.revokePermission("secrets");
    expect(capturedCtx.has("secrets")).toBe(false);
    await expect(capturedCtx.secrets.get("apiKey")).rejects.toMatchObject({ code: "ERR_PERMISSION" });
  });

  it("drives context providers, events, schedules, workspace, ui, and channels", async () => {
    const eventsSeen: string[] = [];
    const scheduleTriggers: unknown[] = [];
    const workspaceRoots: Array<string | null> = [];

    const plugin = definePlugin({
      activate(ctx) {
        ctx.context.register({
          id: "weather_ctx",
          modes: ["work"],
          sources: ["user"],
          async provide(req) {
            return { heading: "Weather", content: `mode=${req.mode}` };
          },
        });
        ctx.events.on("run.ended", (e) => {
          eventsSeen.push(e.outcome);
        });
        ctx.schedules.onTrigger(async (e) => {
          scheduleTriggers.push(e.payload);
        });
        ctx.workspace.onChange((info) => {
          workspaceRoots.push(info?.root ?? null);
        });
        ctx.ui.onMessage(async (e) => ({ echo: e.method, params: e.params }));
        ctx.channels.register({
          id: "chat_bridge",
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
          async stop() {},
          async send(msg) {
            return { externalMessageId: `out:${msg.text}` };
          },
        });
      },
    });

    const host = createTestHost({ manifest: baseManifest, mode: "work" });
    await host.activate(plugin);

    expect(await host.provideContext("weather_ctx")).toEqual({ heading: "Weather", content: "mode=work" });
    expect(await host.provideContext("weather_ctx", { mode: "chat" })).toBeNull();

    host.emitEvent({ type: "run.ended", runId: "r1", sessionId: "s1", outcome: "completed", at: 1 });
    expect(eventsSeen).toEqual(["completed"]);

    await host.triggerSchedule("task-1", { reminder: true });
    expect(scheduleTriggers).toEqual([{ reminder: true }]);

    host.emitWorkspaceChange({ sessionId: "s1", mode: "work", root: "/repo", name: "repo" });
    expect(workspaceRoots).toEqual(["/repo"]);

    expect(await host.sendUiMessage({ from: { kind: "settings", id: "settings" }, method: "ping", params: 42 })).toEqual({
      echo: "ping",
      params: 42,
    });

    await host.startChannel("chat_bridge");
    expect(host.channelStates.get("chat_bridge")).toEqual([{ state: "connected" }]);
    expect(host.deliveredMessages).toHaveLength(1);
    expect(host.deliveredMessages[0]?.message.text).toBe("hello");
    expect(await host.sendChannel("chat_bridge", { chat: { type: "private", id: "u1" }, text: "pong" })).toEqual({
      externalMessageId: "out:pong",
    });
    await host.stopChannel("chat_bridge");
  });

  it("unregisters tools and context providers on dispose() and records unregister calls", async () => {
    let toolDisposable!: { dispose(): void };
    let contextDisposable!: { dispose(): void };

    const host = createTestHost({ manifest: baseManifest, mode: "work", level: "full" });
    await host.activate({
      activate(ctx) {
        toolDisposable = ctx.tools.register({
          name: "get_weather",
          description: "Weather",
          parameters: { type: "object", properties: {} },
          async execute() {
            return { status: "succeeded", output: "sunny" };
          },
        });
        contextDisposable = ctx.context.register({
          id: "weather_ctx",
          modes: ["work"],
          sources: ["user"],
          async provide() {
            return { heading: "Weather", content: "sunny" };
          },
        });
      },
    });

    expect(await host.callTool("get_weather", {})).toEqual({ status: "succeeded", output: "sunny" });
    expect(await host.provideContext("weather_ctx")).toEqual({ heading: "Weather", content: "sunny" });

    toolDisposable.dispose();
    toolDisposable.dispose();
    contextDisposable.dispose();
    contextDisposable.dispose();

    expect(host.calls.filter((c) => c.method === "tools.unregister").map((c) => c.params)).toEqual([
      { name: "get_weather" },
    ]);
    expect(host.calls.filter((c) => c.method === "context.unregister").map((c) => c.params)).toEqual([
      { id: "weather_ctx" },
    ]);

    await expect(host.callTool("get_weather", {})).rejects.toMatchObject({ code: "ERR_UNDECLARED" });
    await expect(host.provideContext("weather_ctx")).rejects.toMatchObject({ code: "ERR_UNDECLARED" });
  });
});
