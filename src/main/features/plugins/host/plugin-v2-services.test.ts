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
