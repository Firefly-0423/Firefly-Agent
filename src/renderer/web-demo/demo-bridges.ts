// 在线演示的桌面接口替身：会话只存在页面内存里，发消息时按剧本回放 AG-UI 事件，不发任何网络请求。
// 需要桌面能力的接口（选文件夹、导出、打开设置等）一律如实失败，不做假结果。

import type { ChatMessage, ChatSession, ChatSessionMeta, ConversationMode, PendingChatMessage, ToolFileChange } from "../../shared/chat-types";
import type { CodeGitChangedPayload, CodeGitFileChange, CodeGitStatus } from "../../shared/code-git-types";
import type { ContextUsageSnapshot } from "../../shared/context-usage";
import type { AguiApi, AguiEvent, ChatStoreApi, PermissionApprovalRequest, PermissionApprovalSettled, SettingsApprovalApi } from "../react/features/chat/pages/chat-page-bridge";
import { demoSessions, demoTurn, type DemoLang, type DemoTurn } from "./demo-content";

const CONTEXT_WINDOW = 128_000;
const clone = (session: ChatSession): ChatSession => ({ ...session, messages: session.messages.map(message => ({ ...message })) });
const meta = (session: ChatSession): ChatSessionMeta => ({
  id: session.id, title: session.title, identityId: session.identityId, createdAt: session.createdAt, updatedAt: session.updatedAt,
  messageCount: session.messages.length, mode: session.mode, ...(session.pinned ? { pinned: true } : {}),
  ...(session.workspaceBinding ? { workspaceRoot: session.workspaceBinding.workspaceRoot, workspaceDisplayName: session.workspaceBinding.displayName } : {}),
});

/** Splits text into small chunks so it streams like a model reply. */
export function chunks(text: string, size = 6): string[] {
  const points = Array.from(text), out: string[] = [];
  for (let at = 0; at < points.length; at += size) out.push(points.slice(at, at + size).join(""));
  return out;
}

export function usageSnapshot(tokens: number, messageCount: number, runId: string): ContextUsageSnapshot {
  const share = (ratio: number) => Math.round(tokens * ratio);
  return {
    phase: "terminal", runId, updatedAt: Date.now(), messageCount, contextWindowTokens: CONTEXT_WINDOW, totalTokens: tokens,
    categories: [
      { key: "systemPrompt", tokens: share(0.18) }, { key: "tools", tokens: share(0.34) }, { key: "skills", tokens: share(0.08) },
      { key: "runtimeAndToolLogs", tokens: share(0.22) }, { key: "conversation", tokens: tokens - share(0.18) - share(0.34) - share(0.08) - share(0.22) },
    ],
  };
}

/** A scripted step: an event after a pause, or a tool that waits for the visitor's approval. */
export type DemoStep =
  | { kind: "event"; delayMs: number; event: AguiEvent }
  | { kind: "approval"; toolCallId: string; request: Omit<PermissionApprovalRequest, "id" | "runId"> };

export function scriptSteps(turn: DemoTurn, runId: string, messageCount: number): DemoStep[] {
  const steps: DemoStep[] = [];
  const emit = (delayMs: number, event: AguiEvent) => steps.push({ kind: "event", delayMs, event: { runId, ...event } });
  emit(0, { type: "RUN_STARTED" });
  if (turn.reasoning) {
    const messageId = `${runId}-reasoning`;
    emit(300, { type: "REASONING_MESSAGE_START", messageId });
    for (const delta of chunks(turn.reasoning, 4)) emit(45, { type: "REASONING_MESSAGE_CONTENT", messageId, delta });
    emit(200, { type: "REASONING_MESSAGE_END", messageId });
  }
  turn.tools?.forEach((tool, index) => {
    const toolCallId = `${runId}-tool-${index}`;
    emit(350, { type: "TOOL_CALL_START", toolCallId, toolCallName: tool.name, toolCallDisplayName: tool.displayName });
    emit(120, { type: "TOOL_CALL_ARGS", toolCallId, delta: JSON.stringify(tool.args) });
    if (tool.approval) {
      steps.push({ kind: "approval", toolCallId, request: {
        toolId: tool.name, toolName: tool.displayName, toolDescription: tool.approval.description, risk: tool.approval.risk, args: tool.args, toolCallId,
      } });
    }
    emit(500, { type: "TOOL_CALL_RESULT", toolCallId, content: tool.result, ...(tool.changes ? { changes: tool.changes } : {}) });
    emit(60, { type: "TOOL_CALL_END", toolCallId });
  });
  const messageId = `${runId}-answer`;
  emit(300, { type: "TEXT_MESSAGE_START", messageId });
  for (const delta of chunks(turn.answer)) emit(35, { type: "TEXT_MESSAGE_CONTENT", messageId, delta });
  emit(100, { type: "TEXT_MESSAGE_END", messageId });
  emit(50, { type: "CUSTOM", name: "firefly.context.usage", value: usageSnapshot(turn.contextTokens, messageCount, runId) });
  emit(50, { type: "RUN_FINISHED", result: { status: "success" } } as AguiEvent);
  return steps;
}

export function installDemoBridges(lang: DemoLang): void {
  const sessions = new Map(demoSessions(lang, Date.now()).map(session => [session.id, session]));
  const queues = new Map<string, PendingChatMessage[]>();
  const turnsTaken = new Map<string, number>();
  const changeListeners = new Set<() => void>();
  const changed = () => { for (const listener of changeListeners) listener(); };
  const found = (id: string) => sessions.get(id);
  const saved = (session: ChatSession) => { session.updatedAt = Date.now(); changed(); return clone(session); };
  const queueOf = (id: string) => { let queue = queues.get(id); if (!queue) queues.set(id, queue = []); return queue; };
  const desktopOnly = lang === "zh" ? "在线演示不支持，请在桌面版使用。" : "Not available in the online demo; use the desktop app.";

  const store: ChatStoreApi = {
    list: async (options) => [...sessions.values()].filter(session => !options?.mode || session.mode === options.mode)
      .sort((a, b) => b.updatedAt - a.updatedAt).map(meta),
    get: async (id) => { const session = found(id); return session ? clone(session) : null; },
    create: async ({ mode, title, temporary }) => {
      const now = Date.now(), id = `demo-${mode}-${now.toString(36)}`;
      const session: ChatSession = { id, mode, title: title ?? (lang === "zh" ? "新对话" : "New chat"), messages: [], identityId: null,
        schemaVersion: 1, createdAt: now, updatedAt: now, ...(temporary ? { temporary: true as const } : {}),
        ...(mode === "chat" ? {} : { workspaceBinding: { ...demoSessions(lang, now).find(s => s.mode === mode)!.workspaceBinding! } }) };
      sessions.set(id, session); changed();
      return clone(session);
    },
    append: async (id, message) => { const session = found(id); if (!session) return null; session.messages.push(message); return saved(session); },
    upsert: async (id, message) => {
      const session = found(id); if (!session) return null;
      const at = session.messages.findIndex(entry => entry.id === message.id);
      if (at < 0) session.messages.push(message); else session.messages[at] = message;
      return saved(session);
    },
    replaceTail: async (id, from, tail) => { const session = found(id); if (!session) return null; session.messages.splice(from, session.messages.length - from, ...tail); return saved(session); },
    rename: async (id, title) => { const session = found(id); if (!session) return null; session.title = title; session.titleIsCustom = true; return saved(session); },
    setPinned: async (id, pinned) => { const session = found(id); if (!session) return null; session.pinned = pinned || undefined; return saved(session); },
    setModelProfile: async (id) => { const session = found(id); return session ? clone(session) : null; },
    delete: async (id) => { const removed = sessions.delete(id); if (removed) changed(); return removed; },
    exportWorkMarkdown: async () => ({ ok: false, error: desktopOnly }),
    pickWorkspaceFolder: async () => ({ ok: false, error: desktopOnly }),
    setWorkspace: async () => ({ ok: false, error: desktopOnly }),
    openWorkspace: async () => ({ ok: false, error: desktopOnly }),
    setActiveSession: async () => null,
    pendingEnqueue: async (id, entry) => {
      if (!found(id)) return { ok: false, error: "session not found" };
      const queue = queueOf(id); queue.push({ ...entry, enqueuedAt: Date.now() });
      return { ok: true, queue: [...queue] };
    },
    pendingList: async (id) => (found(id) ? [...queueOf(id)] : null),
    pendingRemove: async (id, messageId) => {
      const queue = queueOf(id), at = queue.findIndex(entry => entry.id === messageId);
      if (at >= 0) queue.splice(at, 1);
      return { ok: true };
    },
    pendingEdit: async (id, messageId, update) => {
      const queue = queueOf(id), entry = queue.find(item => item.id === messageId);
      if (entry) Object.assign(entry, update);
      return { ok: true, queue: [...queue] };
    },
    pendingAdjust: async (id) => ({ ok: false, error: desktopOnly, queue: [...queueOf(id)] }),
    pendingClaim: async (id) => {
      const session = found(id); if (!session) return { ok: false, error: "session not found" };
      const waiting = queueOf(id).shift();
      if (!waiting) return { ok: true, claimed: false };
      const userMessage: ChatMessage = { id: waiting.id, role: "user", content: waiting.rawContent, at: Date.now(),
        ...(waiting.userSticker ? { sticker: waiting.userSticker } : {}) };
      session.messages.push(userMessage);
      return { ok: true, claimed: true, userMessage, visibleContent: waiting.visibleContent, remainingQueue: [...queueOf(id)], session: saved(session) };
    },
    pendingCompleteDispatch: async () => ({ ok: true }),
    onChanged: (listener) => { changeListeners.add(listener); return () => changeListeners.delete(listener); },
    onReactSwitchSession: () => () => {},
    notifyReactReady: () => {},
  };

  const eventListeners = new Set<(event: AguiEvent) => void>();
  const broadcast = (event: AguiEvent) => { for (const listener of eventListeners) listener(event); };
  const approvalRequests = new Set<(request: PermissionApprovalRequest) => void>();
  const approvalSettled = new Set<(settled: PermissionApprovalSettled) => void>();
  const pendingApprovals = new Map<string, (allowed: boolean) => void>();
  let active: { runId: string; sessionId: string; cancelled: boolean } | null = null;
  // Files the scripted runs changed, per session, so the Code panel's Git summary follows the demo.
  const gitChanges = new Map<string, CodeGitFileChange[]>();
  const gitListeners = new Set<(payload: CodeGitChangedPayload) => void>();
  const recordChanges = (sessionId: string, changes: ToolFileChange[]) => {
    const files = gitChanges.get(sessionId) ?? [];
    for (const change of changes) {
      if (change.kind === "renamed") continue;
      const entry: CodeGitFileChange = { path: change.file, kind: change.kind, insertions: change.insertions, deletions: change.deletions, staged: false, unstaged: true };
      const at = files.findIndex(file => file.path === change.file);
      if (at < 0) files.push(entry); else files[at] = entry;
    }
    gitChanges.set(sessionId, files);
    for (const listener of gitListeners) listener({ sessionId });
  };
  let runCount = 0;

  const wait = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));
  async function play(steps: DemoStep[], run: { runId: string; sessionId: string; cancelled: boolean }): Promise<void> {
    for (const step of steps) {
      if (run.cancelled) return;
      if (step.kind === "event") {
        await wait(step.delayMs);
        if (run.cancelled) return;
        broadcast(step.event);
        if (step.event.type === "TOOL_CALL_RESULT" && step.event.changes?.length) recordChanges(run.sessionId, step.event.changes);
        continue;
      }
      const id = `${run.runId}-approval-${step.toolCallId}`;
      const allowed = await new Promise<boolean>((resolve) => {
        pendingApprovals.set(id, resolve);
        for (const listener of approvalRequests) listener({ ...step.request, id, runId: run.runId });
      });
      pendingApprovals.delete(id);
      for (const listener of approvalSettled) listener({ id, runId: run.runId, reason: "answered" });
      if (!allowed) {
        broadcast({ type: "TOOL_CALL_RESULT", runId: run.runId, toolCallId: step.toolCallId, status: "failed",
          content: lang === "zh" ? "开拓者拒绝了这一步，没有执行。" : "The Trailblazer declined this step; it did not run." });
        const messageId = `${run.runId}-answer`;
        broadcast({ type: "TEXT_MESSAGE_START", runId: run.runId, messageId });
        broadcast({ type: "TEXT_MESSAGE_CONTENT", runId: run.runId, messageId,
          delta: lang === "zh" ? "好，这一步我不做了。需要的时候再叫我。" : "Okay, I'll leave that step. Call me when you need it." });
        broadcast({ type: "TEXT_MESSAGE_END", runId: run.runId, messageId });
        broadcast({ type: "RUN_FINISHED", runId: run.runId, result: { status: "success" } } as AguiEvent);
        return;
      }
    }
  }

  const agui: AguiApi = {
    run: async ({ sessionId }) => {
      const session = found(sessionId);
      if (!session) return { success: false, runId: "", error: "session not found" };
      if (active && !active.cancelled) return { success: false, runId: "", error: "busy" };
      const runId = `demo-run-${++runCount}`, turn = turnsTaken.get(sessionId) ?? 0;
      turnsTaken.set(sessionId, turn + 1);
      const run = { runId, sessionId, cancelled: false };
      active = run;
      const steps = scriptSteps(demoTurn(session.mode as ConversationMode, turn, lang), runId, session.messages.length + 1);
      void play(steps, run).finally(() => { if (active === run) active = null; });
      return { success: true, runId };
    },
    onEvent: (listener) => { eventListeners.add(listener); return () => eventListeners.delete(listener); },
    cancel: async () => {
      const run = active; if (!run) return { ok: true };
      run.cancelled = true; active = null;
      for (const [id, resolve] of pendingApprovals) { resolve(false); pendingApprovals.delete(id); }
      broadcast({ type: "RUN_FINISHED", runId: run.runId, result: { status: "cancelled" } } as AguiEvent);
      return { ok: true };
    },
    reportRunPersisted: () => {},
    getInterruptedRun: async () => null,
  };

  const none = () => () => {};
  const settings: SettingsApprovalApi = {
    onPermissionApprovalRequest: (listener) => { approvalRequests.add(listener); return () => approvalRequests.delete(listener); },
    onPermissionApprovalSettled: (listener) => { approvalSettled.add(listener); return () => approvalSettled.delete(listener); },
    resolvePermissionApproval: async (id, allowed) => { const resolve = pendingApprovals.get(id); resolve?.(allowed); return { ok: Boolean(resolve) }; },
    onPopQuizRequest: none, onPopQuizSettled: none,
    resolvePopQuiz: async () => ({ ok: false, error: desktopOnly }) as never,
    skipPopQuiz: async () => ({ ok: true }),
  };

  const refuse = async () => { throw new Error(desktopOnly); };
  const codeGit = {
    getStatus: async (sessionId: string): Promise<CodeGitStatus> => {
      const files = gitChanges.get(sessionId) ?? [];
      const summary = { added: 0, modified: 0, deleted: 0, renamed: 0, conflicted: 0 };
      for (const file of files) summary[file.kind]++;
      return { sessionId, state: "ready", files, summary, ahead: 0, behind: 0,
        lines: { insertions: files.reduce((sum, file) => sum + file.insertions, 0), deletions: files.reduce((sum, file) => sum + file.deletions, 0) },
        branch: { current: "main", branches: ["main"], detached: false }, executable: { version: "demo", source: "bundled" } };
    },
    watch: async () => {}, unwatch: async () => {},
    onChanged: (listener: (payload: CodeGitChangedPayload) => void) => { gitListeners.add(listener); return () => gitListeners.delete(listener); },
    commit: refuse, push: refuse, switchBranch: refuse,
  };

  const globals = window as unknown as Record<string, unknown>;
  globals.codeGit = codeGit;
  globals.chatStore = store;
  globals.agui = agui;
  globals.settings = settings;
  globals.chat = {
    getGeneralSettings: async () => ({ language: lang === "zh" ? "zh-CN" : "en" }), getEnabledStickers: async () => [],
    getImagePreview: async () => ({ ok: false }), minimize: () => {}, toggleMaximize: () => {}, isMaximized: async () => false,
    startWindowDrag: () => {}, endWindowDrag: () => {}, close: () => {},
  };
  // Settings need the desktop app; the promo page around the demo (same origin) shows a short note.
  globals.sidebar = { openSettings: () => window.parent?.postMessage({ type: "firefly-demo:desktop-only" }, window.location.origin) };
  globals.modelConfig = { get: async () => ({ displayName: lang === "zh" ? "演示模型" : "Demo model" }), onChanged: none };
  globals.choice = { resolve: async () => ({ ok: true }) };
}
