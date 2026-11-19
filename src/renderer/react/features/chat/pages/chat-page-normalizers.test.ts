import { afterEach, it, describe, expect, test, vi } from "vitest";
import type { ChatMessage, ChatSession } from "../../../../../shared/chat-types";
import { t } from "../../../i18n";
import { toUiMessages, permissionInteraction, stageForStep, normalizeWeatherData, getInitialMode, LAST_MODE_STORAGE_KEY } from "./chat-page-normalizers";

afterEach(() => vi.unstubAllGlobals());
function history(message: Partial<ChatMessage>): ChatSession {
  return { schemaVersion: 1, id: "archive-27", title: "Renderer history fixture", identityId: null,
    mode: "chat", createdAt: 40, updatedAt: 90, messages: [
      { id: "message-27", role: "user", at: 60, content: "请检查附件", ...message },
    ] };
}

describe("Saved data projected into a chat view", () => {
  it("adds defaults to Open-Meteo output and identifies executing tools", () => {
    const location = { city: "杭州", province: "浙江" };
    expect(normalizeWeatherData({ source: "open-meteo", location, weatherCode: 3, temp: 21,
      humidity: 72, windDeg: 90, windSpeed: 8 })).toStrictEqual({
      source: "open-meteo", location, weatherCode: 3, temp: 21, feelsLike: 21,
      humidity: 72, windDeg: 90, windSpeed: 8, precipitation: 0, pressure: 0,
    });
    expect(stageForStep("agent-graph-tool-read_file")).toStrictEqual({ detail: "read_file", kind: "executing" });
  });

  it("retains channel provenance and keeps model-only context separate", () => {
    const origin = { channel: "wechat" as const, chatType: "private" as const, senderName: "小夏" };
    const [direct] = toUiMessages(history({ channelSource: origin }));
    expect(direct.channelSource).toStrictEqual(origin);
    expect(direct.modelContext).toEqual(undefined);
    const hidden = "[QQ群发送者：小夏]\n请检查附件";
    const [group] = toUiMessages(history({ modelContext: hidden,
      channelSource: { channel: "qq", chatType: "group", senderName: "小夏" } }));
    expect(group.modelContext).toEqual(hidden);
    const malformed = history({ channelSource: { channel: "unsupported" } as unknown as ChatMessage["channelSource"] });
    expect(toUiMessages(malformed)[0].channelSource).toEqual(undefined);
  });

  it.each(["failed", "cancelled", "completed"] as const)("keeps %s delegation records across serialization without mutating storage", (status) => {
    const saved = history({ role: "model", content: "资料整理完毕",
      taskDelegations: [{ invocationId: "child-27", taskId: "docs-27", description: "整理引用",
        nickname: "艾利欧", assetFileName: "艾利欧.png", roundId: "turn-27", status }],
      runSnapshot: { runId: "run-27", status: "terminal", terminalStatus: "success", updatedAt: 90 } });
    const serialized = JSON.stringify(saved);
    for (const input of [saved, JSON.parse(serialized) as ChatSession])
      expect(toUiMessages(input)[0].taskDelegations).toStrictEqual(saved.messages[0].taskDelegations);
    expect(JSON.stringify(saved)).toEqual(serialized);
  });

  it.each(["interrupted", "unknown", "pending", "success"] as const)("lets canonical %s settlement override a stale running cache", (state) => {
    const saved = history({ role: "model", content: "stale display text", ttsCacheKey: "old-audio",
      runSnapshot: { runId: "run-28", status: "running", updatedAt: 90 },
      sSettlement: { state, runId: "run-28", assistantEntryId: "entry-28", originalText: "canonical response" } });
    const before = JSON.stringify(saved);
    const [view] = toUiMessages(saved);
    expect(view.content).toEqual(state === "success" ? "canonical response" : "");
    expect(view.streaming).toEqual(false);
    expect(view.sSettlement?.originalText).toEqual("canonical response");
    expect(view.runStage?.kind).toEqual(state === "success" ? "completed" : "failed");
    if (state !== "success") expect(view.ttsCacheKey).toEqual(undefined);
    expect(JSON.stringify(saved)).toEqual(before);
  });

  it("exposes child approval attribution only when the request supplies it", () => {
    const request = { id: "approval-27", toolId: "write_file", toolName: "Write file", toolDescription: "",
      args: { path: "notes.md" }, risk: "fs-write" as const, runId: "parent-27" };
    expect(permissionInteraction({ ...request, agentId: "document-agent", toolCallId: "tool-27", childRunId: "child-28" }))
      .toMatchObject({ id: "approval-27", kind: "permission", agentId: "document-agent", toolCallId: "tool-27", childRunId: "child-28" });
    const standalone = permissionInteraction(request);
    for (const omitted of ["agentId", "childRunId"]) expect(standalone).not.toHaveProperty(omitted);
  });
});

describe("Initial navigation mode", () => {
  it("uses the shared persisted key and defaults retired, absent and invalid modes to chat", () => {
    const memory = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => memory.get(key) ?? null });
    expect(LAST_MODE_STORAGE_KEY).toEqual("firefly-react-last-mode");
    expect(getInitialMode()).toEqual("chat");
    for (const [stored, expected] of [["learn", "chat"], ["work", "work"], ["code", "code"], ["invalid-mode", "chat"]]) {
      memory.set("firefly-react-last-mode", stored);
      expect(getInitialMode()).toEqual(expected);
    }
  });
});

describe("stored run snapshots projected on reopen (ChatPage A8)", () => {
  test.each(["running", "waiting_user"] as const)(
    "stops animations and marks %s checkpoints as interrupted while keeping stored output and tool records",
    (status) => {
      const interruptedDetail = t("chatPage.lastRunInterrupted");
      expect(interruptedDetail).not.toBe("chatPage.lastRunInterrupted");
      expect(interruptedDetail.length).toBeGreaterThan(0);

      const stored: ChatMessage = {
        id: "m-a8-unfinished",
        role: "model",
        at: 100,
        content: "Partial markdown answer",
        reasoning: "Checking workspace files",
        processMessages: [{ id: "proc-1", content: "Reading configuration", seq: 1 }],
        toolExecutions: [
          {
            id: "tool-1",
            name: "read_file",
            status: "running",
            argsText: "{\"path\":\"README.md\"}",
            seq: 2,
          },
        ],
        runSnapshot: { runId: "run-a8", status, updatedAt: 250 },
        runActivity: { startedAt: 120, reasoningMs: 45, activeReasoningStartedAt: 200 },
      };

      const [projected] = toUiMessages(history(stored));
      expect(projected).toStrictEqual({
        id: "m-a8-unfinished",
        role: "assistant",
        content: "Partial markdown answer",
        modelContext: undefined,
        channelSource: undefined,
        reasoning: "Checking workspace files",
        reasoningBlocks: undefined,
        processMessages: [{ id: "proc-1", content: "Reading configuration", seq: 1 }],
        agentRounds: undefined,
        taskDelegations: undefined,
        ttsCacheKey: undefined,
        ttsCacheVersion: undefined,
        responseStarted: true,
        sticker: undefined,
        // A tool left running is shown as ended by the interruption, never as a success and never replayed.
        toolExecutions: [
          {
            id: "tool-1",
            name: "read_file",
            status: "error",
            result: interruptedDetail,
            argsText: "{\"path\":\"README.md\"}",
            seq: 2,
          },
        ],
        attachments: undefined,
        contextUsage: undefined,
        workReadReport: undefined,
        runId: "run-a8",
        streaming: false,
        reasoningStreaming: false,
        loading: false,
        waitingForFirstEvent: false,
        runStage: { kind: "failed", detail: interruptedDetail },
        runActivity: {
          startedAt: 120,
          reasoningMs: 45,
          activeReasoningStartedAt: undefined,
          completedAt: 250,
          keepExpanded: true,
        },
      });
    },
  );

  test.each([
    {
      label: "terminal:success",
      snapshot: { runId: "run-term-success", status: "terminal" as const, terminalStatus: "success" as const, updatedAt: 300 },
    },
    {
      label: "terminal:cancelled",
      snapshot: { runId: "run-term-cancelled", status: "terminal" as const, terminalStatus: "cancelled" as const, updatedAt: 300 },
    },
    {
      label: "terminal:timeout",
      snapshot: { runId: "run-term-timeout", status: "terminal" as const, terminalStatus: "timeout" as const, updatedAt: 300 },
    },
    {
      label: "terminal:runtime_error",
      snapshot: { runId: "run-term-error", status: "terminal" as const, terminalStatus: "runtime_error" as const, updatedAt: 300 },
    },
    {
      label: "interrupted",
      snapshot: { runId: "run-interrupted", status: "interrupted" as const, updatedAt: 300 },
    },
  ])("preserves $label snapshots without adding runStage or rewriting animation flags", ({ snapshot }) => {
    const baseStored: ChatMessage = {
      id: "m-a8-settled-or-interrupted",
      role: "model",
      at: 100,
      content: "Recorded output",
      reasoning: "Recorded reasoning",
      processMessages: [{ id: "proc-2", content: "Finished step", seq: 1 }],
      toolExecutions: [{ id: "tool-2", name: "read_file", status: "success", result: "ok", seq: 2 }],
      runActivity: { startedAt: 100, completedAt: 300, reasoningMs: 20 },
    };

    const [withoutSnapshot] = toUiMessages(history(baseStored));
    const [withSnapshot] = toUiMessages(history({ ...baseStored, runSnapshot: snapshot }));

    expect("runStage" in withSnapshot).toBe(false);
    for (const animField of ["streaming", "reasoningStreaming", "loading", "waitingForFirstEvent"] as const) {
      expect(animField in withSnapshot).toBe(false);
    }
    expect(withSnapshot).toStrictEqual({ ...withoutSnapshot, runId: snapshot.runId });
  });

  test.each([
    { state: "success" as const, committed: true },
    { state: "interrupted" as const, committed: false },
    { state: "unknown" as const, committed: false },
  ])("projects sSettlement ($state) text, process filter, media caches, runStage, and runActivity", ({ state, committed }) => {
    const sSettlement: NonNullable<ChatMessage["sSettlement"]> = {
      assistantEntryId: "m-a8-settled",
      originalText: "Settled final answer",
      runId: "run-settled",
      state,
    };
    const stored: ChatMessage = {
      id: "m-a8-settled",
      role: "model",
      at: 100,
      content: "Stale intermediate body",
      sticker: "playful",
      ttsCacheKey: "tts-key-1",
      ttsCacheVersion: "v1",
      runActivity: { startedAt: 100, reasoningMs: 30, activeReasoningStartedAt: 150 },
      processMessages: [
        { id: "p-drop", content: "Settled final answer", interrupted: true },
        { id: "p-keep-not-interrupted", content: "Settled final answer", interrupted: false },
        { id: "p-keep-diff-text", content: "Earlier step", interrupted: true },
      ],
      sSettlement,
    };

    const [projected] = toUiMessages(history(stored));
    expect(projected).toStrictEqual({
      id: "m-a8-settled",
      role: "assistant",
      content: committed ? "Settled final answer" : "",
      transientText: undefined,
      modelContext: undefined,
      channelSource: undefined,
      reasoning: undefined,
      reasoningBlocks: undefined,
      processMessages: [
        { id: "p-keep-not-interrupted", content: "Settled final answer", interrupted: false },
        { id: "p-keep-diff-text", content: "Earlier step", interrupted: true },
      ],
      agentRounds: undefined,
      taskDelegations: undefined,
      ttsCacheKey: committed ? "tts-key-1" : undefined,
      ttsCacheVersion: committed ? "v1" : undefined,
      responseStarted: committed,
      sticker: committed ? "playful" : undefined,
      toolExecutions: undefined,
      attachments: undefined,
      contextUsage: undefined,
      workReadReport: undefined,
      sSettlement,
      runId: "run-settled",
      loading: false,
      waitingForFirstEvent: false,
      streaming: false,
      reasoningStreaming: false,
      runStage: { kind: committed ? "completed" : "failed" },
      runActivity: {
        startedAt: 100,
        reasoningMs: 30,
        activeReasoningStartedAt: undefined,
        completedAt: 100,
        keepExpanded: !committed,
      },
    });
  });

  test.each([
    { state: "interrupted" as const, committed: false },
    { state: "success" as const, committed: true },
  ])("combines running runSnapshot and sSettlement ($state) in projection order", ({ state, committed }) => {
    const sSettlement: NonNullable<ChatMessage["sSettlement"]> = {
      assistantEntryId: "m-a8-combo",
      originalText: "Committed body",
      runId: "run-settled-combo",
      state,
    };
    const stored: ChatMessage = {
      id: "m-a8-combo",
      role: "model",
      at: 100,
      content: "Partial body",
      runSnapshot: { runId: "run-snap-combo", status: "running", updatedAt: 260 },
      runActivity: { startedAt: 120, reasoningMs: 15, activeReasoningStartedAt: 180 },
      processMessages: [
        { id: "p-drop", content: "Committed body", interrupted: true },
        { id: "p-keep", content: "Checking files", seq: 1 },
      ],
      sSettlement,
    };

    const [projected] = toUiMessages(history(stored));
    expect(projected).toStrictEqual({
      id: "m-a8-combo",
      role: "assistant",
      content: committed ? "Committed body" : "",
      transientText: undefined,
      modelContext: undefined,
      channelSource: undefined,
      reasoning: undefined,
      reasoningBlocks: undefined,
      processMessages: [{ id: "p-keep", content: "Checking files", seq: 1 }],
      agentRounds: undefined,
      taskDelegations: undefined,
      ttsCacheKey: undefined,
      ttsCacheVersion: undefined,
      responseStarted: committed,
      sticker: undefined,
      toolExecutions: undefined,
      attachments: undefined,
      contextUsage: undefined,
      workReadReport: undefined,
      sSettlement,
      runId: "run-settled-combo",
      loading: false,
      waitingForFirstEvent: false,
      streaming: false,
      reasoningStreaming: false,
      runStage: { kind: committed ? "completed" : "failed" },
      runActivity: {
        startedAt: 120,
        reasoningMs: 15,
        activeReasoningStartedAt: undefined,
        completedAt: 260,
        keepExpanded: !committed,
      },
    });
  });

  test("projects stored checkpoints cleanly without mutating ChatSession or calling window bridges", () => {
    // chat-page-normalizers.test.ts executes under Vitest's node environment where window bridges
    // do not exist by default; stub the renderer bridge globals with spies to verify zero calls.
    const bridgeSpies = {
      chatStore: {
        get: vi.fn(),
        list: vi.fn(),
        upsert: vi.fn(),
        append: vi.fn(),
        replaceTail: vi.fn(),
        pendingClaim: vi.fn(),
        pendingList: vi.fn(),
        pendingCompleteDispatch: vi.fn(),
      },
      agui: {
        run: vi.fn(),
        cancel: vi.fn(),
        getInterruptedRun: vi.fn(),
        reportRunPersisted: vi.fn(),
        onEvent: vi.fn(),
      },
      choice: {
        resolve: vi.fn(),
      },
      settings: {
        resolvePermissionApproval: vi.fn(),
        resolvePopQuiz: vi.fn(),
        skipPopQuiz: vi.fn(),
      },
      sidebar: {
        openSettings: vi.fn(),
      },
    };
    vi.stubGlobal("window", bridgeSpies);

    const session = history({
      id: "m-a8-pure",
      role: "model",
      at: 100,
      content: "Running tool output",
      processMessages: [{ id: "p-1", content: "Step 1", seq: 1 }],
      toolExecutions: [{ id: "tool-running", name: "bash", status: "running", argsText: "{\"cmd\":\"pwd\"}", seq: 2 }],
      runSnapshot: { runId: "run-pure", status: "running", updatedAt: 280 },
      runActivity: { startedAt: 100, reasoningMs: 10, activeReasoningStartedAt: 150 },
    });
    const beforeCall = structuredClone(session);

    const projected = toUiMessages(session);
    expect(projected).toHaveLength(1);
    expect(session).toStrictEqual(beforeCall);

    for (const bridge of Object.values(bridgeSpies)) {
      for (const spy of Object.values(bridge)) {
        expect(spy).toHaveBeenCalledTimes(0);
      }
    }
  });
});
