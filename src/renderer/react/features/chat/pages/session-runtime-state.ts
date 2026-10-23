import type { ChatMessage, ChatSession, ConversationMode } from "../../../../../shared/chat-types";
import type { TodoItem } from "../../../../../shared/todo-types";
import type { ChatMessageItem } from "../components/ChatMessageList";
import type { ComposerInteraction } from "../components/run-presentation";
import { t } from "../../../i18n";

export type SessionInteractionEntry = {
  resolved?: boolean; queued: ComposerInteraction[]; busy: boolean; interaction: ComposerInteraction;
};
export type SessionInteractionState = Record<string, SessionInteractionEntry>;
type HarnessTodoPresentation = { status: string; content: string; id: string };
export type SessionTodoState = { updatedAt: number; todos: TodoItem[]; runId?: string };
export type TodoStateBySession = Record<string, SessionTodoState>;
export type ClaimRecoveryStatus = { kind: "dispatched" } | { kind: "needs-dispatch" } | { kind: "claim-message-missing" };

function isSameInteraction(card: ComposerInteraction, kind: ComposerInteraction["kind"], id: string): boolean {
  return card.kind === kind && card.id === id;
}

export function bindWorkspaceName(state: Partial<Record<ConversationMode, string>>, mode: ConversationMode, displayName: string | undefined): Partial<Record<ConversationMode, string>> {
  const updated = { ...state, [mode]: displayName };
  return updated;
}

export function sessionInteraction(state: SessionInteractionState, sessionId: string | undefined): SessionInteractionEntry | undefined {
  if (sessionId) return state[sessionId];
  return undefined;
}

export function sessionInteractionPending(entry: SessionInteractionEntry | undefined): number {
  const count = entry?.queued.length;
  return count ?? 0;
}

export function setSessionInteraction(state: SessionInteractionState, sessionId: string, interaction: ComposerInteraction, busy = false): SessionInteractionState {
  const previous = state[sessionId];
  if (!previous) return { ...state, [sessionId]: { interaction, busy, queued: [] } };
  if (isSameInteraction(previous.interaction, interaction.kind, interaction.id)) return { ...state, [sessionId]: { ...previous, interaction } };
  if (previous.resolved) return { ...state, [sessionId]: { interaction, busy, queued: [...previous.queued] } };
  const offset = previous.queued.findIndex((card) => isSameInteraction(card, interaction.kind, interaction.id));
  const waiting = offset < 0 ? [...previous.queued, interaction]
    : previous.queued.map((card, position) => position === offset ? interaction : card);
  return { ...state, [sessionId]: { ...previous, queued: waiting } };
}

function dropInteraction(state: SessionInteractionState, sessionId: string, kind: ComposerInteraction["kind"], id: string): SessionInteractionState {
  const previous = state[sessionId];
  if (!previous) return state;
  if (isSameInteraction(previous.interaction, kind, id)) {
    const [promoted, ...waiting] = previous.queued;
    const updated = { ...state };
    if (promoted) updated[sessionId] = { interaction: promoted, busy: false, queued: waiting };
    else delete updated[sessionId];
    return updated;
  }
  if (!previous.queued.some((card) => isSameInteraction(card, kind, id))) return state;
  return { ...state, [sessionId]: { ...previous, queued: previous.queued.filter((card) => !isSameInteraction(card, kind, id)) } };
}

export function clearSessionInteraction(state: SessionInteractionState, sessionId: string, id?: string): SessionInteractionState {
  const previous = state[sessionId];
  if (!previous) return state;
  if (id !== undefined) {
    const matching = [previous.interaction, ...previous.queued].find((card) => card.id === id);
    return matching ? dropInteraction(state, sessionId, matching.kind, id) : state;
  }
  const updated = { ...state };
  delete updated[sessionId];
  return updated;
}

export function markInteractionResolved(state: SessionInteractionState, kind: ComposerInteraction["kind"], id: string): SessionInteractionState {
  const owner = Object.keys(state).find((key) => isSameInteraction(state[key].interaction, kind, id));
  if (!owner) return state;
  const previous = state[owner];
  if (previous.queued.length > 0) return dropInteraction(state, owner, kind, id);
  if (previous.resolved) return state;
  return { ...state, [owner]: { ...previous, resolved: true } };
}

export function removeSessionInteractionsWhere(state: SessionInteractionState, sessionId: string, predicate: (interaction: ComposerInteraction) => boolean): SessionInteractionState {
  const previous = state[sessionId];
  if (!previous) return state;
  const removed = [previous.interaction, ...previous.queued].filter(predicate);
  let updated = state;
  for (const card of removed) updated = dropInteraction(updated, sessionId, card.kind, card.id);
  return updated;
}

export function removeInteractionById(state: SessionInteractionState, kind: ComposerInteraction["kind"], id: string): SessionInteractionState {
  let updated = state;
  for (const owner of Object.keys(state)) updated = dropInteraction(updated, owner, kind, id);
  return updated;
}

export function setSessionInteractionBusy(state: SessionInteractionState, sessionId: string, busy: boolean): SessionInteractionState {
  const previous = state[sessionId];
  if (!previous) return state;
  return { ...state, [sessionId]: { ...previous, busy } };
}

export function patchSessionMessage(state: Record<string, ChatMessageItem[]>, sessionId: string, messageId: string, patch: Partial<ChatMessageItem>): Record<string, ChatMessageItem[]> {
  const entries = (state[sessionId] ?? []).map((entry) => entry.id === messageId ? { ...entry, ...patch } : entry);
  return { ...state, [sessionId]: entries };
}

export function hydrateSessionMessages(state: Record<string, ChatMessageItem[]>, sessionId: string, storedMessages: ChatMessageItem[], hasActiveRun: boolean): Record<string, ChatMessageItem[]> {
  return hasActiveRun && state[sessionId] ? state : { ...state, [sessionId]: storedMessages };
}

export function recoverInterruptedMessage(message: ChatMessageItem, snapshot: NonNullable<ChatMessage["runSnapshot"]>): ChatMessageItem {
  if (snapshot.status === "terminal" || snapshot.status === "interrupted") return message;
  return {
    ...message, streaming: false, reasoningStreaming: false, loading: false, waitingForFirstEvent: false,
    runStage: { kind: "failed", detail: t("chatPage.lastRunInterrupted") },
    runActivity: {
      ...(message.runActivity ?? { startedAt: snapshot.updatedAt, reasoningMs: 0 }),
      activeReasoningStartedAt: undefined, completedAt: snapshot.updatedAt, keepExpanded: true,
    },
  };
}

export function findSessionIdForRun(activeRuns: Record<string, { runId?: string }>, runId: string | undefined): string | undefined {
  if (!runId) return undefined;
  const matching = Object.entries(activeRuns).find(([, entry]) => entry.runId === runId);
  return matching?.[0];
}

export function hasActiveRunForSession(activeRuns: Record<string, unknown>, sessionId: string): boolean {
  const registered = activeRuns[sessionId];
  return Boolean(registered);
}

export function isCurrentRunBusy(activeRuns: Record<string, unknown>, sessionId: string | undefined, modeBusy: boolean): boolean {
  if (!sessionId || !modeBusy) return false;
  return Boolean(hasActiveRunForSession(activeRuns, sessionId));
}

export function buildTodoRecoveryContext(messages: readonly ChatMessage[], excludedMessageId?: string): string | undefined {
  const latest = [...messages].reverse().find((entry) => {
    if (entry.id === excludedMessageId) return false;
    const checkpoint = entry.runSnapshot;
    if (!checkpoint?.todos?.some((todo) => todo.status === "pending" || todo.status === "in_progress")) return false;
    return checkpoint.status !== "terminal" || checkpoint.terminalStatus !== undefined && checkpoint.terminalStatus !== "success";
  });
  if (!latest?.runSnapshot?.todos) return undefined;
  const okCount = latest.toolExecutions?.filter((tool) => tool.status === "success").length ?? 0;
  const errorCount = latest.toolExecutions?.filter((tool) => tool.status === "error").length ?? 0;
  const lines = [
    "上一次任务在完整回答提交前中断。以下内容来自同一会话的本地检查点，仅用于恢复方向：", "Todo：",
    ...latest.runSnapshot.todos.map((todo) => "- [" + todo.status + "] " + todo.content),
    "工具执行事实：成功 " + okCount + " 项，失败 " + errorCount + " 项。",
    "Todo 和本地记录不能证明外部副作用已经成功；继续前请根据现有证据查证，不要自动重放危险操作。",
  ];
  return lines.join("\n");
}

export function startSessionTodos(state: TodoStateBySession, sessionId: string, runId: string | undefined, updatedAt = Date.now()): TodoStateBySession {
  return { ...state, [sessionId]: { runId, todos: [], updatedAt } };
}

export function mergeHarnessTodosForSession(state: TodoStateBySession, sessionId: string, runId: string | undefined, items: readonly HarnessTodoPresentation[], updatedAt = Date.now()): TodoStateBySession {
  const previous = state[sessionId];
  if (previous?.runId && runId && previous.runId !== runId) return state;
  const accepted = items.flatMap<TodoItem>((entry) => {
    if (!entry.id || !entry.content) return [];
    if (entry.status !== "pending" && entry.status !== "in_progress" && entry.status !== "completed") return [];
    return [{ id: entry.id, content: entry.content, status: entry.status }];
  });
  return { ...state, [sessionId]: { runId: previous?.runId ?? runId, todos: accepted, updatedAt } };
}

export function evaluateClaimRecovery(session: ChatSession, messageId: string): ClaimRecoveryStatus {
  const offset = session.messages.findIndex((entry) => entry.id === messageId && entry.role === "user");
  if (offset < 0) return { kind: "claim-message-missing" };
  const settled = session.messages.slice(offset + 1).some((entry) => {
    if (entry.role !== "model" || entry.answersUserMessageId !== messageId) return false;
    return entry.runSnapshot ? entry.runSnapshot.status === "terminal" : Boolean(entry.content.trim() || entry.sticker);
  });
  return { kind: settled ? "dispatched" : "needs-dispatch" };
}
