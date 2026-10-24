// @vitest-environment jsdom
import React, { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatSession, PendingChatMessage } from "../../../../../shared/chat-types";
import type { AguiEvent, ChatStoreApi } from "./chat-page-bridge";

// Keep ChatPage, the queue and run controller real. These shells require layout
// or unrelated UI; the inspector exposes the actual page's plan projection.
vi.mock("react-resizable-panels", () => ({
  Group: ({ children, elementRef }: { children: React.ReactNode; elementRef: React.Ref<HTMLDivElement> }) => createElement("div", { ref: elementRef }, children),
  Panel: ({ children }: { children: React.ReactNode }) => createElement("section", null, children),
  Separator: () => null,
  useDefaultLayout: () => ({}),
  usePanelRef: () => useRef({ expand() {}, collapse() {} }),
}));
vi.mock("../components/ChatMessageList", () => ({ ChatMessageList: () => null }));
vi.mock("../components/ChatComposer", () => ({
  ChatComposer: () => null,
  parseComposerMessage: (_mode: string, content: string) => ({ rawContent: content, visibleContent: content }),
}));
vi.mock("../components/ChatPageNavigation", () => ({
  ChatPageNavigation: ({ onSelectSession }: { onSelectSession: (id: string) => void }) => createElement("nav", null, ...["a", "b"].map(id => createElement("button", { key: id, id: `select-${id}`, onClick: () => onSelectSession(`session-${id}`) }, id))),
}));
vi.mock("../components/ChatPageInspector", () => ({
  ChatPageInspector: ({ activePlan }: { activePlan?: { phase: string; content: string } | null }) => createElement("output", { id: "plan", "data-phase": activePlan?.phase }, activePlan?.content),
}));
vi.mock("../components/ChatPagePanelHost", () => ({ ChatPagePanelHost: () => null }));
import { ChatPage } from "./ChatPage";
import { FeedbackProvider } from "../../../components/feedback/FeedbackProvider";

type PlanEvent = AguiEvent & { threadId?: string };
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let listeners: Set<(event: AguiEvent) => void>;
let sessions: Record<string, ChatSession>;
let queues: Record<string, PendingChatMessage[]>;
let runs: string[];
let completeBeforeAck: boolean;
let startFailure: "reject" | "ack" | undefined;
const planPath = "C:\\plans\\session-a\\plan.md";
const phase = () => host.querySelector("#plan")?.getAttribute("data-phase");
function emit(event: PlanEvent) { for (const listener of [...listeners]) listener(event); }
function completion(overrides: Partial<PlanEvent> = {}): PlanEvent {
  return { type: "CUSTOM", name: "firefly.plan.completed", threadId: "session-a", runId: runs[0], value: { planPath, runStatus: "completed" }, ...overrides };
}
async function startPlan(sessionId = "session-a") {
  await act(async () => emit({ type: "CUSTOM", name: "firefly.plan.review", runId: `review-${sessionId}`, value: { sessionId, planPath, planContent: `Plan for ${sessionId}` } }));
  await act(async () => emit({ type: "CUSTOM", name: "firefly.plan.approved", runId: `review-${sessionId}`, value: { sessionId, planPath } }));
  expect(runs.length).toBeGreaterThan(0);
}

beforeEach(async () => {
  localStorage.clear(); localStorage.setItem("firefly-react-last-mode", "code");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addListener() {}, removeListener() {} });
  listeners = new Set(); runs = []; queues = {}; completeBeforeAck = false; startFailure = undefined;
  sessions = Object.fromEntries(["session-a", "session-b"].map(id => [id, { id, mode: "code", title: id, identityId: null, createdAt: 1, updatedAt: 1, messageCount: 0, messages: [] }])) as Record<string, ChatSession>;
  window.agui = {
    onEvent: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
    run: async input => {
      const runId = `run-${runs.length + 1}`; runs.push(runId);
      emit({ type: "RUN_STARTED", runId });
      if (completeBeforeAck) emit(completion());
      if (startFailure === "reject") throw Error("fixture start failure");
      if (startFailure === "ack") return { success: false, error: "fixture rejected ACK" };
      return { success: true, runId };
    },
    cancel: async () => undefined,
  };
  window.chatStore = {
    list: async options => options?.mode === "code" ? Object.values(sessions) : [],
    get: async id => sessions[id],
    append: async (id, message) => { sessions[id].messages.push(message); return sessions[id]; },
    upsert: async (id, message) => {
      const session = sessions[id];
      const index = session.messages.findIndex(item => item.id === message.id);
      if (index >= 0) session.messages[index] = message; else session.messages.push(message);
      return session;
    },
    pendingEnqueue: async (id, entry) => {
      const queue = queues[id] ??= []; queue.push({ ...entry, enqueuedAt: 1 });
      return { ok: true, queue: [...queue] };
    },
    pendingList: async id => queues[id] ?? [],
    pendingClaim: async id => {
      const entry = queues[id]?.shift();
      if (!entry) return { ok: true, claimed: false };
      const userMessage = { id: entry.id, role: "user" as const, content: entry.rawContent, at: 1 };
      sessions[id].messages.push(userMessage);
      return { ok: true, claimed: true, userMessage, visibleContent: entry.visibleContent, remainingQueue: [...queues[id]], session: sessions[id] };
    },
    pendingCompleteDispatch: async () => ({ ok: true }),
    setActiveSession: async () => {}, onChanged: () => () => {}, onReactSwitchSession: () => () => {}, notifyReactReady() {}, getRendererTargetId: () => "plan-fixture",
  } as ChatStoreApi;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(FeedbackProvider, null, createElement(ChatPage))));
  expect(host.querySelector("header h1")?.textContent).toBe("session-a");
});

afterEach(async () => {
  // Settle outstanding fixture runs before removing the page and its listeners.
  await act(async () => { for (const runId of runs) emit({ type: "RUN_FINISHED", runId, value: undefined, result: { status: "cancelled" } } as PlanEvent); });
  await act(async () => root?.unmount()); host?.remove();
  delete window.chatStore; delete window.agui; vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it.each(["failed", "cancelled", "halted", undefined])("does not complete an executing plan for status %s", async runStatus => {
  await startPlan();
  await act(async () => emit(completion({ value: { planPath, runStatus } })));
  expect(phase()).toBe("executing");
});

it.each([
  { threadId: "session-b" }, { threadId: undefined },
  { runId: "expired-run" }, { runId: undefined },
])("does not complete an executing plan for a mismatched identity %j", async identity => {
  await startPlan(); await act(async () => emit(completion(identity)));
  expect(phase()).toBe("executing");
});

it("completes only the matching successful executing plan", async () => {
  await startPlan(); await act(async () => emit(completion()));
  expect(phase()).toBe("completed");
});

it("preserves matching completion delivered before acknowledgement", async () => {
  completeBeforeAck = true; await startPlan();
  expect(phase()).toBe("completed");
});

it("does not complete a review without an executing run", async () => {
  await act(async () => emit({ type: "CUSTOM", name: "firefly.plan.review", value: { sessionId: "session-a", planPath, planContent: "Review only" } }));
  await act(async () => emit(completion({ runId: "expired-run" })));
  expect(phase()).toBe("review");
});

it("keeps session B unchanged when session A completes in the background", async () => {
  await startPlan();
  await act(async () => host.querySelector<HTMLButtonElement>("#select-b")!.click());
  await startPlan("session-b");
  await act(async () => emit(completion()));
  expect(phase()).toBe("executing");
  expect(host.querySelector("#plan")?.textContent).toBe("Plan for session-b");
  await act(async () => host.querySelector<HTMLButtonElement>("#select-a")!.click());
  expect(phase()).toBe("completed");
  expect(host.querySelector("#plan")?.textContent).toBe("Plan for session-a");
});

it("rejects completion of a replaced plan path", async () => {
  await startPlan(); await act(async () => emit(completion({ value: { planPath: "C:\\plans\\other.md", runStatus: "completed" } })));
  expect(phase()).toBe("executing");
});

it("rejects stale success after a failed terminal", async () => {
  await startPlan();
  await act(async () => emit({ type: "RUN_ERROR", runId: runs[0], message: "fixture failure" }));
  await act(async () => emit(completion()));
  expect(phase()).toBe("failed");
});

it("rejects an old execution run after a new run starts in the same session", async () => {
  await startPlan();
  await act(async () => emit({ type: "RUN_ERROR", runId: runs[0], message: "fixture failure" }));
  await startPlan();
  expect(runs).toHaveLength(2);
  await act(async () => emit(completion()));
  expect(phase()).toBe("executing");
  await act(async () => emit(completion({ runId: runs[1] })));
  expect(phase()).toBe("completed");
});

it("keeps successful completion stable over duplicate terminal and late running events", async () => {
  await startPlan();
  await act(async () => {
    emit(completion());
    emit({ type: "RUN_FINISHED", runId: runs[0], result: { status: "success" } } as PlanEvent);
  });
  expect(phase()).toBe("completed");
  await act(async () => {
    emit(completion());
    emit({ type: "RUN_STARTED", runId: runs[0] });
    emit({ type: "RUN_FINISHED", runId: runs[0], result: { status: "cancelled" } } as PlanEvent);
  });
  expect(phase()).toBe("completed");
});

it("preserves the cancelled run terminal without displaying plan completion", async () => {
  await startPlan();
  await act(async () => emit({ type: "RUN_FINISHED", runId: runs[0], result: { status: "cancelled" } } as PlanEvent));
  expect(phase()).toBe("cancelled");
  const assistant = sessions["session-a"].messages.find(message => message.role === "model");
  expect(assistant?.runSnapshot?.status).toBe("terminal");
  expect(assistant?.runSnapshot?.terminalStatus).toBe("cancelled");
});

it.each(["runtime_error", "timeout"])("displays a matching %s terminal as failed", async status => {
  await startPlan();
  await act(async () => emit({ type: "RUN_FINISHED", runId: runs[0], result: { status } } as PlanEvent));
  expect(phase()).toBe("failed");
});

it("rejects a stale failed terminal while the next plan executes", async () => {
  await startPlan();
  await act(async () => emit({ type: "RUN_ERROR", runId: runs[0], message: "first" }));
  await startPlan();
  await act(async () => emit({ type: "RUN_ERROR", runId: runs[0], message: "late" }));
  expect(phase()).toBe("executing");
});

it("updates only the matching background plan on cancellation", async () => {
  await startPlan();
  await act(async () => host.querySelector<HTMLButtonElement>("#select-b")!.click());
  await startPlan("session-b");
  await act(async () => emit({ type: "RUN_FINISHED", runId: runs[0], result: { status: "cancelled" } } as PlanEvent));
  expect(phase()).toBe("executing");
  await act(async () => host.querySelector<HTMLButtonElement>("#select-a")!.click());
  expect(phase()).toBe("cancelled");
});

it("does not retain completion when the same execution subsequently fails", async () => {
  await startPlan();
  await act(async () => { emit(completion()); emit({ type: "RUN_ERROR", runId: runs[0], message: "failed settlement" }); });
  expect(phase()).toBe("failed");
});

it.each(["reject", "ack"] as const)("displays a failed plan when run startup ends with %s", async failure => {
  startFailure = failure;
  await startPlan();
  expect(phase()).toBe("failed");
});

it("displays a failed plan when the model service is unavailable", async () => {
  delete window.agui;
  await act(async () => emit({ type: "CUSTOM", name: "firefly.plan.review", value: { sessionId: "session-a", planPath, planContent: "Plan" } }));
  await act(async () => emit({ type: "CUSTOM", name: "firefly.plan.approved", value: { sessionId: "session-a", planPath } }));
  expect(phase()).toBe("failed");
});

it.each(["missing-store", "enqueue-failure"])("marks approval dispatch as failed before a controller exists: %s", async failure => {
  if (failure === "missing-store") delete window.chatStore;
  else window.chatStore!.pendingEnqueue = async () => ({ ok: false, code: "SESSION_NOT_FOUND" });
  await act(async () => emit({ type: "CUSTOM", name: "firefly.plan.review", value: { sessionId: "session-a", planPath, planContent: "Dispatch failure" } }));
  await act(async () => emit({ type: "CUSTOM", name: "firefly.plan.approved", value: { sessionId: "session-a", planPath } }));
  expect(runs).toHaveLength(0); expect(phase()).toBe("failed");
});
it("can bind a fresh attempt after startup failed without an accepted run", async () => {
  startFailure = "reject"; await startPlan(); expect(phase()).toBe("failed");
  startFailure = undefined;
  await act(async () => emit({ type: "CUSTOM", name: "firefly.plan.supplement", value: { sessionId: "session-a", text: "Retry approved execution" } }));
  expect(runs).toHaveLength(2); expect(phase()).toBe("executing");
  await act(async () => emit(completion({ runId: runs[1] }))); expect(phase()).toBe("completed");
});
