import { describe, expect, test } from "vitest";
import type { ChatMessage, ChatSession } from "../../../../../shared/chat-types";
import type { ChatMessageItem } from "../components/ChatMessageList";
import type { ComposerInteraction } from "../components/run-presentation";
import * as runtime from "./session-runtime-state";

function card(kind: "permission" | "ask" | "quiz", id: string): ComposerInteraction {
  if (kind === "permission") return { kind, id, toolName: "write_file", summary: id };
  if (kind === "quiz") return { kind, id, intro: "", questions: [] };
  return { kind, id, responseKind: "choice", question: "Which review scope?", options: [{ id: "yes", label: "Inspect this document" }, { id: "no", label: "Choose another document" }] };
}
function approvals(...ids: string[]) {
  return ids.reduce((state, id) => runtime.setSessionInteraction(state, "owner", card("permission", id)), {} as runtime.SessionInteractionState);
}
const shown = (state: runtime.SessionInteractionState, session = "owner") => runtime.sessionInteraction(state, session);
const question: ChatMessage = { id: "claim-1", role: "user", content: "Review the selected public document", at: 10 };
function answer(fields: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "reply", role: "model", content: "The selected document was reviewed", at: 11, answersUserMessageId: question.id,
    runSnapshot: { status: "terminal", terminalStatus: "success", updatedAt: 12 }, ...fields };
}
function recovery(messages: ChatMessage[]) {
  const session = { id: "s1", title: "Public document review", identityId: null, messages, createdAt: 1, updatedAt: 2, schemaVersion: 1 } as ChatSession;
  return runtime.evaluateClaimRecovery(session, question.id);
}

describe("Claim recovery requires evidence after the claimed user turn", () => {
  test.each(["running", "waiting_user", "interrupted"] as const)("a linked %s checkpoint still requires dispatch", status => {
    expect(recovery([question, answer({ content: "Preliminary findings", runSnapshot: { status, updatedAt: 12 } })])).toStrictEqual({ kind: "needs-dispatch" });
  });
  test("a matching terminal reply closes the dispatch ledger", () => {
    expect(recovery([question, answer()])).toStrictEqual({ kind: "dispatched" });
  });
  test("a bridge failure with text but no snapshot also settles the turn", () => {
    expect(recovery([question, answer({ content: "The bridge was unavailable", runSnapshot: undefined })])).toStrictEqual({ kind: "dispatched" });
  });
  test("a missing claim is corruption rather than successful dispatch", () => {
    expect(recovery([{ id: "other", role: "user", content: "An unrelated user turn", at: 5 }])).toStrictEqual({ kind: "claim-message-missing" });
  });
  test.each([
    ["no reply", [question]],
    ["legacy reply without an anchor", [question, answer({ answersUserMessageId: undefined })]],
    ["an older turn and an unlinked loading placeholder", [
      { id: "user-old", role: "user", content: "An earlier request", at: 2 },
      answer({ id: "assistant-old", content: "An earlier answer", answersUserMessageId: "user-old", at: 3, runSnapshot: { status: "terminal", terminalStatus: "success", updatedAt: 4 } }),
      question, answer({ id: "assistant-loading", content: "", answersUserMessageId: undefined, runSnapshot: { status: "running", updatedAt: 12 } }),
    ]],
    ["a matching anchor before the user message", [
      { id: "user-early", role: "user", content: "The first request", at: 1 },
      answer({ id: "assistant-early", content: "An out-of-order answer", at: 2, runSnapshot: { status: "terminal", terminalStatus: "success", updatedAt: 3 } }), question,
    ]],
  ] as Array<[string, ChatMessage[]]>)("%s cannot settle this claim", (_reason, messages) => {
    expect(recovery(messages)).toStrictEqual({ kind: "needs-dispatch" });
  });
});

describe("Session interactions preserve identity and arrival order", () => {
  test("cards belong to their session and clearing one session preserves its neighbour", () => {
    let state = runtime.setSessionInteraction({}, "left", card("ask", "ask-a"));
    expect(shown(state, "left")?.interaction.id).toEqual("ask-a");
    expect(shown(state, "right")).toBeUndefined();
    state = runtime.setSessionInteraction(state, "right", card("ask", "ask-b"));
    const cleared = runtime.clearSessionInteraction(state, "left");
    expect(shown(cleared, "left")).toBeUndefined();
    expect(shown(cleared, "right")?.interaction.id).toEqual("ask-b");
  });
  test("replayed visible and queued approvals retain one card each in FIFO order", () => {
    const initial = approvals("p1", "p2");
    expect(shown(initial)?.interaction.id).toEqual("p1");
    expect(shown(initial)?.queued.map(({ id }) => id)).toStrictEqual(["p2"]);
    expect(runtime.sessionInteractionPending(shown(initial))).toEqual(1);
    const replay = ["p1", "p2"].reduce((state, id) => runtime.setSessionInteraction(state, "owner", card("permission", id)), initial);
    expect(shown(replay)?.interaction.id).toEqual("p1");
    expect(shown(replay)?.queued.map(({ id }) => id)).toStrictEqual(["p2"]);
  });
  test("the kind is part of a card identity", () => {
    const state = runtime.setSessionInteraction(approvals("same"), "owner", card("ask", "same"));
    expect(shown(state)?.queued.map(({ kind }) => kind)).toStrictEqual(["ask"]);
  });
  test("clearing a busy head promotes its successor with reset flags", () => {
    const state = runtime.setSessionInteractionBusy(approvals("p1", "p2"), "owner", true);
    expect(shown(runtime.clearSessionInteraction(state, "owner", "p1"))).toMatchObject({ interaction: { id: "p2" }, busy: false, queued: [] });
  });
  test("a targeted clear removes only its queued card while a terminal clear removes all", () => {
    const initial = approvals("p1", "p2");
    expect(shown(runtime.clearSessionInteraction(initial, "owner", "p2"))).toMatchObject({ interaction: { id: "p1" }, queued: [] });
    expect(shown(runtime.clearSessionInteraction(initial, "owner"))).toBeUndefined();
    expect(runtime.clearSessionInteraction(initial, "owner", "gone")).toBe(initial);
  });
  test("a settlement broadcast removes cards across sessions and queue positions", () => {
    const state = runtime.setSessionInteraction(approvals("p1", "p2"), "elsewhere", card("permission", "p3"));
    const removed = ["p2", "p3"].reduce((current, id) => runtime.removeInteractionById(current, "permission", id), state);
    expect(shown(removed)).toMatchObject({ interaction: { id: "p1" }, queued: [] });
    expect(shown(removed, "elsewhere")).toBeUndefined();
    expect(runtime.removeInteractionById(state, "permission", "other")).toBe(state);
    expect(runtime.removeInteractionById(state, "quiz", "p1")).toBe(state);
  });
  test("a graded quiz remains visible on replay then yields immediately to a later approval", () => {
    const state = runtime.setSessionInteraction({}, "owner", card("quiz", "q1"));
    const graded = runtime.markInteractionResolved(state, "quiz", "q1");
    expect(shown(graded)?.interaction.id).toEqual("q1");
    expect(shown(runtime.setSessionInteraction(graded, "owner", card("quiz", "q1")))?.interaction.id).toEqual("q1");
    expect(shown(runtime.setSessionInteraction(graded, "owner", card("permission", "p1")))).toMatchObject({ interaction: { id: "p1" }, queued: [], busy: false });
    expect(runtime.markInteractionResolved(state, "quiz", "other")).toBe(state);
    expect(runtime.markInteractionResolved(state, "permission", "q1")).toBe(state);
  });
  test("submitting a quiz promotes an approval that is already waiting", () => {
    const first = runtime.setSessionInteraction({}, "owner", card("quiz", "q1"));
    const queued = runtime.setSessionInteraction(first, "owner", card("permission", "p1"));
    expect(shown(runtime.markInteractionResolved(queued, "quiz", "q1"))?.interaction.id).toEqual("p1");
  });
});

describe("Message projections and busy state stay scoped to their owner", () => {
  test("patching a background assistant replaces its objects while retaining siblings and other sessions", () => {
    const user: ChatMessageItem = { id: "user", role: "user", content: "review document" };
    const assistant: ChatMessageItem = { id: "assistant", role: "assistant", content: "" };
    const original = { background: [user, assistant], foreground: [{ id: "other", role: "assistant" as const, content: "other" }] };
    const updated = runtime.patchSessionMessage(original, "background", "assistant", { content: "continued" });
    expect(updated.background).not.toBe(original.background);
    expect(updated.background[0]).toBe(user);
    expect(updated.background[1]).not.toBe(assistant);
    expect(updated.background[1].content).toEqual("continued");
    expect(updated.foreground).toBe(original.foreground);
  });
  test("reopening an active session retains its live streaming array", () => {
    const live: ChatMessageItem[] = [{ id: "assistant", role: "assistant", content: "streaming", streaming: true }];
    const next = runtime.hydrateSessionMessages({ owner: live }, "owner", [{ id: "user", role: "user", content: "request" }], true);
    expect(next.owner).toBe(live);
  });
  test("composer busy state requires both a session record and current mode busy state", () => {
    const active = { owner: { runId: "run-a" }, neighbour: { runId: "run-b" } };
    expect(runtime.hasActiveRunForSession(active, "owner")).toEqual(true);
    expect(runtime.hasActiveRunForSession(active, "absent")).toEqual(false);
    expect(runtime.isCurrentRunBusy(active, "owner", true)).toEqual(true);
    expect(runtime.isCurrentRunBusy(active, "owner", false)).toEqual(false);
    expect(runtime.isCurrentRunBusy(active, "absent", true)).toEqual(false);
    expect(runtime.isCurrentRunBusy(active, undefined, true)).toEqual(false);
    expect(runtime.findSessionIdForRun(active, "run-b")).toEqual("neighbour");
  });
  test("binding another mode exposes its workspace label immediately", () => {
    expect(runtime.bindWorkspaceName({ chat: "Public documents" }, "code", "Review workspace")).toStrictEqual({ chat: "Public documents", code: "Review workspace" });
  });
  test("restoring a waiting checkpoint stops animation and records the interruption time", () => {
    const result = runtime.recoverInterruptedMessage({ id: "assistant-a", role: "assistant", content: "The review stopped mid-sentence", streaming: true, reasoningStreaming: true, runActivity: { startedAt: 10, reasoningMs: 20 } }, { runId: "run-a", status: "waiting_user", todos: [{ id: "todo-1", content: "Inspect remaining sections", status: "in_progress" }], updatedAt: 100 });
    expect(result).toMatchObject({ streaming: false, reasoningStreaming: false, loading: false, waitingForFirstEvent: false, runStage: { kind: "failed", detail: "上次运行已中断" }, runActivity: { completedAt: 100, keepExpanded: true } });
  });
});

describe("Todo checkpoints are local recovery evidence", () => {
  test("a new run replaces only its session Todo and rejects older-run events", () => {
    const previous: runtime.TodoStateBySession = { owner: { runId: "old", todos: [{ id: "old", content: "Review obsolete instructions", status: "pending" }], updatedAt: 1 }, neighbour: { runId: "run-b", todos: [{ id: "b", content: "B", status: "pending" }], updatedAt: 2 } };
    const started = runtime.startSessionTodos(previous, "owner", "new", 30);
    expect(started.owner).toStrictEqual({ runId: "new", todos: [], updatedAt: 30 });
    expect(started.neighbour).toBe(previous.neighbour);
    expect(runtime.mergeHarnessTodosForSession(started, "owner", "old", [{ id: "old", content: "Review obsolete instructions", status: "pending" }], 40)).toBe(started);
  });
  test("accepted Todos keep their order and timestamp without replacing another session", () => {
    const previous: runtime.TodoStateBySession = { neighbour: { runId: "run-b", todos: [{ id: "b-1", content: "Inspect neighbour B", status: "pending" }], updatedAt: 10 } };
    const items = [{ id: "1", content: "Complete the review", status: "completed" }, { id: "2", content: "Trace cancellation", status: "in_progress" }, { id: "3", content: "Discard previous investigation", status: "cancelled" }];
    const merged = runtime.mergeHarnessTodosForSession(previous, "owner", "run-a", items, 20);
    expect(merged.neighbour).toBe(previous.neighbour);
    expect(merged.owner).toStrictEqual({ runId: "run-a", todos: items.slice(0, 2), updatedAt: 20 });
  });
  test("cancelled, empty-id and unsupported Todo records do not enter presentation state", () => {
    const kept = { id: "ok", content: "Retain this valid step", status: "pending" };
    const result = runtime.mergeHarnessTodosForSession({}, "owner", "run-a", [kept, { id: "cancelled", content: "A cancelled step", status: "cancelled" }, { id: "", content: "Missing identifier", status: "pending" }, { id: "unknown", content: "Unsupported task state", status: "blocked" }], 20);
    expect(result.owner.todos).toStrictEqual([kept]);
  });
  test("an interrupted task describes Todo progress and tool facts without claiming side effects", () => {
    const context = runtime.buildTodoRecoveryContext([{ id: "assistant-old", role: "model", content: "", at: 1, runSnapshot: { status: "terminal", terminalStatus: "runtime_error", updatedAt: 2, todos: [{ id: "1", content: "Inspect module boundaries", status: "completed" }, { id: "2", content: "Trace abort handling", status: "in_progress" }, { id: "3", content: "Write findings", status: "pending" }] }, toolExecutions: [{ id: "t1", name: "read_file", status: "success" }, { id: "t2", name: "read_file", status: "error" }] }]);
    for (const fragment of ["[completed] Inspect module boundaries", "[in_progress] Trace abort handling", "工具执行事实：成功 1 项，失败 1 项", "不能证明外部副作用已经成功"]) expect(context).toContain(fragment);
    expect(runtime.buildTodoRecoveryContext([{ id: "assistant-ok", role: "model", content: "Review completed", at: 1, runSnapshot: { status: "terminal", terminalStatus: "success", updatedAt: 2, todos: [{ id: "1", content: "Complete the review", status: "completed" }] } }])).toBeUndefined();
  });
});
