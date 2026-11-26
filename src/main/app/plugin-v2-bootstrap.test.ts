import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import type { IpcScope } from "../base/ipc/ipc-scope";
import { createPluginHostServices } from "../../plugins/v2/services";
import { createRpcEndpoint } from "../../shared/plugin-rpc";
import { PLUGIN_TO_HOST_METHODS } from "../../shared/plugin-protocol";
import { attachPluginV2Listeners } from "../../renderer/react/features/chat/pages/plugin-v2-bridge";
import { t } from "../../renderer/react/i18n";

const mocks = vi.hoisted(() => {
  let capturedConfirmFirstUse: ((req: {
    pluginId: string;
    pluginName: string;
    permission: "sessions.read" | "workspace.read" | "model.run";
    signal: AbortSignal;
  }) => Promise<boolean>) | undefined;
  const showMessageBox = vi.fn(async () => ({ response: 0 }));
  return {
    capturedDeps: undefined as { onScheduleStateChanged?: () => void } | undefined,
    scheduleService: {
      listPendingProposals: vi.fn(() => []),
      getTaskRecord: vi.fn(() => undefined),
      confirmProposal: vi.fn(() => ({})),
      rejectProposal: vi.fn(() => ({})),
    },
    stateStore: { get: vi.fn((id: string) => (id === "dev.test.plugin" ? { manifest: { name: "Test plugin" } } : undefined)) },
    get capturedConfirmFirstUse() {
      return capturedConfirmFirstUse;
    },
    set capturedConfirmFirstUse(fn) {
      capturedConfirmFirstUse = fn;
    },
    showMessageBox,
    controller: {
      startEnabled: vi.fn(async () => {}),
      getBorrowingEntries: vi.fn(() => []),
      stopBorrowing: vi.fn(() => 0),
      publishHostEvent: vi.fn(),
      onContextChanged: vi.fn(),
      stopAll: vi.fn(async () => {}),
      dispose: vi.fn(),
    },
  };
});

vi.mock("electron", () => ({
  app: { getAppPath: () => "/app" },
  dialog: { showMessageBox: mocks.showMessageBox },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock("../base/storage/storage-context", () => ({
  getStorageContext: () => ({
    dataRoot: "/data",
    files: { pluginState: "/data/plugin-state.json" },
    profile: {
      appData: "/profile/appData",
      userData: "/profile/userData",
      sessionData: "/profile/sessionData",
      logs: "/profile/logs",
    },
  }),
}));

vi.mock("../model/config/model-settings", () => ({ loadModelSettings: vi.fn() }));
vi.mock("../platform/settings/settings-facade", () => ({ loadGeneralSettings: vi.fn(() => ({})) }));
vi.mock("../platform/interaction/active-chat-target", () => ({
  activeChatTargetRegistry: {
    getActive: () => null,
    onInvalidated: () => () => {},
    onSessionDeleted: () => () => {},
  },
}));
vi.mock("../tooling/registry/tool-registry", () => ({ toolRegistry: {} }));
vi.mock("../features/sessions/chats-store", () => ({ listSessions: vi.fn(), getSession: vi.fn() }));

vi.mock("../features/plugins/host/plugin-v2-services", () => ({
  createPluginV2HostController: vi.fn((deps: { confirmFirstUse: typeof mocks.capturedConfirmFirstUse; onScheduleStateChanged?: () => void }) => {
    mocks.capturedConfirmFirstUse = deps.confirmFirstUse;
    mocks.capturedDeps = deps;
    return { ...mocks.controller, scheduleService: mocks.scheduleService, stateStore: mocks.stateStore };
  }),
}));

function createMockIpc() {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
  const ipc: IpcScope = {
    handle: vi.fn((channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn(),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
    dispose: vi.fn(),
  };
  return {
    ipc,
    invoke: (channel: string, ...payload: unknown[]) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`Missing IPC handler for ${channel}`);
      return Promise.resolve(fn({}, ...payload));
    },
  };
}

function createFakeChatWebContents() {
  const listeners = new Map<string, Set<(payload: any) => void>>();
  return {
    isDestroyed: () => false,
    send: vi.fn((channel: string, payload: unknown) => {
      for (const cb of listeners.get(channel) ?? []) cb(payload);
    }),
    subscribe: (channel: string, cb: (payload: any) => void) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(cb);
      listeners.set(channel, set);
      return () => set.delete(cb);
    },
  };
}

describe("startPluginV2Bootstrap first-use confirmations", () => {
  beforeEach(() => {
    mocks.capturedConfirmFirstUse = undefined;
    mocks.showMessageBox.mockReset();
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("persists pending confirmations across renderer reload and resumes call after re-attach answer", async () => {
    const { ipc, invoke } = createMockIpc();
    const chatWebContents = createFakeChatWebContents();
    const { startPluginV2Bootstrap } = await import("./plugin-v2-bootstrap");

    await startPluginV2Bootstrap({
      ipc,
      llmClient: { chatNonStream: vi.fn() },
      buildRunOptions: vi.fn() as never,
      schedulerStore: {} as never,
      getChatWebContents: () => chatWebContents as never,
    });

    const bridgeApi = {
      getV2Borrowing: async () => invoke(IPC.PLUGINS_V2_BORROWING_GET) as Promise<{ entries: [] }>,
      getV2Confirms: async () => invoke(IPC.PLUGINS_V2_CONFIRM_GET) as Promise<{ requests: any[] }>,
      onV2BorrowingChanged: () => () => {},
      onV2ConfirmRequest: (cb: (req: any) => void) => chatWebContents.subscribe(IPC.PLUGINS_V2_CONFIRM_REQUEST, cb),
      onV2ConfirmSettled: (cb: (settled: any) => void) => chatWebContents.subscribe(IPC.PLUGINS_V2_CONFIRM_SETTLED, cb),
      resolveV2Confirm: async (id: string, allowed: boolean) =>
        invoke(IPC.PLUGINS_V2_CONFIRM_RESOLVE, { id, allowed }) as Promise<{ ok: boolean }>,
    };

    // Mount first renderer; user has not answered before reload.
    const disposeFirst = attachPluginV2Listeners({
      api: bridgeApi,
      confirm: () => new Promise<boolean>(() => {}),
      onBorrowingChange: vi.fn(),
      translate: t,
    });

    const ac = new AbortController();
    const confirmPromise = mocks.capturedConfirmFirstUse!({
      pluginId: "dev.test.plugin",
      pluginName: "测试插件",
      permission: "sessions.read",
      signal: ac.signal,
    });

    // Simulate renderer detach (page reload) before answering.
    disposeFirst();

    // Pending confirmation remains retrievable via IPC.
    const pendingSnapshot = await invoke(IPC.PLUGINS_V2_CONFIRM_GET) as { requests: Array<{ id: string }> };
    expect(pendingSnapshot.requests).toHaveLength(1);
    const pendingId = pendingSnapshot.requests[0].id;

    // Re-attach renderer after reload and answer the retrieved confirmation.
    const secondConfirm = vi.fn(async () => true);
    const disposeSecond = attachPluginV2Listeners({
      api: bridgeApi,
      confirm: secondConfirm,
      onBorrowingChange: vi.fn(),
      translate: t,
    });

    await expect(confirmPromise).resolves.toBe(true);
    expect(secondConfirm).toHaveBeenCalledTimes(1);
    expect((await invoke(IPC.PLUGINS_V2_CONFIRM_GET) as { requests: unknown[] }).requests).toEqual([]);
    // Answering again returns { ok: false }.
    await expect(invoke(IPC.PLUGINS_V2_CONFIRM_RESOLVE, { id: pendingId, allowed: true })).resolves.toEqual({ ok: false });
    disposeSecond();
  });

  it("times out after 120s, emits cancelled settlement, rejects without persisting confirmations", async () => {
    vi.useFakeTimers();
    const { ipc, invoke } = createMockIpc();
    const chatWebContents = createFakeChatWebContents();
    const { startPluginV2Bootstrap } = await import("./plugin-v2-bootstrap");

    await startPluginV2Bootstrap({
      ipc,
      llmClient: { chatNonStream: vi.fn() },
      buildRunOptions: vi.fn() as never,
      schedulerStore: {} as never,
      getChatWebContents: () => chatWebContents as never,
    });

    const storedConfirmations = new Map<string, number>();
    const services = createPluginHostServices({
      access: () => ({
        name: "Timeout Plugin",
        declared: ["sessions.read"],
        granted: new Set(["sessions.read"]),
        revision: 1,
      }),
      context: () => ({
        sessionId: "s-1",
        mode: "chat",
        workspaceRoot: null,
        workspaceName: null,
        revision: 1,
      }),
      onAccessChange: () => () => {},
      confirmations: {
        get: (pluginId, perm) => storedConfirmations.get(`${pluginId}:${perm}`),
        set: (pluginId, perm, rev) => { storedConfirmations.set(`${pluginId}:${perm}`, rev); },
      },
      confirm: (req) => mocks.capturedConfirmFirstUse!(req),
      currentModel: vi.fn(async () => null),
      generate: vi.fn(),
      generateStream: vi.fn() as never,
      watchWorkspace: () => () => {},
      run: vi.fn(),
      borrowing: () => () => {},
      modelLimitPerMinute: () => 10,
      sessions: vi.fn(async () => []),
      messages: vi.fn(async () => []),
      redact: (text) => text,
      createStreamRedactor: () => ({ push: (text) => text, finish: () => "" }),
      subscribe: () => () => {},
    });
    let hostReceive: (v: unknown) => void = () => {};
    let pluginReceive: (v: unknown) => void = () => {};
    const hostRpc = createRpcEndpoint({ post: (f) => pluginReceive(f), onFrame: (fn) => { hostReceive = fn; return () => {}; } });
    const clientRpc = createRpcEndpoint({ post: (f) => hostReceive(f), onFrame: (fn) => { pluginReceive = fn; return () => {}; } });
    services.configureRpc("dev.test.timeout", hostRpc);

    const callPromise = clientRpc.call(PLUGIN_TO_HOST_METHODS.sessionsList, {}, { timeoutMs: 180_000 });
    let rejectedError: unknown;
    const settled = callPromise.catch((err) => { rejectedError = err; });

    // Boundary check: 119_999ms -> still pending.
    await vi.advanceTimersByTimeAsync(119_999);
    const beforeTimeout = await invoke(IPC.PLUGINS_V2_CONFIRM_GET) as { requests: Array<{ id: string }> };
    expect(beforeTimeout.requests).toHaveLength(1);
    const reqId = beforeTimeout.requests[0].id;
    expect(storedConfirmations.size).toBe(0);

    // Boundary check: 120_000ms -> rejected, settled cancelled, not persisted.
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(rejectedError).toMatchObject({ code: "ERR_REJECTED" });
    expect(storedConfirmations.size).toBe(0);
    expect((await invoke(IPC.PLUGINS_V2_CONFIRM_GET) as { requests: unknown[] }).requests).toEqual([]);
    expect(chatWebContents.send).toHaveBeenCalledWith(IPC.PLUGINS_V2_CONFIRM_SETTLED, {
      id: reqId,
      reason: "cancelled",
    });
    // Answering an expired request returns { ok: false }.
    await expect(invoke(IPC.PLUGINS_V2_CONFIRM_RESOLVE, { id: reqId, allowed: true })).resolves.toEqual({ ok: false });
    services.dispose();
    clientRpc.close();
    hostRpc.close();
  });

  it("returns { ok: true } once and { ok: false } on duplicate resolve", async () => {
    const { ipc, invoke } = createMockIpc();
    const chatWebContents = createFakeChatWebContents();
    const { startPluginV2Bootstrap } = await import("./plugin-v2-bootstrap");

    await startPluginV2Bootstrap({
      ipc,
      llmClient: { chatNonStream: vi.fn() },
      buildRunOptions: vi.fn() as never,
      schedulerStore: {} as never,
      getChatWebContents: () => chatWebContents as never,
    });

    const confirmPromise = mocks.capturedConfirmFirstUse!({
      pluginId: "dev.test.dup",
      pluginName: "Dup",
      permission: "model.run",
      signal: new AbortController().signal,
    });
    const { requests } = await invoke(IPC.PLUGINS_V2_CONFIRM_GET) as { requests: Array<{ id: string }> };
    expect(requests).toHaveLength(1);

    await expect(invoke(IPC.PLUGINS_V2_CONFIRM_RESOLVE, { id: requests[0].id, allowed: true })).resolves.toEqual({ ok: true });
    await expect(invoke(IPC.PLUGINS_V2_CONFIRM_RESOLVE, { id: requests[0].id, allowed: false })).resolves.toEqual({ ok: false });
    await expect(confirmPromise).resolves.toBe(true);
  });

  it("falls back to dialog.showMessageBox when chat webContents is unavailable", async () => {
    const { ipc } = createMockIpc();
    const { startPluginV2Bootstrap } = await import("./plugin-v2-bootstrap");
    mocks.showMessageBox.mockResolvedValueOnce({ response: 1 });

    await startPluginV2Bootstrap({
      ipc,
      llmClient: { chatNonStream: vi.fn() },
      buildRunOptions: vi.fn() as never,
      schedulerStore: {} as never,
      getChatWebContents: () => null,
    });

    const allowed = await mocks.capturedConfirmFirstUse!({
      pluginId: "dev.test.fallback",
      pluginName: "Fallback",
      permission: "workspace.read",
      signal: new AbortController().signal,
    });
    expect(allowed).toBe(true);
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
  });
});

describe("startPluginV2Bootstrap plugin schedule proposals", () => {
  beforeEach(() => {
    mocks.scheduleService.listPendingProposals.mockClear();
    mocks.scheduleService.confirmProposal.mockClear();
  });

  it("registers the proposal channels on the scheduler IPC scope and routes confirm to the schedule service", async () => {
    const { ipc, invoke } = createMockIpc();
    const { startPluginV2Bootstrap } = await import("./plugin-v2-bootstrap");
    await startPluginV2Bootstrap({
      ipc,
      llmClient: { chatNonStream: vi.fn() },
      buildRunOptions: vi.fn() as never,
      schedulerStore: {} as never,
      getChatWebContents: () => null,
    });

    await expect(invoke(IPC.SCHEDULER_PLUGIN_PROPOSALS_LIST)).resolves.toEqual({ ok: true, value: [] });
    await expect(invoke(IPC.SCHEDULER_PLUGIN_PROPOSALS_CONFIRM, "task-1", "rev-1")).resolves.toEqual({ ok: true, value: true });
    expect(mocks.scheduleService.confirmProposal).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleService.confirmProposal).toHaveBeenCalledWith("task-1", "rev-1");
  });

  it("pushes a scheduler event to the chat window when the schedule state changes, and skips a closed window", async () => {
    const { ipc } = createMockIpc();
    const chatWebContents = createFakeChatWebContents();
    let target: ReturnType<typeof createFakeChatWebContents> | null = chatWebContents;
    const { startPluginV2Bootstrap } = await import("./plugin-v2-bootstrap");
    await startPluginV2Bootstrap({
      ipc,
      llmClient: { chatNonStream: vi.fn() },
      buildRunOptions: vi.fn() as never,
      schedulerStore: {} as never,
      getChatWebContents: () => target as never,
    });

    mocks.capturedDeps!.onScheduleStateChanged!();
    expect(chatWebContents.send).toHaveBeenCalledTimes(1);
    expect(chatWebContents.send).toHaveBeenCalledWith(IPC.SCHEDULER_EVENT, { type: "CUSTOM", name: "scheduler.plugin_proposals_changed" });

    target = null;
    expect(() => mocks.capturedDeps!.onScheduleStateChanged!()).not.toThrow();
    expect(chatWebContents.send).toHaveBeenCalledTimes(1);
  });
});
