import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { Observable, type Subscriber } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../../shared/ipc-channels";
import { exactly } from "../../../shared/testing/error-code.test-support";
import type { IpcScope } from "../../base/ipc/ipc-scope";
import type { ModelSettings } from "../../model/config/model-settings";

interface ControllableRun {
  runId: string;
  signal: AbortSignal;
  cancelSpy: ReturnType<typeof vi.fn>;
  finishModel: (reply?: string) => void;
  subscriber: Subscriber<unknown>;
  abortedAtStart: boolean;
}

const wire = vi.hoisted(() => ({
  root: "",
  windows: [] as Array<{ webContents: { send: (...args: unknown[]) => void }; isDestroyed: () => boolean }>,
  runs: new Map<string, ControllableRun>(),
  streams: [] as Subscriber<unknown>[],
}));

vi.mock("electron", () => ({
  app: { getPath: () => wire.root },
  BrowserWindow: { getAllWindows: () => wire.windows },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  dialog: {},
  shell: {},
  screen: {},
}));

vi.mock("../../agent/tools/history-tools", () => ({
  indexConversationTurn: vi.fn(),
}));

// Keep only the model streaming boundary controllable so page/authority/bridge run for real.
vi.mock("../../agent/runtime/firefly-agent", () => ({
  FireflyAgent: class {
    lastResult = { reply: "Synthetic reply", toolResults: [] };

    runWithEvents(options: { runId: string; signal: AbortSignal }) {
      const cancelSpy = vi.fn();
      return new Observable((subscriber) => {
        wire.streams.push(subscriber);
        let settled = false;
        const finishCancelled = () => {
          if (settled) return;
          settled = true;
          cancelSpy();
          subscriber.next({
            type: "RUN_FINISHED",
            runId: options.runId,
            result: { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true },
          });
          subscriber.complete();
        };
        const finishModel = (reply = "Done") => {
          if (settled || options.signal.aborted) return;
          settled = true;
          this.lastResult = { reply, toolResults: [] };
          subscriber.next({
            type: "RUN_FINISHED",
            runId: options.runId,
            result: { status: "success", externalEffectsMayContinue: false },
          });
          subscriber.complete();
        };

        const abortedAtStart = options.signal.aborted;
        wire.runs.set(options.runId, {
          runId: options.runId,
          signal: options.signal,
          cancelSpy,
          finishModel,
          subscriber,
          abortedAtStart,
        });

        subscriber.next({ type: "RUN_STARTED", runId: options.runId });
        if (abortedAtStart) {
          finishCancelled();
          return;
        }
        options.signal.addEventListener("abort", finishCancelled, { once: true });
      });
    }
  },
}));

let teardown: (() => Promise<void>) | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  wire.root = fs.mkdtempSync(path.join(os.tmpdir(), "run-lifecycle-acceptance-"));
  wire.windows = [];
  wire.runs.clear();
  wire.streams = [];
});

afterEach(async () => {
  try {
    await teardown?.();
  } finally {
    teardown = undefined;
    for (const subscriber of wire.streams) {
      try {
        subscriber.complete();
      } catch {
        // Ignore already-closed test streams during teardown.
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    vi.restoreAllMocks();
    fs.rmSync(wire.root, { recursive: true, force: true });
  }
});

async function createRunLifecycleFixture() {
  const { initializeStorageContext } = await import("../../base/storage/storage-context");
  const { resolveRuntimeProfile } = await import("../../base/identity/runtime-profile");
  const isolationRoot = path.join(wire.root, "isolation");
  fs.mkdirSync(isolationRoot, { recursive: true });
  const storage = initializeStorageContext(
    resolveRuntimeProfile({
      argv: ["--firefly-profile=test", `--firefly-isolation-root=${isolationRoot}`],
      env: {},
      isPackaged: false,
      productionAppData: path.join(wire.root, "unused-production-appdata"),
    }),
  );

  const { openMemoryRepository } = await import("../../memory/database/repository");
  const { ConversationTranscriptStore } = await import("../../conversation/transcript/conversation-transcript-store");
  const { AgentRunStore } = await import("../../agent/loop/run-store");
  const { createMainDefaultMemory } = await import("../../agent/memory-runtime/main-default-memory");
  const { activeChatTargetRegistry } = await import("../../platform/interaction/active-chat-target");
  const { setReactChatWindow } = await import("../../platform/windows/window-state");
  const chatsStore = await import("../sessions/chats-store");
  const { registerChatsIpc } = await import("../sessions/chats-ipc");
  const { registerChatUiIpc } = await import("../sessions/chat-ui-ipc");
  const bridge = await import("./agui-bridge");

  const repo = openMemoryRepository({
    databasePath: path.join(wire.root, "memory.sqlite"),
    key: randomBytes(32),
    clock: Date.now,
  });
  const transcriptStore = new ConversationTranscriptStore(storage.dataRoot);
  const runStore = new AgentRunStore(wire.root);

  const modelConfig = {
    provider: "OpenRouter",
    model: "openai/gpt-6-luna",
    baseUrl: "https://synthetic.invalid/v1",
    apiKey: "synthetic-only",
    explicitTransport: "openai" as const,
  };
  const settings = {
    ...modelConfig,
    contextWindowTokens: 128000,
    chatRequestTimeoutSec: 300,
    modelProfiles: [{ id: "luna", ...modelConfig }],
    defaultModelProfileId: "luna",
  } as ModelSettings;

  const emittedEvents: Array<Record<string, unknown>> = [];
  let senderDestroyed = false;
  let windowDestroyed = false;

  const sender = Object.assign(new EventEmitter(), {
    id: 7,
    mainFrame: {} as Record<string, unknown>,
    isDestroyed: () => senderDestroyed,
    send: vi.fn((channel: string, packet: unknown) => {
      if (channel === IPC.AGUI_EVENT && packet && typeof packet === "object") {
        emittedEvents.push(packet as Record<string, unknown>);
      }
    }),
  });

  const chatWindow = {
    webContents: sender,
    isDestroyed: () => windowDestroyed,
  };
  wire.windows = [chatWindow as unknown as { webContents: { send: (...args: unknown[]) => void }; isDestroyed: () => boolean }];
  setReactChatWindow(chatWindow as never);

  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const notifications = new Map<string, (...args: unknown[]) => unknown>();
  const ipc: IpcScope = {
    handle: (channel, fn) => {
      handlers.set(channel, fn as (...args: unknown[]) => unknown);
    },
    on: (channel, fn) => {
      notifications.set(channel, fn as (...args: unknown[]) => unknown);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
    dispose: () => {
      handlers.clear();
      notifications.clear();
    },
  };

  chatsStore.initialize();
  const sessionA = chatsStore.createSession({ mode: "chat", title: "Session A" });
  const sessionB = chatsStore.createSession({ mode: "chat", title: "Session B" });

  let memory = createMainDefaultMemory({
    getChatWindow: () => chatWindow as never,
    getSettingsWindow: () => null,
    targets: activeChatTargetRegistry,
    getSession: chatsStore.getSession,
    getSessionKind: chatsStore.getSessionKind,
    listSessionIds: () => chatsStore.listSessions().map((s) => s.id),
    store: transcriptStore,
    runReader: runStore,
    settings: () => settings,
    openBackend: async () => ({
      transport: {
        sourceCommand: async (cmd: unknown) => repo.sourceCommand(cmd),
        contextCommand: async (cmd: unknown) => repo.contextCommand(cmd),
        policyCommand: async (cmd: unknown) => repo.policyCommand(cmd),
        recallCommand: async (cmd: unknown) => repo.recallCommand(cmd),
        historyCommand: async (cmd: unknown) => repo.historyCommand(cmd),
        shadowCommand: async (cmd: unknown) => repo.shadowCommand(cmd),
      },
      close: async () => {},
      endpointFactory: async () => {
        throw Error("MEMORY_HISTORY_NATIVE_UNAVAILABLE");
      },
    }),
  });

  const settledTerminals: Array<{ runId: string; status: string; durationMs?: number }> = [];
  const pendingTurns = {
    beginTurn: vi.fn(),
    settleTerminal: vi.fn((runId: string, terminal: { status: string; durationMs?: number }) => {
      settledTerminals.push({ runId, ...terminal });
    }),
    disposeEntry: vi.fn(),
    confirmPersistence: vi.fn(),
  };

  const onRunFinished = vi.fn(async () => ({}));
  const buildOptions = vi.fn(async () => ({
    options: {
      settings: { ...modelConfig, contextWindowTokens: 128000 },
      messages: [],
      timeoutMs: 2000,
      toolSystemContent: "Tools",
      soulSystemBaseContent: "Persona",
    },
    latestUserText: "Question for A",
  }));

  registerChatsIpc(ipc, { memory });
  registerChatUiIpc({
    ipc,
    windowManager: null,
    live2dWindowLifecycle: { getDiagnostics: () => ({}) },
    onActiveTargetChanged: () => {
      memory.refresh();
    },
  });
  bridge.registerAgUiIpc(
    buildOptions,
    onRunFinished,
    () => chatWindow as never,
    undefined,
    ipc,
    pendingTurns as never,
    memory,
  );

  const event = (frame = sender.mainFrame) => ({ sender, senderFrame: frame });

  const setActiveSession = async (sessionId: string, rendererTargetId: string, frame = sender.mainFrame) => {
    const handler = handlers.get(IPC.CHATS_SET_ACTIVE_SESSION);
    if (!handler) throw new Error("CHATS_SET_ACTIVE_SESSION handler missing");
    return await handler(event(frame), { sessionId, mode: "chat", rendererTargetId });
  };

  const appendMessage = async (
    sessionId: string,
    message: { id: string; role: "user" | "model"; content: string; at: number; answersUserMessageId?: string },
    frame = sender.mainFrame,
  ) => {
    const handler = handlers.get(IPC.CHATS_APPEND);
    if (!handler) throw new Error("CHATS_APPEND handler missing");
    return await handler(event(frame), { id: sessionId, message });
  };

  const upsertMessage = async (
    sessionId: string,
    message: { id: string; role: "user" | "model"; content: string; at: number; answersUserMessageId?: string },
    frame = sender.mainFrame,
  ) => {
    const handler = handlers.get(IPC.CHATS_UPSERT);
    if (!handler) throw new Error("CHATS_UPSERT handler missing");
    return await handler(event(frame), { id: sessionId, message });
  };

  const deleteSession = async (sessionId: string, frame = sender.mainFrame) => {
    const handler = handlers.get(IPC.CHATS_DELETE);
    if (!handler) throw new Error("CHATS_DELETE handler missing");
    return await handler(event(frame), sessionId);
  };

  const invokeRun = async (
    sessionId: string,
    ids: { userTurnId: string; assistantTurnId: string },
    frame = sender.mainFrame,
  ) => {
    const handler = handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler missing");
    return (await handler(event(frame), {
      sessionId,
      messages: [{ role: "user", content: "Question for A" }],
      userTurnId: ids.userTurnId,
      assistantTurnId: ids.assistantTurnId,
    })) as { success: true; runId: string };
  };

  const startRunInA = async () => {
    const userTurnId = "turn-user-a-1";
    const assistantTurnId = "turn-model-a-1";
    await setActiveSession(sessionA.id, "target-a-1");
    await appendMessage(sessionA.id, { id: userTurnId, role: "user", content: "Question for A", at: 100 });
    await appendMessage(sessionA.id, {
      id: assistantTurnId,
      role: "model",
      content: "",
      answersUserMessageId: userTurnId,
      at: 101,
    });
    const ack = await invokeRun(sessionA.id, { userTurnId, assistantTurnId });
    const run = wire.runs.get(ack.runId);
    if (!run) throw new Error(`Expected active controllable run ${ack.runId}`);
    return { ack, run, userTurnId, assistantTurnId };
  };

  const cancelRun = async (runId?: string) => {
    const handler = handlers.get(IPC.AGUI_CANCEL);
    if (!handler) throw new Error("AGUI_CANCEL handler missing");
    return await handler(event(), runId);
  };

  const refreshMainFrame = () => {
    const staleFrame = sender.mainFrame;
    sender.emit("did-start-navigation", {}, "app://chat", false, true);
    sender.mainFrame = {};
    return staleFrame;
  };

  const destroyChatWindow = () => {
    windowDestroyed = true;
    senderDestroyed = true;
    sender.emit("destroyed");
  };

  const emittedTerminals = (runId?: string) =>
    emittedEvents.filter(
      (packet) =>
        (packet.type === "RUN_FINISHED" || packet.type === "RUN_ERROR") &&
        (runId === undefined || packet.runId === runId),
    );

  const settledFor = (runId?: string) =>
    settledTerminals.filter((entry) => runId === undefined || entry.runId === runId);

  teardown = async () => {
    for (const run of wire.runs.values()) {
      run.finishModel("cleanup");
    }
    try {
      await vi.waitFor(() => {
        expect(bridge.hasActiveConversationRun()).toBe(false);
      });
    } catch {
      // Force-release any stuck guard if a test failed mid-flight.
    }
    ipc.dispose();
    activeChatTargetRegistry.dispose();
    memory.quiesce();
    await memory.close();
    repo.close();
    setReactChatWindow(null);
  };

  return {
    a: sessionA,
    b: sessionB,
    sender,
    memory,
    bridge,
    targets: activeChatTargetRegistry,
    event,
    setActiveSession,
    appendMessage,
    upsertMessage,
    deleteSession,
    invokeRun,
    startRunInA,
    cancelRun,
    refreshMainFrame,
    destroyChatWindow,
    emittedTerminals,
    settledFor,
    onRunFinished,
  };
}

describe("a run outlives the page that started it", () => {
  it("1. continues running A and settles as success when the page switches active target to B", async () => {
    const f = await createRunLifecycleFixture();
    const { ack, run } = await f.startRunInA();

    await f.setActiveSession(f.b.id, "target-b-1");

    expect(run.signal.aborted).toBe(false);
    expect(run.cancelSpy).not.toHaveBeenCalled();
    expect(f.emittedTerminals(ack.runId)).toHaveLength(0);
    expect(f.settledFor(ack.runId)).toHaveLength(0);
    expect(f.bridge.__getSessionActiveRunForTest(f.a.id)).toBe(ack.runId);

    run.finishModel("Answer A after switching to B");

    await vi.waitFor(() => {
      expect(f.bridge.__getSessionActiveRunForTest(f.a.id)).toBeUndefined();
    });

    expect(run.signal.aborted).toBe(false);
    expect(run.cancelSpy).not.toHaveBeenCalled();
    expect(f.emittedTerminals(ack.runId)).toHaveLength(1);
    expect(f.emittedTerminals(ack.runId)[0]).toMatchObject({
      type: "RUN_FINISHED",
      runId: ack.runId,
      result: { status: "success", externalEffectsMayContinue: false },
    });
    expect(f.settledFor(ack.runId)).toHaveLength(1);
    expect(f.settledFor(ack.runId)[0].status).toBe("success");
    expect(f.onRunFinished).toHaveBeenCalledTimes(1);
  });

  it("2. continues running A across a main-frame navigation refresh and re-selecting A", async () => {
    const f = await createRunLifecycleFixture();
    const { ack, run } = await f.startRunInA();

    f.refreshMainFrame();
    expect(f.targets.getActive()).toBeNull();
    await f.setActiveSession(f.a.id, "target-a-reloaded");

    expect(run.signal.aborted).toBe(false);
    expect(run.cancelSpy).not.toHaveBeenCalled();
    expect(f.emittedTerminals(ack.runId)).toHaveLength(0);
    expect(f.settledFor(ack.runId)).toHaveLength(0);
    expect(f.bridge.__getSessionActiveRunForTest(f.a.id)).toBe(ack.runId);

    run.finishModel("Answer A after refresh");

    await vi.waitFor(() => {
      expect(f.bridge.__getSessionActiveRunForTest(f.a.id)).toBeUndefined();
    });

    expect(run.signal.aborted).toBe(false);
    expect(run.cancelSpy).not.toHaveBeenCalled();
    expect(f.emittedTerminals(ack.runId)).toHaveLength(1);
    expect(f.emittedTerminals(ack.runId)[0]).toMatchObject({
      type: "RUN_FINISHED",
      runId: ack.runId,
      result: { status: "success", externalEffectsMayContinue: false },
    });
    expect(f.settledFor(ack.runId)).toHaveLength(1);
    expect(f.settledFor(ack.runId)[0].status).toBe("success");
    expect(f.onRunFinished).toHaveBeenCalledTimes(1);
  });

  it("3. continues running A and settles as success when the chat window WebContents is destroyed", async () => {
    const f = await createRunLifecycleFixture();
    const { ack, run } = await f.startRunInA();

    f.destroyChatWindow();

    expect(run.signal.aborted).toBe(false);
    expect(run.cancelSpy).not.toHaveBeenCalled();
    expect(f.emittedTerminals(ack.runId)).toHaveLength(0);
    expect(f.settledFor(ack.runId)).toHaveLength(0);
    expect(f.bridge.__getSessionActiveRunForTest(f.a.id)).toBe(ack.runId);

    run.finishModel("Answer A after closing window");

    await vi.waitFor(() => {
      expect(f.bridge.__getSessionActiveRunForTest(f.a.id)).toBeUndefined();
    });

    expect(run.signal.aborted).toBe(false);
    expect(run.cancelSpy).not.toHaveBeenCalled();
    expect(f.settledFor(ack.runId)).toHaveLength(1);
    expect(f.settledFor(ack.runId)[0].status).toBe("success");
    expect(f.onRunFinished).toHaveBeenCalledTimes(1);
  });

  it("4. continues running A when the page switches back and forth between A and B multiple times", async () => {
    const f = await createRunLifecycleFixture();
    const { ack, run } = await f.startRunInA();

    await f.setActiveSession(f.b.id, "target-b-1");
    await f.setActiveSession(f.a.id, "target-a-2");
    await f.setActiveSession(f.b.id, "target-b-2");
    await f.setActiveSession(f.a.id, "target-a-3");
    await f.setActiveSession(f.b.id, "target-b-3");

    expect(run.signal.aborted).toBe(false);
    expect(run.cancelSpy).not.toHaveBeenCalled();
    expect(f.emittedTerminals(ack.runId)).toHaveLength(0);
    expect(f.settledFor(ack.runId)).toHaveLength(0);
    expect(f.bridge.__getSessionActiveRunForTest(f.a.id)).toBe(ack.runId);

    run.finishModel("Answer A after multiple switches");

    await vi.waitFor(() => {
      expect(f.bridge.__getSessionActiveRunForTest(f.a.id)).toBeUndefined();
    });

    expect(run.signal.aborted).toBe(false);
    expect(run.cancelSpy).not.toHaveBeenCalled();
    expect(f.emittedTerminals(ack.runId)).toHaveLength(1);
    expect(f.emittedTerminals(ack.runId)[0]).toMatchObject({
      type: "RUN_FINISHED",
      runId: ack.runId,
      result: { status: "success", externalEffectsMayContinue: false },
    });
    expect(f.settledFor(ack.runId)).toHaveLength(1);
    expect(f.settledFor(ack.runId)[0].status).toBe("success");
  });

  it("5. cancels run A immediately with status cancelled when the user invokes AGUI_CANCEL", async () => {
    const f = await createRunLifecycleFixture();
    const { ack, run } = await f.startRunInA();

    expect(run.signal.aborted).toBe(false);
    expect(f.bridge.__getSessionActiveRunForTest(f.a.id)).toBe(ack.runId);

    await f.cancelRun(ack.runId);

    await vi.waitFor(() => {
      expect(f.bridge.__getSessionActiveRunForTest(f.a.id)).toBeUndefined();
    });

    expect(run.signal.aborted).toBe(true);
    expect(run.cancelSpy).toHaveBeenCalledTimes(1);
    expect(f.emittedTerminals(ack.runId)).toHaveLength(1);
    expect(f.emittedTerminals(ack.runId)[0]).toMatchObject({
      type: "RUN_FINISHED",
      runId: ack.runId,
      result: { status: "cancelled" },
    });
    expect(f.settledFor(ack.runId)).toHaveLength(1);
    expect(f.settledFor(ack.runId)[0].status).toBe("cancelled");
    expect(f.onRunFinished).not.toHaveBeenCalled();
  });

  it("6. cancels run A immediately with status cancelled when session A is deleted", async () => {
    const f = await createRunLifecycleFixture();
    const { ack, run } = await f.startRunInA();

    expect(run.signal.aborted).toBe(false);
    expect(f.bridge.__getSessionActiveRunForTest(f.a.id)).toBe(ack.runId);

    await expect(f.deleteSession(f.a.id)).resolves.toBe(true);

    await vi.waitFor(() => {
      expect(f.bridge.__getSessionActiveRunForTest(f.a.id)).toBeUndefined();
    });

    expect(run.signal.aborted).toBe(true);
    expect(run.cancelSpy).toHaveBeenCalledTimes(1);
    expect(f.emittedTerminals(ack.runId)).toHaveLength(1);
    expect(f.emittedTerminals(ack.runId)[0]).toMatchObject({
      type: "RUN_FINISHED",
      runId: ack.runId,
      result: { status: "cancelled" },
    });
    expect(f.settledFor(ack.runId)).toHaveLength(1);
    expect(f.settledFor(ack.runId)[0].status).toBe("cancelled");
    expect(f.onRunFinished).not.toHaveBeenCalled();
  });

  it("7. cancels run A immediately with status cancelled when the memory runtime disposes on shutdown", async () => {
    const f = await createRunLifecycleFixture();
    const { ack, run } = await f.startRunInA();

    expect(run.signal.aborted).toBe(false);
    expect(f.bridge.__getSessionActiveRunForTest(f.a.id)).toBe(ack.runId);

    f.memory.quiesce();
    await f.memory.close();

    await vi.waitFor(() => {
      expect(f.bridge.__getSessionActiveRunForTest(f.a.id)).toBeUndefined();
    });

    expect(run.signal.aborted).toBe(true);
    expect(run.cancelSpy).toHaveBeenCalledTimes(1);
    expect(f.emittedTerminals(ack.runId)).toHaveLength(1);
    expect(f.emittedTerminals(ack.runId)[0]).toMatchObject({
      type: "RUN_FINISHED",
      runId: ack.runId,
      result: { status: "cancelled" },
    });
    expect(f.settledFor(ack.runId)).toHaveLength(1);
    expect(f.settledFor(ack.runId)[0].status).toBe("cancelled");
    expect(f.onRunFinished).not.toHaveBeenCalled();
  });

  it("8. switching to B does not let B borrow A's run authorization to write user content or start a new run for A", async () => {
    const f = await createRunLifecycleFixture();
    const { ack, run } = await f.startRunInA();

    await f.setActiveSession(f.b.id, "target-b-1");

    // B's page cannot reuse A's active run to write user content to A or authorize a new run for A.
    await expect(
      f.appendMessage(f.a.id, { id: "u-a-forged-from-b", role: "user", content: "Forged from B", at: 200 }),
    ).rejects.toThrow(exactly("MEMORY_DESKTOP_SESSION_DENIED"));
    expect(() => f.memory.authorizeRun(f.event() as never, f.a.id)).toThrow(exactly("MEMORY_DESKTOP_SESSION_DENIED"));

    // Existing run A continues undisturbed and settles normally.
    expect(run.signal.aborted).toBe(false);
    expect(run.cancelSpy).not.toHaveBeenCalled();
    expect(f.emittedTerminals(ack.runId)).toHaveLength(0);
    expect(f.settledFor(ack.runId)).toHaveLength(0);
    expect(f.bridge.__getSessionActiveRunForTest(f.a.id)).toBe(ack.runId);

    run.finishModel("Answer A completed safely");

    await vi.waitFor(() => {
      expect(f.bridge.__getSessionActiveRunForTest(f.a.id)).toBeUndefined();
    });

    expect(run.signal.aborted).toBe(false);
    expect(run.cancelSpy).not.toHaveBeenCalled();
    expect(f.emittedTerminals(ack.runId)).toHaveLength(1);
    expect(f.emittedTerminals(ack.runId)[0]).toMatchObject({
      type: "RUN_FINISHED",
      runId: ack.runId,
      result: { status: "success", externalEffectsMayContinue: false },
    });
    expect(f.settledFor(ack.runId)).toHaveLength(1);
    expect(f.settledFor(ack.runId)[0].status).toBe("success");

    // Once A is idle, B's page still cannot start a new run targeting A.
    await expect(
      f.invokeRun(f.a.id, { userTurnId: "turn-user-a-1", assistantTurnId: "turn-model-a-1" }),
    ).rejects.toThrow(exactly("MEMORY_DESKTOP_SESSION_DENIED"));
    expect(f.bridge.__getSessionActiveRunForTest(f.a.id)).toBeUndefined();
  });

  it("9. refreshing does not let the new page revive the old page's authorization for other actions", async () => {
    const f = await createRunLifecycleFixture();
    const { ack, run } = await f.startRunInA();

    const staleFrame = f.refreshMainFrame();
    expect(f.targets.getActive()).toBeNull();

    // Unregistered new page and the stale pre-refresh frame both lack authorization for A.
    await expect(
      f.appendMessage(f.a.id, { id: "u-a-after-refresh", role: "user", content: "Forged after refresh", at: 201 }),
    ).rejects.toThrow(exactly("MEMORY_DESKTOP_SESSION_DENIED"));
    await expect(
      f.upsertMessage(f.a.id, { id: "m-a-after-refresh", role: "model", content: "Mutated after refresh", at: 202 }),
    ).rejects.toThrow(exactly("MEMORY_DESKTOP_SESSION_DENIED"));
    expect(() => f.memory.authorizeRun(f.event() as never, f.a.id)).toThrow(exactly("MEMORY_DESKTOP_SESSION_DENIED"));
    await expect(
      f.appendMessage(
        f.a.id,
        { id: "u-a-stale-frame", role: "user", content: "Stale frame write", at: 203 },
        staleFrame,
      ),
    ).rejects.toThrow(exactly("MEMORY_DESKTOP_SESSION_DENIED"));
    expect(() => f.memory.authorizeRun(f.event(staleFrame) as never, f.a.id)).toThrow(
      exactly("MEMORY_DESKTOP_SESSION_DENIED"),
    );

    // Existing run A continues undisturbed and settles normally.
    expect(run.signal.aborted).toBe(false);
    expect(run.cancelSpy).not.toHaveBeenCalled();
    expect(f.emittedTerminals(ack.runId)).toHaveLength(0);
    expect(f.settledFor(ack.runId)).toHaveLength(0);
    expect(f.bridge.__getSessionActiveRunForTest(f.a.id)).toBe(ack.runId);

    run.finishModel("Answer A completed across refresh");

    await vi.waitFor(() => {
      expect(f.bridge.__getSessionActiveRunForTest(f.a.id)).toBeUndefined();
    });

    expect(run.signal.aborted).toBe(false);
    expect(run.cancelSpy).not.toHaveBeenCalled();
    expect(f.emittedTerminals(ack.runId)).toHaveLength(1);
    expect(f.emittedTerminals(ack.runId)[0]).toMatchObject({
      type: "RUN_FINISHED",
      runId: ack.runId,
      result: { status: "success", externalEffectsMayContinue: false },
    });
    expect(f.settledFor(ack.runId)).toHaveLength(1);
    expect(f.settledFor(ack.runId)[0].status).toBe("success");

    // Neither the unregistered reloaded page nor the stale frame can start a new run for A.
    await expect(
      f.invokeRun(f.a.id, { userTurnId: "turn-user-a-1", assistantTurnId: "turn-model-a-1" }),
    ).rejects.toThrow(exactly("MEMORY_DESKTOP_SESSION_DENIED"));
    await expect(
      f.invokeRun(f.a.id, { userTurnId: "turn-user-a-1", assistantTurnId: "turn-model-a-1" }, staleFrame),
    ).rejects.toThrow(exactly("MEMORY_DESKTOP_SESSION_DENIED"));
    expect(f.bridge.__getSessionActiveRunForTest(f.a.id)).toBeUndefined();
  });
});
