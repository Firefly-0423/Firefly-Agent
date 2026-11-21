// @vitest-environment jsdom
// ChatPage regression packages B and G (docs/superpowers/plans/chatpage-regression.md): the real ChatPage, its
// pending-queue flow and run controller run together. Only IPC (chat store, AG-UI, file intake) and layout shells
// are replaced. The fake store follows the Main contracts in src/main/features/sessions/chats-store.ts.
import React, { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage, ChatSession, ConversationMode, PendingChatMessage, RunInsertionChanged } from "../../../../../shared/chat-types";
import type { AguiApi, AguiEvent, ChatStoreApi, PermissionApprovalRequest, SettingsApprovalApi } from "./chat-page-bridge";
import type { ChatMessageItem } from "../components/ChatMessageList";
import { t } from "../../../i18n";

vi.mock("react-resizable-panels", () => ({
  Group: ({ children, elementRef }: { children: React.ReactNode; elementRef: React.Ref<HTMLDivElement> }) => createElement("div", { ref: elementRef }, children),
  Panel: ({ children }: { children: React.ReactNode }) => createElement("section", null, children),
  Separator: () => null,
  useDefaultLayout: () => ({}),
  usePanelRef: () => useRef({ expand() {}, collapse() {} }),
}));
vi.mock("../components/ChatMessageList", async () => {
  const { placeRunInsertionBubbles } = await import("../components/run-insertion-bubbles");
  const { buildFlatRunTimeline } = await import("../components/agent-rounds");
  return {
    ChatMessageList: ({ messages, mode }: { messages: ChatMessageItem[]; mode: ConversationMode }) =>
      createElement("ol", { id: "messages" }, ...placeRunInsertionBubbles(messages, mode).map(item => {
        const timeline = item.insertionBubbles ? buildFlatRunTimeline({
          tools: item.toolExecutions ?? [], reasoningBlocks: [], taskDelegations: [], processMessages: [],
          insertionBubbles: item.insertionBubbles,
        }).map(step => createElement("div", { key: step.key, "data-timeline-step": step.kind },
          step.insertion?.content ?? step.tool?.name)) : [];
        return createElement("li", { key: item.id, "data-id": item.id, "data-role": item.role }, item.content, ...timeline);
      })),
  };
});
// A thin composer: ChatPage owns the draft, attachments and queue projection, so the real page logic stays in play.
vi.mock("../components/ChatComposer", () => ({
  parseComposerMessage: (_mode: string, content: string) => ({ rawContent: content.trim(), visibleContent: content.trim() }),
  ChatComposer: (props: {
    value: string; attachments: Array<{ name: string }>; pendingQueue: Array<{ id: string; content: string }>;
    onChange(value: string): void; onSubmit(value: string): void; onQueueMessage(value: string): void;
    onChooseFiles(files: File[]): void; onRemoveQueuedMessage(id: string): void;
  }) => createElement("form", { id: "composer" },
    createElement("output", { id: "draft" }, props.value),
    createElement("ul", { id: "attachments" }, ...props.attachments.map(file => createElement("li", { key: file.name }, file.name))),
    createElement("ul", { id: "queue" }, ...props.pendingQueue.map(item => createElement("li", { key: item.id, "data-id": item.id },
      item.content, createElement("button", { type: "button", "data-remove": item.id, onClick: () => props.onRemoveQueuedMessage(item.id) }, "x")))),
    createElement("button", { type: "button", id: "send", onClick: () => props.onSubmit(props.value) }, "send"),
    createElement("button", { type: "button", id: "queue-draft", onClick: () => props.onQueueMessage(props.value) }, "queue"),
    // Tests drive typing and file choice through these hooks on the element.
    createElement("input", { id: "typing", onChange: (event: { target: { value: string } }) => props.onChange(event.target.value) }),
    createElement("button", { type: "button", id: "attach", onClick: () => props.onChooseFiles(nextFiles.splice(0)) }, "attach")),
}));
vi.mock("../components/ChatPageNavigation", () => ({
  ChatPageNavigation: ({ onSelectSession }: { onSelectSession: (id: string) => void }) =>
    createElement("nav", null, ...["a", "b"].map(id => createElement("button", { key: id, id: `select-${id}`, onClick: () => onSelectSession(`session-${id}`) }, id))),
}));
vi.mock("../components/ChatPageInspector", () => ({ ChatPageInspector: () => null }));
vi.mock("../components/ChatPagePanelHost", () => ({ ChatPagePanelHost: () => null }));
import { ChatPage } from "./ChatPage";
import { FeedbackProvider } from "../../../components/feedback/FeedbackProvider";

type Ack = { success: boolean; runId?: string; error?: string };
/** The renderer bridges ChatPage reads from window (the preload exposes them; the renderer has no global types). */
const page = window as typeof window & { agui: AguiApi; chatStore: ChatStoreApi };
const nextFiles: File[] = [];
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let listeners: Set<(event: AguiEvent) => void>;
let historyChange: ((notice?: RunInsertionChanged) => void) | undefined;
let sessions: Record<string, ChatSession>;
let queues: Record<string, PendingChatMessage[]>;
let dispatching: Record<string, string | undefined>;
let runCalls: Array<Parameters<AguiApi["run"]>[0]>;
let acks: Array<Ack | Promise<Ack> | Error>;
let enqueueReplies: Array<"ok" | "error" | Error | Promise<void>>;
let interrupted: Record<string, { runId: string; rounds: number; todoCount: number } | null>;
let uuid: number;
let approvalListeners: Set<(request: PermissionApprovalRequest) => void>;
/** window.settings is the full settings bridge; ChatPage only reads its approval half, installed in installBridges. */
let approvals: SettingsApprovalApi;

const flush = () => act(async () => { for (let turn = 0; turn < 6; turn++) await new Promise<void>(resolve => setTimeout(resolve, 0)); });
const emit = (event: AguiEvent) => { for (const listener of [...listeners]) listener(event); };
const $ = <T extends Element>(selector: string) => host.querySelector<T>(selector);
const texts = (selector: string) => [...host.querySelectorAll(selector)].map(node => node.textContent);
const click = (selector: string) => act(async () => { $<HTMLButtonElement>(selector)!.click(); });
const buttonByText = (text: string) => [...host.querySelectorAll("button")].find(button => button.textContent === text);
async function type(value: string) {
  await act(async () => {
    const input = $<HTMLInputElement>("#typing")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function finishRun(runId: string, status: "success" | "cancelled" | "timeout" = "success") {
  emit({ type: "RUN_FINISHED", runId, result: { status, externalEffectsMayContinue: status !== "success" } });
}
/** Every claim the page made, in order, as [sessionId, outcome]. */
async function claims(): Promise<Array<[string, string]>> {
  const mock = page.chatStore!.pendingClaim as unknown as { mock: { calls: string[][]; results: Array<{ value: Promise<any> }> } };
  const outcomes = await Promise.all(mock.mock.results.map(result => result.value));
  return outcomes.map((reply, index) => [mock.mock.calls[index][0], reply.ok ? (reply.claimed ? `claimed ${reply.userMessage.id}` : "empty") : reply.error]);
}
function session(id: string, mode: ConversationMode, messages: ChatMessage[] = []): ChatSession {
  return { schemaVersion: 1, id, mode, title: id, identityId: null, createdAt: 1, updatedAt: 1, messages } as ChatSession;
}

function installBridges() {
  page.agui = {
    onEvent: (callback: (event: AguiEvent) => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; },
    run: async (input: Parameters<AguiApi["run"]>[0]) => {
      runCalls.push(structuredClone(input));
      const next = acks.shift() ?? { success: true, runId: `run-${runCalls.length}` };
      const ack = next instanceof Error ? (() => { throw next; })() : await next;
      if (ack.success && ack.runId) emit({ type: "RUN_STARTED", runId: ack.runId });
      return ack;
    },
    cancel: vi.fn(async () => undefined),
    reportRunPersisted: vi.fn(),
    getInterruptedRun: vi.fn(async (id: string) => interrupted[id] ?? null),
  } as unknown as AguiApi;
  const store: Partial<ChatStoreApi> = {
    list: async options => Object.values(sessions).filter(item => !options?.mode || item.mode === options.mode).map(item => ({ ...item, messageCount: item.messages.length })) as never,
    get: async id => sessions[id] ? structuredClone({
      ...sessions[id],
      pendingDispatch: dispatching[id] ? { messageId: dispatching[id], claimedAt: 2 } : undefined,
    }) : null,
    append: vi.fn(async (id: string, message: ChatMessage) => { sessions[id].messages.push(message); return structuredClone(sessions[id]); }),
    upsert: vi.fn(async (id: string, message: ChatMessage) => {
      const list = sessions[id].messages; const index = list.findIndex(item => item.id === message.id);
      if (index >= 0) list[index] = message; else list.push(message);
      return structuredClone(sessions[id]);
    }),
    pendingEnqueue: vi.fn(async (id: string, entry: Omit<PendingChatMessage, "enqueuedAt">) => {
      const reply = enqueueReplies.shift() ?? "ok";
      if (reply instanceof Error) throw reply;
      if (reply instanceof Promise) await reply;
      if (reply === "error") return { ok: false as const, error: "write-failed" as const };
      const queue = queues[id] ??= [];
      // Main absorbs a repeated id with the same content instead of adding it twice.
      if (!queue.some(item => item.id === entry.id)) queue.push({ ...structuredClone(entry), enqueuedAt: 1 });
      return { ok: true as const, enqueued: true, queue: structuredClone(queue) };
    }),
    pendingList: async id => structuredClone(queues[id] ?? []),
    pendingRemove: vi.fn(async (id: string, messageId: string) => {
      queues[id] = (queues[id] ?? []).filter(item => item.id !== messageId);
      return { ok: true, removed: true };
    }),
    pendingClaim: vi.fn(async (id: string) => {
      if (dispatching[id]) return { ok: false as const, error: "already-dispatching" as const };
      const entry = queues[id]?.shift();
      if (!entry) return { ok: true as const, claimed: false as const };
      const userMessage: ChatMessage = { id: entry.id, role: "user", content: entry.rawContent, at: 2 };
      sessions[id].messages.push(userMessage); dispatching[id] = entry.id;
      return {
        ok: true as const, claimed: true as const, userMessage, visibleContent: entry.visibleContent,
        remainingQueue: structuredClone(queues[id]), session: structuredClone(sessions[id]),
        ...(entry.resumeFromRunId ? { resumeFromRunId: entry.resumeFromRunId } : {}),
      };
    }),
    pendingCompleteDispatch: vi.fn(async (id: string) => { dispatching[id] = undefined; return { ok: true }; }),
    setActiveSession: vi.fn(async () => {}), onChanged: (() => {
      const observers = new Set<(notice?: RunInsertionChanged) => void>();
      return (receive: (notice?: RunInsertionChanged) => void) => {
        observers.add(receive); historyChange = notice => { for (const observer of [...observers]) observer(notice); };
        return () => { observers.delete(receive); };
      };
    })(),
    onReactSwitchSession: () => () => {},
    notifyReactReady() {},
  };
  page.chatStore = store as ChatStoreApi;
  approvals = {
    onPermissionApprovalRequest: callback => { approvalListeners.add(callback); return () => { approvalListeners.delete(callback); }; },
    onPermissionApprovalSettled: () => () => {},
    resolvePermissionApproval: vi.fn(async () => ({ ok: true })),
    onPopQuizRequest: () => () => {}, onPopQuizSettled: () => () => {},
    skipPopQuiz: vi.fn(async () => ({ ok: true })), resolvePopQuiz: vi.fn(async () => ({ ok: true }) as never),
  };
  Object.assign(window, { settings: approvals });
  // ChatPage only reads file intake from window.chat; the rest of that bridge is not part of these scenarios.
  Object.assign(window, { chat: {
    ingestDroppedFiles: vi.fn(async (files: File[]) => files.map(file => ({ kind: "document", name: file.name, filePath: `C:/fixture/${file.name}`, status: "done" }))),
  } });
}

async function mount(mode: ConversationMode, configure?: () => void) {
  installBridges();
  configure?.();
  localStorage.setItem("firefly-react-last-mode", mode);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(FeedbackProvider, null, createElement(ChatPage))));
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addListener() {}, removeListener() {} });
  uuid = 0; vi.spyOn(crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`);
  listeners = new Set(); approvalListeners = new Set(); queues = {}; dispatching = {}; runCalls = []; acks = []; enqueueReplies = []; interrupted = {}; nextFiles.length = 0;
  sessions = {};
});

describe("C7 read-only run status recovery", () => {
  test.each(["chat", "work", "code"] as const)("%s reload before ack finds the same assistant row, waits through settling and fills the terminal", async mode => {
    const partial: ChatMessage = { id: "original-assistant", role: "model", at: 2, content: "partial",
      toolExecutions: [{ id: "tool", name: "ask_user", status: "running" }] };
    sessions = { "session-a": session("session-a", mode, [{ id: "u", role: "user", at: 1, content: "task" }, partial]) };
    const waiting = { id: "queued-next", rawContent: "next task", visibleContent: "next task", enqueuedAt: 3 };
    queues["session-a"] = [waiting];
    let phase: "running" | "settling" | "finished" = "running";
    let seq = 1;
    const query = vi.fn(async (request: Parameters<NonNullable<AguiApi["getRunStatus"]>>[0]) => {
      expect(page.chatStore.setActiveSession).toHaveBeenCalledWith("session-a", mode);
      expect(request).toEqual({ sessionId: "session-a", candidates: [{ assistantTurnId: "original-assistant" }] });
      return [{ sessionId: "session-a", assistantTurnId: "original-assistant", runId: "main-run", seq, phase,
        ...(phase === "finished" ? { message: { ...partial, content: "final answer", toolExecutions: [{ id: "tool", name: "ask_user", status: "success" as const, result: "approved" }],
          runSnapshot: { runId: "main-run", status: "terminal" as const, terminalStatus: "success" as const, updatedAt: 10 } } } : {}) }];
    });
    await mount(mode, () => { page.agui.getRunStatus = query as NonNullable<AguiApi["getRunStatus"]>; });
    expect(texts("#messages li")).toEqual(["task", "partial"]);
    await act(async () => emit({ type: "RUN_ERROR", runId: "main-run", code: "E_HARNESS_FAILURE" }));
    phase = "settling"; seq++;
    await act(async () => document.dispatchEvent(new Event("visibilitychange"))); await flush();
    expect(texts("#messages li")).toEqual(["task", "partial"]);
    expect(runCalls).toEqual([]);
    expect(page.chatStore.upsert).not.toHaveBeenCalled();
    expect(approvals.resolvePermissionApproval).not.toHaveBeenCalled();
    expect(page.chatStore.pendingClaim).not.toHaveBeenCalled();
    expect(queues["session-a"]).toEqual([waiting]);
    phase = "finished"; seq++;
    await act(async () => document.dispatchEvent(new Event("visibilitychange"))); await flush();
    expect(texts("#messages li")).toEqual(["task", "final answer"]);
    expect(runCalls).toEqual([]);
    expect(page.chatStore.upsert).not.toHaveBeenCalled();
    expect(page.agui.reportRunPersisted).not.toHaveBeenCalled();
    expect(page.chatStore.pendingClaim).not.toHaveBeenCalled();
    expect(queues["session-a"]).toEqual([waiting]);
  });

  test.each(["manual", "queued"] as const)("returning to a session completed in the background releases observed busy state for %s work", async source => {
    const partial: ChatMessage = { id: "a", role: "model", at: 1, content: "partial",
      runSnapshot: { runId: "r", status: "running", updatedAt: 1 } };
    sessions = { "session-a": session("session-a", "work", [partial]),
      "session-b": session("session-b", "work", [{ id: "b", role: "model", at: 1, content: "other answer" }]) };
    const query = vi.fn(async () => [{ sessionId: "session-a", assistantTurnId: "a", runId: "r", seq: 1, phase: "running" as const }]);
    await mount("work", () => { page.agui.getRunStatus = query; });
    expect(runCalls).toEqual([]);
    await click("#select-b"); await flush();
    sessions["session-a"].messages = [{ ...partial, content: "final answer",
      runSnapshot: { runId: "r", status: "terminal", terminalStatus: "success", updatedAt: 2 } }];
    if (source === "queued") queues["session-a"] = [{ id: "queued-next", rawContent: "next task", visibleContent: "next task", enqueuedAt: 3 }];
    await click("#select-a"); await flush();
    expect(texts("#messages li")[0]).toBe("final answer");
    if (source === "manual") { await type("next task"); await click("#send"); await flush(); }
    expect(query).toHaveBeenCalledTimes(1);
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].sessionId).toBe("session-a");
    expect(queues["session-a"] ?? []).toEqual([]);
  });

  test("ordinary completed legacy replies do not query or schedule status polling", async () => {
    sessions = { "session-a": session("session-a", "work", [{ id: "old", role: "model", at: 1, content: "saved answer" }]) };
    const query = vi.fn(async () => []);
    await mount("work", () => { page.agui.getRunStatus = query; });
    expect(query).not.toHaveBeenCalled();
    expect(texts("#messages li")).toEqual(["saved answer"]);
  });

  test.each(["unavailable", "rejected"])("%s status keeps pending work untouched on reload and allows an explicit send to reach Main", async failure => {
    sessions = { "session-a": session("session-a", "work", [{ id: "a", role: "model", at: 1, content: "partial",
      runSnapshot: { runId: "r", status: "running", updatedAt: 1 } }]) };
    const waiting = { id: "queued-next", rawContent: "next task", visibleContent: "next task", enqueuedAt: 3 };
    queues["session-a"] = [waiting];
    const query = vi.fn(async () => {
      if (failure === "rejected") throw new Error("offline");
      return [{ assistantTurnId: "a", phase: "unavailable" as const }];
    });
    await mount("work", () => { page.agui.getRunStatus = query; });
    expect(page.chatStore.pendingClaim).not.toHaveBeenCalled();
    expect(runCalls).toEqual([]);
    expect(queues["session-a"]).toEqual([waiting]);
    await type("continue explicitly"); await click("#send"); await flush();
    expect(page.chatStore.pendingClaim).toHaveBeenCalledWith("session-a");
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].sessionId).toBe("session-a");
  });

  test("terminal backfill keeps a delivered insertion once and ignores an older subsequent history snapshot", async () => {
    const partial: ChatMessage = { id: "a", role: "model", at: 2, content: "partial", runSnapshot: { runId: "r", status: "running", updatedAt: 2 } };
    sessions = { "session-a": session("session-a", "work", [partial]) };
    let finished = false;
    const query = vi.fn(async () => [{ sessionId: "session-a", assistantTurnId: "a", runId: "r", seq: finished ? 2 : 1,
      phase: finished ? "finished" as const : "running" as const,
      ...(finished ? { message: { ...partial, content: "final", runActivity: { startedAt: 2, completedAt: 9, reasoningMs: 0 },
        agentRounds: [{ id: "round-1", status: "completed" as const, startedAt: 2, completedAt: 9 }],
        runSnapshot: { runId: "r", status: "terminal" as const, terminalStatus: "success" as const, updatedAt: 9 } } } : {}) }]);
    await mount("work", () => { page.agui.getRunStatus = query as NonNullable<AguiApi["getRunStatus"]>; });
    const insertion: ChatMessage = { id: "i", role: "user", at: 3, content: "also check",
      runInsertion: { version: 1, assistantTurnId: "a", runId: "r", sequence: 1, revision: 1, delivery: { round: 1, order: 1 } } };
    sessions["session-a"].messages.push(insertion);
    finished = true;
    await act(async () => document.dispatchEvent(new Event("visibilitychange"))); await flush();
    expect(texts("#messages li")).toEqual(["finalalso check"]);
    await act(async () => historyChange?.({ runInsertionSessionId: "session-a" })); await flush();
    expect(texts("#messages li")).toEqual(["finalalso check"]);
    expect(runCalls).toEqual([]);
    expect(page.chatStore.upsert).not.toHaveBeenCalled();
    expect(approvals.resolvePermissionApproval).not.toHaveBeenCalled();
  });

  test("a late status for the previous session cannot render or consume its pending queue", async () => {
    sessions = { "session-a": session("session-a", "work", [{ id: "a", role: "model", at: 1, content: "old partial", runSnapshot: { runId: "r", status: "running", updatedAt: 1 } }]),
      "session-b": session("session-b", "work", [{ id: "b", role: "model", at: 1, content: "other answer" }]) };
    let complete!: (items: import("../../../../../shared/run-status").RunStatusItem[]) => void;
    const query = vi.fn(async (request: Parameters<NonNullable<AguiApi["getRunStatus"]>>[0]) => {
      if (request.sessionId === "session-a") return new Promise<import("../../../../../shared/run-status").RunStatusItem[]>(done => { complete = done; });
      return [{ assistantTurnId: "b", phase: "unavailable" as const }];
    });
    await mount("work", () => { page.agui.getRunStatus = query; });
    await click("#select-b"); await flush();
    await act(async () => complete([{ sessionId: "session-a", assistantTurnId: "a", runId: "r", seq: 9, phase: "finished",
      message: { id: "a", role: "model", at: 1, content: "late answer" } }])); await flush();
    expect(texts("#messages li")).toEqual(["other answer"]);
    expect(runCalls).toEqual([]);
    expect(page.chatStore.upsert).not.toHaveBeenCalled();
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("ChatPage package B: recovery, takeover and the pending queue", () => {
  test.each(["work", "code"] as const)("B1 %s: continuing an interrupted task dispatches once with its run id", async mode => {
    sessions = { "session-a": session("session-a", mode, [{ id: "old-user", role: "user", content: "Refactor the parser", at: 1 }]), "session-b": session("session-b", mode) };
    queues["session-b"] = [{ id: "b-waiting", rawContent: "Other task", visibleContent: "Other task", enqueuedAt: 1 }];
    interrupted["session-a"] = { runId: "run-old", rounds: 3, todoCount: 0 };
    await mount(mode);
    const resume = buttonByText(t("workspaceNotices.resumeTask"));
    expect(resume).toBeDefined();
    await act(async () => { resume!.click(); }); await flush();
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]).toMatchObject({ sessionId: "session-a", resumeFromRunId: "run-old" });
    expect(runCalls[0].messages.at(-1)).toMatchObject({ role: "user", content: t("chatPage.resumeLastTaskMessage") });
    // The page runs one recovery pass on open (nothing queued yet); the resume then claims exactly once.
    expect(await claims()).toEqual([["session-a", "empty"], ["session-a", `claimed ${runCalls[0].userTurnId}`]]);
    expect(sessions["session-b"].messages).toEqual([]);
    expect(queues["session-b"].map(item => item.id)).toEqual(["b-waiting"]);
    finishRun("run-1"); await flush();
    expect(runCalls).toHaveLength(1);
    expect(sessions["session-a"].messages.map(item => [item.role, item.runSnapshot?.terminalStatus])).toEqual([["user", undefined], ["user", undefined], ["model", "success"]]);
  });

  test("B1 chat: no task resume entry is offered and the interrupted run is not even looked up", async () => {
    sessions = { "session-a": session("session-a", "chat"), "session-b": session("session-b", "chat") };
    interrupted["session-a"] = { runId: "run-old", rounds: 3, todoCount: 0 };
    await mount("chat");
    expect(buttonByText(t("workspaceNotices.resumeTask"))).toBeUndefined();
    expect(page.agui!.getInterruptedRun).not.toHaveBeenCalled();
    expect(runCalls).toEqual([]);
  });
  test.each([false, true])("B4: a takeover timeout pauses only the original session (old run finished before reply: %s)", async (endedBeforeReply) => {
    sessions = { "session-a": session("session-a", "code"), "session-b": session("session-b", "code") };
    let reply!: (value: Ack) => void;
    acks = [
      { success: false, error: "SESSION_RUN_ACTIVE:old-a" },
      new Promise<Ack>(resolve => { reply = resolve; }),
    ];
    await mount("code");
    const restart = t("workspaceNotices.takeoverAndRestart");
    const waiting = t("workspaceNotices.takeoverWaiting");
    const timeout = t("workspaceNotices.takeoverStuck");
    await type("first"); await click("#send"); await flush();
    const firstId = runCalls[0].userTurnId;
    await act(async () => { buttonByText(restart)!.click(); }); await flush();
    expect(buttonByText(waiting)?.disabled).toBe(true);
    if (endedBeforeReply) { await act(async () => finishRun("old-a")); await flush(); }
    await act(async () => { reply({ success: false, error: "Error invoking remote method: Error: SESSION_RUN_TAKEOVER_STUCK:old-a" }); });
    await flush();
    expect(buttonByText(waiting)).toBeUndefined();
    expect(buttonByText(restart)).toBeUndefined();
    if (!endedBeforeReply) {
      expect(host.textContent).toContain(timeout);
      const claimsBefore = await claims();
      await type("queued"); await click("#send"); await flush();
      await act(async () => { finishRun("not-old-a"); emit({ type: "RUN_ERROR", runId: "old-a", code: "E_HARNESS_FAILURE" }); }); await flush();
      expect(await claims()).toEqual(claimsBefore);
      expect(runCalls).toHaveLength(2);
      expect(queues["session-a"].map(item => item.visibleContent)).toEqual(["queued"]);
      await click("#select-b"); await flush();
      expect(host.textContent).not.toContain(timeout);
      await type("other session"); await click("#send"); await flush();
      expect(runCalls[2].sessionId).toBe("session-b");
      await act(async () => finishRun("run-3")); await flush();
      expect(runCalls).toHaveLength(3);
      await click("#select-a"); await flush();
      await act(async () => { finishRun("old-a"); finishRun("old-a"); }); await flush();
    }
    expect(runCalls.filter(call => call.sessionId === "session-a").map(call => [call.userTurnId, call.takeoverFromRunId]))
      .toEqual([[firstId, undefined], [firstId, "old-a"], [firstId, undefined]]);
    if (!endedBeforeReply) {
      await act(async () => finishRun("run-4")); await flush();
      expect(runCalls[4].sessionId).toBe("session-a");
      expect(sessions["session-a"].messages.filter(item => item.role === "user").map(item => item.content)).toEqual(["first", "queued"]);
    }
  });
  test("B4: if only a run error is delivered, a manual retry still goes through the old run's guard", async () => {
    sessions = { "session-a": session("session-a", "code") };
    acks = [
      { success: false, error: "SESSION_RUN_ACTIVE:old-a" },
      { success: false, error: "SESSION_RUN_TAKEOVER_STUCK:old-a" },
    ];
    await mount("code"); await type("first"); await click("#send"); await flush();
    await act(async () => { buttonByText(t("workspaceNotices.takeoverAndRestart"))!.click(); }); await flush();
    await act(async () => emit({ type: "RUN_ERROR", runId: "old-a", code: "E_HARNESS_FAILURE" })); await flush();
    expect(runCalls).toHaveLength(2);
    await act(async () => { buttonByText(t("workspaceNotices.takeoverRetry"))!.click(); }); await flush();
    expect(runCalls.map(call => [call.userTurnId, call.takeoverFromRunId]))
      .toEqual([[runCalls[0].userTurnId, undefined], [runCalls[0].userTurnId, "old-a"], [runCalls[0].userTurnId, "old-a"]]);
    expect(buttonByText(t("workspaceNotices.takeoverRetry"))).toBeUndefined();
    await act(async () => finishRun("run-3")); await flush();
  });
  test("B2: a send that meets an old run shows one restart card, queues further sends and takes over once", async () => {
    sessions = { "session-a": session("session-a", "code"), "session-b": session("session-b", "code") };
    acks = [{ success: false, error: "SESSION_RUN_ACTIVE:run-before-refresh" }];
    await mount("code");
    const restartCards = () => [...host.querySelectorAll("button")].filter(button => button.textContent === t("workspaceNotices.takeoverAndRestart"));
    await type("first question"); await click("#send"); await flush();
    const first = runCalls[0].userTurnId;
    expect(runCalls).toHaveLength(1);
    expect(restartCards()).toHaveLength(1);
    expect(dispatching["session-a"]).toEqual(first);
    // A second send while the conflict stands only queues; the first claim stays intact.
    const claimsBefore = await claims();
    await type("second question"); await click("#send"); await flush();
    expect(runCalls).toHaveLength(1);
    expect(restartCards()).toHaveLength(1);
    expect(await claims()).toEqual(claimsBefore);
    expect(texts("#queue li")).toEqual(["second questionx"]);
    await act(async () => { restartCards()[0].click(); }); await flush();
    expect(runCalls.map(call => [call.userTurnId, call.takeoverFromRunId])).toEqual([[first, undefined], [first, "run-before-refresh"]]);
    expect(restartCards()).toHaveLength(0);
    expect(dispatching["session-a"]).toBeUndefined();
    finishRun("run-2"); await flush();
    // The queued second message is consumed once, after the takeover run has settled.
    expect(runCalls).toHaveLength(3);
    expect((await claims()).slice(claimsBefore.length)).toEqual([["session-a", `claimed ${runCalls[2].userTurnId}`]]);
    expect(sessions["session-a"].messages.map(item => [item.role, item.content || item.runSnapshot?.terminalStatus])).toEqual([
      ["user", "first question"], ["model", "success"], ["user", "second question"], ["model", undefined],
    ]);
    expect(sessions["session-b"].messages).toEqual([]);
    expect(page.agui!.cancel).not.toHaveBeenCalled();
    // Recovery notices hide while a run is active, so the card is checked again once every run has settled.
    finishRun("run-3"); await flush();
    expect(restartCards()).toHaveLength(0);
  });

  test.each(["work", "code"] as const)("a committed insertion leaves the queue, then joins the live %s timeline once delivered", async mode => {
    sessions = { "session-a": session("session-a", mode), "session-b": session("session-b", mode) };
    await mount(mode);
    await type("start"); await click("#send"); await flush();
    await type("add this"); await click("#send"); await flush();
    expect(texts("#queue li")).toEqual(["add thisx"]);
    const [queued] = queues["session-a"];
    const owner = runCalls[0].assistantTurnId!;
    const runCount = runCalls.length;
    const round = (id: string, action: string) => emit({ type: "CUSTOM", name: "firefly.round", value: { roundId: id, action }, runId: "run-1" });
    const tool = (id: string, name: string) => emit({ type: "TOOL_CALL_START", toolCallId: id, toolCallName: name, runId: "run-1" });
    await act(async () => { round("round-0", "start"); tool("read", "read_file"); round("round-0", "end"); });
    await flush();
    queues["session-a"] = [];
    sessions["session-a"].messages.push({ id: queued.id, role: "user", content: queued.visibleContent, at: 3,
      runInsertion: { version: 1, runId: "run-1", assistantTurnId: owner, sequence: 1, revision: 1 } });
    await act(async () => { historyChange!({ runInsertionSessionId: "session-a" }); });
    await flush();
    expect(texts("#queue li")).toEqual([]);
    expect(texts("#messages [data-role='user']")).toEqual(["start", "add this"]);
    expect($(`#messages [data-id="${owner}"]`)).not.toBeNull();
    expect(runCalls).toHaveLength(runCount);
    await act(async () => { round("round-1", "start"); tool("write", "write_file"); });
    await flush();
    const committed = sessions["session-a"].messages.find(message => message.id === queued.id)!;
    committed.runInsertion!.delivery = { round: 1, order: 1 };
    await act(async () => {
      historyChange!({ runInsertionSessionId: "session-a" });
      historyChange!({ runInsertionSessionId: "session-a" });
    });
    await flush();
    expect(texts("#messages [data-role='user']")).toEqual(["start"]);
    expect(texts(`#messages [data-id="${owner}"] [data-timeline-step]`)).toEqual(["read_file", "add this", "write_file"]);
    expect(texts("#queue li")).toEqual([]);
    expect(runCalls).toHaveLength(runCount);
    await act(async () => { finishRun("run-1"); }); await flush();
  });

  test("B5: while a run is busy, two sends queue in order and removing one touches only that id", async () => {
    sessions = { "session-a": session("session-a", "work"), "session-b": session("session-b", "work") };
    queues["session-b"] = [{ id: "b-waiting", rawContent: "Neighbour task", visibleContent: "Neighbour task", enqueuedAt: 1 }];
    await mount("work");
    await type("start the review"); await click("#send"); await flush();
    expect(runCalls).toHaveLength(1);
    await type("then check the tests"); await click("#send"); await flush();
    expect(texts("#draft")).toEqual([""]);
    await type("and update the notes"); await click("#send"); await flush();
    const [second, third] = queues["session-a"].map(item => item.id);
    expect(queues["session-a"].map(item => item.rawContent)).toEqual(["then check the tests", "and update the notes"]);
    expect(texts("#queue li")).toEqual(["then check the testsx", "and update the notesx"]);
    await click(`[data-remove="${second}"]`); await flush();
    expect(page.chatStore!.pendingRemove).toHaveBeenCalledTimes(1);
    expect(page.chatStore!.pendingRemove).toHaveBeenCalledWith("session-a", second);
    expect(queues["session-a"].map(item => item.id)).toEqual([third]);
    expect(texts("#queue li")).toEqual(["and update the notesx"]);
    // Queued text never enters the formal history before it is claimed.
    expect(sessions["session-a"].messages.map(item => item.content).filter(Boolean)).toEqual(["start the review"]);
    expect(queues["session-b"].map(item => item.id)).toEqual(["b-waiting"]);
    finishRun("run-1"); await flush();
    expect(runCalls.map(call => call.userTurnId)).toEqual([runCalls[0].userTurnId, third]);
    expect(sessions["session-a"].messages.some(item => item.id === second)).toEqual(false);
    expect(runCalls.every(call => call.sessionId === "session-a")).toEqual(true);
  });

  test.each([
    ["a store refusal", "error"],
    ["a transport error", new Error("ipc channel closed")],
  ] as const)("B8: after %s the draft and attachment stay, nothing runs, and the retry keeps one stable entry", async (_label, failure) => {
    sessions = { "session-a": session("session-a", "work"), "session-b": session("session-b", "work") };
    await mount("work");
    nextFiles.push(new File(["notes"], "brief.txt", { type: "text/plain" })); await click("#attach"); await flush();
    await type("summarise the brief");
    enqueueReplies = [failure];
    await click("#send"); await flush();
    expect(texts("#draft")).toEqual(["summarise the brief"]);
    expect(texts("#attachments li")).toEqual(["brief.txt"]);
    expect(runCalls).toEqual([]);
    expect(queues["session-a"] ?? []).toEqual([]);
    expect(sessions["session-a"].messages).toEqual([]);
    await click("#send"); await flush();
    const attempts = (page.chatStore!.pendingEnqueue as unknown as { mock: { calls: Array<[string, { id: string }]> } }).mock.calls;
    expect(attempts.map(([sessionId, entry]) => [sessionId, entry.id])).toEqual([["session-a", attempts[0][1].id], ["session-a", attempts[0][1].id]]);
    expect(runCalls.map(call => call.userTurnId)).toEqual([attempts[0][1].id]);
    expect(sessions["session-a"].messages.filter(item => item.role === "user").map(item => item.id)).toEqual([attempts[0][1].id]);
    expect(texts("#draft")).toEqual([""]);
    expect(texts("#attachments li")).toEqual([]);
  });

  test("B9: typing and attaching while the enqueue is pending survives the earlier send", async () => {
    sessions = { "session-a": session("session-a", "code"), "session-b": session("session-b", "code") };
    await mount("code");
    nextFiles.push(new File(["a"], "first.txt", { type: "text/plain" })); await click("#attach"); await flush();
    await type("send the first one");
    let release!: () => void;
    enqueueReplies = [new Promise<void>(resolve => { release = resolve; })];
    await click("#send"); await flush();
    expect(texts("#draft")).toEqual(["send the first one"]);
    await type("a follow-up thought");
    nextFiles.push(new File(["b"], "second.txt", { type: "text/plain" })); await click("#attach"); await flush();
    await act(async () => { release(); }); await flush();
    expect(queues["session-a"] ?? []).toEqual([]);
    expect(runCalls).toHaveLength(1);
    expect(sessions["session-a"].messages[0]).toMatchObject({ role: "user", content: "send the first one" });
    expect(texts("#draft")).toEqual(["a follow-up thought"]);
    expect(texts("#attachments li")).toEqual(["second.txt"]);
  });
});

/** Main broadcasts an approval to every window; the page decides which conversation owns it. */
function requestApproval(id: string, runId?: string) {
  const request: PermissionApprovalRequest = { id, toolId: "file_editor", toolName: "Edit file", toolDescription: "Edit a workspace file",
    risk: "fs-write", args: { path: `${id}.md` }, ...(runId ? { runId } : {}) };
  for (const listener of [...approvalListeners]) listener(request);
}
/** The real permission panel ComposerSlot shows, identified by the target path each request carries. */
const card = () => $(".ff-interaction-panel") ? texts(".ff-interaction-panel dd[title]") : null;
const writes = () => (page.chatStore!.upsert as unknown as { mock: { calls: Array<[string, ChatMessage]> } }).mock.calls.map(([id]) => id);

describe("ChatPage package G: approval ownership", () => {
  test("G1: a background run's approval belongs to its own session and never shows in the visible one", async () => {
    sessions = { "session-a": session("session-a", "code"), "session-b": session("session-b", "code") };
    await mount("code");
    await type("edit the notes"); await click("#send"); await flush();
    expect(runCalls.map(call => call.sessionId)).toEqual(["session-a"]);
    await click("#select-b"); await flush();
    const before = writes().length;
    await act(async () => { requestApproval("approve-1", "run-1"); }); await flush();
    expect(card()).toBeNull();
    expect(writes().slice(before).every(id => id === "session-a")).toEqual(true);
    expect(sessions["session-b"].messages).toEqual([]);
    await click("#select-a"); await flush();
    expect(card()).toEqual(["approve-1.md"]);
    expect(approvals.resolvePermissionApproval).not.toHaveBeenCalled();
    await act(async () => { buttonByText(t("interaction.allow"))!.click(); }); await flush();
    expect(approvals.resolvePermissionApproval).toHaveBeenCalledExactlyOnceWith("approve-1", true);
    expect(runCalls).toHaveLength(1);
  });

  test.each([
    ["G1", "an unknown run", "session-a", "run-gone"],
    ["G1", "an unknown run", "session-b", "run-gone"],
    ["G3", "no run", "session-a", undefined],
    ["G3", "no run", "session-b", undefined],
  ] as const)("%s: an approval naming %s lands nowhere while %s is visible", async (_task, _label, visible, runId) => {
    sessions = { "session-a": session("session-a", "work"), "session-b": session("session-b", "work") };
    await mount("work");
    await type("summarise the logs"); await click("#send"); await flush();
    if (visible === "session-b") { await click("#select-b"); await flush(); }
    const before = writes().length;
    await act(async () => { requestApproval("approve-stray", runId); }); await flush();
    expect(card()).toBeNull();
    await click(visible === "session-a" ? "#select-b" : "#select-a"); await flush();
    expect(card()).toBeNull();
    // No checkpoint is written for a card nobody owns, and nothing is answered or dispatched on its behalf.
    // A card without a run id is answered in the toast window instead (G3; covered by the toast tests).
    expect(writes().slice(before)).toEqual([]);
    expect(approvals.resolvePermissionApproval).not.toHaveBeenCalled();
    expect(runCalls.map(call => call.sessionId)).toEqual(["session-a"]);
    expect(sessions["session-b"].messages).toEqual([]);
  });
});
