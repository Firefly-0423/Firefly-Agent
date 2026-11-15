// @vitest-environment jsdom
// ChatPage regression package B (docs/superpowers/plans/2026-11-12-chatpage-regression.md): the real ChatPage, its
// pending-queue flow and run controller run together. Only IPC (chat store, AG-UI, file intake) and layout shells
// are replaced. The fake store follows the Main contracts in src/main/features/sessions/chats-store.ts.
import React, { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage, ChatSession, ConversationMode, PendingChatMessage } from "../../../../../shared/chat-types";
import type { AguiApi, AguiEvent, ChatStoreApi } from "./chat-page-bridge";
import { t } from "../../../i18n";

vi.mock("react-resizable-panels", () => ({
  Group: ({ children, elementRef }: { children: React.ReactNode; elementRef: React.Ref<HTMLDivElement> }) => createElement("div", { ref: elementRef }, children),
  Panel: ({ children }: { children: React.ReactNode }) => createElement("section", null, children),
  Separator: () => null,
  useDefaultLayout: () => ({}),
  usePanelRef: () => useRef({ expand() {}, collapse() {} }),
}));
vi.mock("../components/ChatMessageList", () => ({
  ChatMessageList: ({ messages }: { messages: Array<{ id: string; role: string; content: string }> }) =>
    createElement("ol", { id: "messages" }, ...messages.map(item => createElement("li", { key: item.id, "data-id": item.id, "data-role": item.role }, item.content))),
}));
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
let sessions: Record<string, ChatSession>;
let queues: Record<string, PendingChatMessage[]>;
let dispatching: Record<string, string | undefined>;
let runCalls: Array<Parameters<AguiApi["run"]>[0]>;
let acks: Array<Ack | Promise<Ack> | Error>;
let enqueueReplies: Array<"ok" | "error" | Error | Promise<void>>;
let interrupted: Record<string, { runId: string; rounds: number; todoCount: number } | null>;
let uuid: number;

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
    get: async id => sessions[id] ? structuredClone(sessions[id]) : null,
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
    setActiveSession: async () => {}, onChanged: () => () => {}, onReactSwitchSession: () => () => {},
    notifyReactReady() {},
  };
  page.chatStore = store as ChatStoreApi;
  // ChatPage only reads file intake from window.chat; the rest of that bridge is not part of these scenarios.
  Object.assign(window, { chat: {
    ingestDroppedFiles: vi.fn(async (files: File[]) => files.map(file => ({ kind: "document", name: file.name, filePath: `C:/fixture/${file.name}`, status: "done" }))),
  } });
}

async function mount(mode: ConversationMode) {
  installBridges();
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
  listeners = new Set(); queues = {}; dispatching = {}; runCalls = []; acks = []; enqueueReplies = []; interrupted = {}; nextFiles.length = 0;
  sessions = {};
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
    // A second send while the conflict stands only queues: the retained claim blocks a new dispatch.
    await type("second question"); await click("#send"); await flush();
    expect(runCalls).toHaveLength(1);
    expect(restartCards()).toHaveLength(1);
    expect((await claims()).slice(2)).toEqual([["session-a", "already-dispatching"]]);
    expect(texts("#queue li")).toEqual(["second questionx"]);
    await act(async () => { restartCards()[0].click(); }); await flush();
    expect(runCalls.map(call => [call.userTurnId, call.takeoverFromRunId])).toEqual([[first, undefined], [first, "run-before-refresh"]]);
    expect(restartCards()).toHaveLength(0);
    expect(dispatching["session-a"]).toBeUndefined();
    finishRun("run-2"); await flush();
    // The queued second message is consumed once, after the takeover run has settled.
    expect(runCalls).toHaveLength(3);
    expect((await claims()).slice(3)).toEqual([["session-a", `claimed ${runCalls[2].userTurnId}`]]);
    expect(sessions["session-a"].messages.map(item => [item.role, item.content || item.runSnapshot?.terminalStatus])).toEqual([
      ["user", "first question"], ["model", "success"], ["user", "second question"], ["model", undefined],
    ]);
    expect(sessions["session-b"].messages).toEqual([]);
    expect(page.agui!.cancel).not.toHaveBeenCalled();
    // Recovery notices hide while a run is active, so the card is checked again once every run has settled.
    finishRun("run-3"); await flush();
    expect(restartCards()).toHaveLength(0);
  });

});
