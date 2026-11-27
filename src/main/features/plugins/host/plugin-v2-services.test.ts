import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_TO_HOST_METHODS, PluginError } from "../../../../shared/plugin-protocol";
import { createRpcEndpoint } from "../../../../shared/plugin-rpc";
import type { ModelSettings } from "../../../model/config/model-settings";

const mocks = vi.hoisted(() => {
  type Subscriber = {
    next: (packet: any) => void;
    error: (err: unknown) => void;
    complete: () => void;
  };
  let nextRunFactory: ((options: any) => {
    lastResult?: { reply?: string };
    run: (sub: Subscriber) => () => void;
  }) | undefined;
  const agentInstances: Array<{ options: any; unsubscribed: boolean }> = [];
  const cancelPendingApprovalsForRun = vi.fn();

  class MockFireflyAgent {
    lastResult?: { reply?: string };
    constructor(public readonly config: unknown) {}
    runWithEvents(options: unknown) {
      const built = nextRunFactory?.(options) ?? {
        run: (sub: Subscriber) => {
          sub.complete();
          return () => {};
        },
      };
      this.lastResult = built.lastResult;
      const tracker = { options, unsubscribed: false };
      agentInstances.push(tracker);
      return {
        subscribe(sub: Subscriber) {
          const cleanup = built.run(sub);
          return {
            unsubscribe() {
              tracker.unsubscribed = true;
              cleanup();
            },
          };
        },
      };
    }
  }

  return {
    MockFireflyAgent,
    agentInstances,
    cancelPendingApprovalsForRun,
    setRunFactory(fn: typeof nextRunFactory) {
      nextRunFactory = fn;
    },
  };
});

vi.mock("../../../agent/runtime/firefly-agent", () => ({
  FireflyAgent: mocks.MockFireflyAgent,
}));

vi.mock("../../../platform/permission/permission", () => ({
  cancelPendingApprovalsForRun: mocks.cancelPendingApprovalsForRun,
}));

vi.mock("../../../base/storage/token-usage-store", () => ({
  recordRequest: vi.fn(),
  recordUsage: vi.fn(),
  recordPluginCall: vi.fn(),
}));

import { createPluginV2HostController, mapPluginModelRunOutcome } from "./plugin-v2-services";

function createTestSettings(chatRequestTimeoutSec = 60): ModelSettings {
  return {
    provider: "OpenAI",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-test",
    apiKey: "sk-test-secret",
    contextWindowTokens: 128_000,
    chatRequestTimeoutSec,
    stickerEnabled: false,
    stickerSize: "standard",
    stickerSimilarityThreshold: 0.55,
    rerankerMode: "none",
    modelProfiles: [
      {
        id: "default",
        provider: "OpenAI",
        baseUrl: "https://api.example.com/v1",
        model: "gpt-test",
        apiKey: "sk-test-secret",
      },
    ],
    defaultModelProfileId: "default",
  } as ModelSettings;
}

function createControllerFixture(opts: { chatRequestTimeoutSec?: number; buildRunOptions?: ReturnType<typeof vi.fn> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "firefly-plugin-v2-svc-"));
  const buildRunOptions = opts.buildRunOptions ?? vi.fn(async () => ({ options: { tools: [] } }));
  const controller = createPluginV2HostController({
    dataRoot: dir,
    stateFile: join(dir, "state.json"),
    scheduleStateFile: join(dir, "schedules.json"),
    schedulerStore: {
      list: () => [],
      get: () => undefined,
      add: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      listHistory: () => [],
    } as never,
    llmClient: { chatNonStream: vi.fn() },
    buildRunOptions: buildRunOptions as never,
    loadModelSettings: () => createTestSettings(opts.chatRequestTimeoutSec),
    loadGeneralSettings: () => ({}),
    listSessions: () => [],
    getSession: () => ({
      id: "s-1",
      mode: "work",
      title: "Work",
      createdAt: 1,
      updatedAt: 1,
      messages: [],
    }),
    getActiveChatTarget: () => ({ sessionId: "s-1", mode: "work" }),
    confirmFirstUse: async () => true,
    createHostManager: () => ({
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      status: vi.fn(() => "stopped" as const),
      call: vi.fn(),
      onStatusChange: () => () => {},
    }) as never,
  });

  controller.installPlugin({
    schemaVersion: 1,
    id: "dev.test.model",
    name: "Model Test",
    version: "1.0.0",
    main: "index.js",
    permissions: ["model.generate", "model.run"],
  });
  controller.stateStore.enable("dev.test.model", {
    grantedPermissions: ["model.generate", "model.run"],
  });

  let hostReceive: (v: unknown) => void = () => {};
  let pluginReceive: (v: unknown) => void = () => {};
  const hostRpc = createRpcEndpoint({
    post: (f) => pluginReceive(f),
    onFrame: (fn) => { hostReceive = fn; return () => {}; },
  });
  const clientRpc = createRpcEndpoint({
    post: (f) => hostReceive(f),
    onFrame: (fn) => { pluginReceive = fn; return () => {}; },
  });
  const unbind = controller.hostServices.configureRpc("dev.test.model", hostRpc);

  return {
    controller,
    clientRpc,
    buildRunOptions,
    cleanup: () => {
      unbind();
      clientRpc.close();
      hostRpc.close();
      controller.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("plugin-v2-services model.run (A2)", () => {
  beforeEach(() => {
    mocks.agentInstances.length = 0;
    mocks.cancelPendingApprovalsForRun.mockReset();
    mocks.setRunFactory(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    ["success", "completed"],
    ["cancelled", "cancelled"],
    ["timeout", "failed"],
    ["max_rounds", "failed"],
    ["runtime_error", "failed"],
    ["other_non_success", "failed"],
    [undefined, "failed"],
  ] as const)("maps RUN_FINISHED status %s to outcome %s", async (status, expectedOutcome) => {
    expect(mapPluginModelRunOutcome(status)).toBe(expectedOutcome);

    const fixture = createControllerFixture();
    try {
      mocks.setRunFactory(() => ({
        lastResult: { reply: "final" },
        run(sub) {
          sub.next({ type: "RUN_STARTED" });
          sub.next({ type: "RUN_FINISHED", result: status === undefined ? {} : { status } });
          sub.complete();
          return () => {};
        },
      }));

      const events: Array<{ type: string; outcome?: string }> = [];
      for await (const chunk of fixture.clientRpc.stream<{ type: string; outcome?: string }>(
        PLUGIN_TO_HOST_METHODS.modelRun,
        { objective: "check status", mode: "work", sessionId: "s-1" },
      )) {
        events.push(chunk);
      }

      const ended = events.find((e) => e.type === "run.ended");
      expect(ended?.outcome).toBe(expectedOutcome);
    } finally {
      fixture.cleanup();
    }
  });

  it("reports each tool's real outcome (succeeded / failed / unknown / not_executed) once per call", async () => {
    const fixture = createControllerFixture();
    try {
      const outcomes = [["c1", "success"], ["c2", "failure"], ["c3", "unknown"], ["c4", "not_executed"]] as const;
      mocks.setRunFactory((options: { onToolFinished?: (event: unknown) => void }) => ({
        lastResult: { reply: "done" },
        run(sub) {
          sub.next({ type: "RUN_STARTED" });
          for (const [id, status] of outcomes) {
            sub.next({ type: "TOOL_CALL_START", toolCallId: id, toolCallName: `tool_${id}` });
            options.onToolFinished?.({ runId: "r", toolCallId: id, toolId: `tool_${id}`, status, risk: "safe" });
            // The AG-UI result event folds unknown/not_executed into "failed"; it must not produce a second report.
            sub.next({ type: "TOOL_CALL_RESULT", toolCallId: id, status: status === "success" ? "success" : "failed" });
          }
          sub.next({ type: "RUN_FINISHED", result: { status: "completed" } });
          sub.complete();
          return () => {};
        },
      }));
      const completed: Array<{ callId: string; tool: string; status: string }> = [];
      for await (const chunk of fixture.clientRpc.stream<{ type: string; callId: string; tool: string; status: string }>(
        PLUGIN_TO_HOST_METHODS.modelRun,
        { objective: "tools", mode: "work", sessionId: "s-1" },
      )) {
        if (chunk.type === "tool.completed") completed.push({ callId: chunk.callId, tool: chunk.tool, status: chunk.status });
      }
      expect(completed).toEqual([
        { callId: "c1", tool: "tool_c1", status: "succeeded" },
        { callId: "c2", tool: "tool_c2", status: "failed" },
        { callId: "c3", tool: "tool_c3", status: "unknown" },
        { callId: "c4", tool: "tool_c4", status: "not_executed" },
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    [undefined, false],
    [false, false],
    [true, true],
  ] as const)("starts a plugin run without the desktop memory run and with allowPartners=%s -> allowDelegation=%s", async (allowPartners, delegation) => {
    const openMemoryRun = vi.fn();
    const buildRunOptions = vi.fn(async () => ({ options: { tools: [{ id: "delegate_agent" }, { id: "read_file" }], openMemoryRun, controlledResponses: vi.fn() } }));
    const fixture = createControllerFixture({ buildRunOptions });
    try {
      mocks.setRunFactory(() => ({ lastResult: { reply: "ok" }, run(sub) { sub.complete(); return () => {}; } }));
      for await (const _chunk of fixture.clientRpc.stream(
        PLUGIN_TO_HOST_METHODS.modelRun,
        { objective: "plan", mode: "work", sessionId: "s-1", ...(allowPartners === undefined ? {} : { allowPartners }) },
      )) { /* drain */ }
      const options = mocks.agentInstances.at(-1)?.options as Record<string, unknown>;
      expect(options).not.toHaveProperty("openMemoryRun");
      expect(options).not.toHaveProperty("controlledResponses");
      expect(options.allowDelegation).toBe(delegation);
      expect(options.approvals).toBe("refuse");
      expect(options.usagePluginId).toBe("dev.test.model");
      expect((options.tools as Array<{ id: string }>).map((tool) => tool.id)).toEqual(delegation ? ["delegate_agent", "read_file"] : ["read_file"]);
      expect(openMemoryRun).not.toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    ["chat", "chat"],
    ["work", "work"],
    ["code", "work"],
  ] as const)("runs a %s request with that conversationMode and executionMode=%s", async (mode, executionMode) => {
    // Production buildRunOptions returns no conversationMode; the plugin host must set it like the desktop does.
    const buildRunOptions = vi.fn(async () => ({ options: { tools: [] } }));
    const fixture = createControllerFixture({ buildRunOptions });
    try {
      mocks.setRunFactory(() => ({ lastResult: { reply: "ok" }, run(sub) { sub.complete(); return () => {}; } }));
      for await (const _chunk of fixture.clientRpc.stream(
        PLUGIN_TO_HOST_METHODS.modelRun,
        { objective: "plan", mode, sessionId: "s-1" },
      )) { /* drain */ }
      const options = mocks.agentInstances.at(-1)?.options as Record<string, unknown>;
      expect({ conversationMode: options.conversationMode, executionMode: options.executionMode })
        .toEqual({ conversationMode: mode, executionMode });
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects immediately without starting agent when signal is already aborted", async () => {
    const buildRunOptions = vi.fn(async () => ({ options: { tools: [] } }));
    const fixture = createControllerFixture({ buildRunOptions });
    try {
      const ac = new AbortController();
      ac.abort();

      const iter = fixture.clientRpc.stream(
        PLUGIN_TO_HOST_METHODS.modelRun,
        { objective: "should not start", mode: "work", sessionId: "s-1" },
        { signal: ac.signal },
      )[Symbol.asyncIterator]();

      await expect(iter.next()).rejects.toMatchObject({ code: "ERR_CANCELLED" });
      expect(buildRunOptions).not.toHaveBeenCalled();
      expect(mocks.agentInstances).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });

  it("does not start agent if signal aborts while buildRunOptions is resolving", async () => {
    let resolveBuild!: (value: { options: { tools: [] } }) => void;
    const buildRunOptions = vi.fn(
      () => new Promise<{ options: { tools: [] } }>((resolve) => { resolveBuild = resolve; }),
    );
    const fixture = createControllerFixture({ buildRunOptions });
    try {
      const ac = new AbortController();
      const iter = fixture.clientRpc.stream(
        PLUGIN_TO_HOST_METHODS.modelRun,
        { objective: "abort during build", mode: "work", sessionId: "s-1" },
        { signal: ac.signal },
      )[Symbol.asyncIterator]();

      const nextPromise = iter.next();
      await vi.waitFor(() => expect(buildRunOptions).toHaveBeenCalledTimes(1));
      ac.abort();
      resolveBuild({ options: { tools: [] } });

      await expect(nextPromise).rejects.toMatchObject({ code: "ERR_CANCELLED" });
      expect(mocks.agentInstances).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });

  it("removes abort listener on both completion and error", async () => {
    const fixture = createControllerFixture();
    const activeListeners = new Map<EventTarget, Set<EventListenerOrEventListenerObject>>();
    const origAdd = AbortSignal.prototype.addEventListener;
    const origRemove = AbortSignal.prototype.removeEventListener;
    vi.spyOn(AbortSignal.prototype, "addEventListener").mockImplementation(function (this: AbortSignal, type, listener, opts) {
      if (type === "abort" && listener) {
        const set = activeListeners.get(this) ?? new Set();
        set.add(listener);
        activeListeners.set(this, set);
      }
      return origAdd.call(this, type, listener, opts);
    });
    vi.spyOn(AbortSignal.prototype, "removeEventListener").mockImplementation(function (this: AbortSignal, type, listener, opts) {
      if (type === "abort" && listener) {
        activeListeners.get(this)?.delete(listener);
      }
      return origRemove.call(this, type, listener, opts);
    });

    try {
      // 1. Completion removes abort listener
      mocks.setRunFactory(() => ({
        lastResult: { reply: "ok" },
        run(sub) {
          sub.next({ type: "RUN_FINISHED", result: { status: "success" } });
          sub.complete();
          return () => {};
        },
      }));

      for await (const _chunk of fixture.clientRpc.stream(
        PLUGIN_TO_HOST_METHODS.modelRun,
        { objective: "complete cleanly", mode: "work", sessionId: "s-1" },
      )) {
        // drain
      }
      for (const set of activeListeners.values()) {
        expect(set.size).toBe(0);
      }

      // 2. Error removes abort listener
      mocks.setRunFactory(() => ({
        run(sub) {
          sub.error(new PluginError("ERR_INTERNAL", "boom"));
          return () => {};
        },
      }));
      const errIter = fixture.clientRpc.stream(
        PLUGIN_TO_HOST_METHODS.modelRun,
        { objective: "fail cleanly", mode: "work", sessionId: "s-1" },
      )[Symbol.asyncIterator]();
      await expect(errIter.next()).rejects.toMatchObject({ code: "ERR_INTERNAL" });

      for (const set of activeListeners.values()) {
        expect(set.size).toBe(0);
      }
    } finally {
      fixture.cleanup();
    }
  });
});

function sseFrame(text: string): Uint8Array {
  return new TextEncoder().encode(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
  );
}

describe("plugin-v2-services model.generate stream (A3)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("throws ERR_CANCELLED on mid-stream abort without duplicating already-pushed deltas", async () => {
    const fixture = createControllerFixture();
    try {
      let emitSecondChunk!: () => void;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(sseFrame("Hello world from stream! "));
          emitSecondChunk = () => controller.enqueue(sseFrame("World"));
        },
      });
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));

      const ac = new AbortController();
      const iter = fixture.clientRpc.stream<{ delta: string }>(
        PLUGIN_TO_HOST_METHODS.modelGenerate,
        { prompt: "hi", stream: true },
        { signal: ac.signal, timeoutMs: 200_000 },
      )[Symbol.asyncIterator]();

      const first = await iter.next();
      expect(first.done).toBe(false);
      const emittedFirst = (first.value as { delta: string }).delta;
      expect(emittedFirst.length).toBeGreaterThan(0);

      const pendingSecond = iter.next();
      ac.abort();
      await expect(pendingSecond).rejects.toMatchObject({ code: "ERR_CANCELLED" });
      expect(typeof emitSecondChunk).toBe("function");
    } finally {
      fixture.cleanup();
    }
  });

  it("turns an in-stream provider error into ERR_UNAVAILABLE without leaking the upstream message", async () => {
    const fixture = createControllerFixture();
    try {
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(sseFrame("partial answer "));
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: { message: "upstream overloaded sk-secret-1234" } })}\n\n`));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
      const received: string[] = [];
      const run = async () => {
        for await (const chunk of fixture.clientRpc.stream<{ delta: string }>(PLUGIN_TO_HOST_METHODS.modelGenerate, { prompt: "hi", stream: true })) {
          received.push(chunk.delta);
        }
      };
      const error = await run().then(() => undefined, (err: unknown) => err as { code?: string; message?: string });
      expect(error).toMatchObject({ code: "ERR_UNAVAILABLE" });
      expect(error?.message).not.toContain("overloaded");
      expect(error?.message).not.toContain("sk-secret");
    } finally {
      fixture.cleanup();
    }
  });

  it("converts fetch network errors to ERR_UNAVAILABLE with retryable: true", async () => {
    const fixture = createControllerFixture();
    try {
      vi.stubGlobal("fetch", vi.fn(async () => {
        throw new TypeError("socket hang up");
      }));

      const iter = fixture.clientRpc.stream<{ delta: string }>(
        PLUGIN_TO_HOST_METHODS.modelGenerate,
        { prompt: "hi", stream: true },
      )[Symbol.asyncIterator]();

      await expect(iter.next()).rejects.toMatchObject({
        code: "ERR_UNAVAILABLE",
        retryable: true,
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("converts non-2xx HTTP responses to ERR_UNAVAILABLE with retryable: true", async () => {
    const fixture = createControllerFixture();
    try {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream error", { status: 503 })));

      const iter = fixture.clientRpc.stream<{ delta: string }>(
        PLUGIN_TO_HOST_METHODS.modelGenerate,
        { prompt: "hi", stream: true },
      )[Symbol.asyncIterator]();

      await expect(iter.next()).rejects.toMatchObject({
        code: "ERR_UNAVAILABLE",
        retryable: true,
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("converts mid-stream read errors to ERR_UNAVAILABLE without duplicating pushed deltas", async () => {
    const fixture = createControllerFixture();
    try {
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(sseFrame("chunk-1-from-stream "));
        },
      });
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));

      const chunks: string[] = [];
      const iter = fixture.clientRpc.stream<{ delta: string }>(
        PLUGIN_TO_HOST_METHODS.modelGenerate,
        { prompt: "hi", stream: true },
      )[Symbol.asyncIterator]();

      const first = await iter.next();
      if (!first.done) chunks.push(first.value.delta);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toContain("chunk-1");

      streamController.error(new Error("connection reset"));
      await expect(iter.next()).rejects.toMatchObject({
        code: "ERR_UNAVAILABLE",
        retryable: true,
      });
      expect(chunks).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it("enforces chatRequestTimeoutSec timeout with ERR_TIMEOUT and does not duplicate deltas", async () => {
    vi.useFakeTimers();
    const fixture = createControllerFixture({ chatRequestTimeoutSec: 45 });
    try {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(sseFrame("chunk-1-from-stream "));
          // Leave stream open to trigger timeout on next read.
        },
      });
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));

      const chunks: string[] = [];
      const iter = fixture.clientRpc.stream<{ delta: string }>(
        PLUGIN_TO_HOST_METHODS.modelGenerate,
        { prompt: "hi", stream: true },
        { timeoutMs: 200_000 },
      )[Symbol.asyncIterator]();

      const first = await iter.next();
      if (!first.done) chunks.push(first.value.delta);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toContain("chunk-1");

      let caughtError: unknown;
      const secondPromise = iter.next().catch((err) => { caughtError = err; });

      await vi.advanceTimersByTimeAsync(44_999);
      expect(caughtError).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      await secondPromise;
      expect(caughtError).toMatchObject({ code: "ERR_TIMEOUT" });
      expect(chunks).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it("clamps chatRequestTimeoutSec to the 120s non-stream ceiling", async () => {
    vi.useFakeTimers();
    const fixture = createControllerFixture({ chatRequestTimeoutSec: 300 });
    try {
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

      const iter = fixture.clientRpc.stream<{ delta: string }>(
        PLUGIN_TO_HOST_METHODS.modelGenerate,
        { prompt: "hi", stream: true },
        { timeoutMs: 200_000 },
      )[Symbol.asyncIterator]();

      let caughtError: unknown;
      const pending = iter.next().catch((err) => { caughtError = err; });

      await vi.advanceTimersByTimeAsync(119_999);
      expect(caughtError).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(caughtError).toMatchObject({ code: "ERR_TIMEOUT" });
    } finally {
      fixture.cleanup();
    }
  });
});
