import type { ChatMessage, ChatSession, PendingChatMessage } from "../../shared/chat-types";
import type { AguiApi, AguiEvent, ChatStoreApi } from "../react/features/chat/pages/chat-page-bridge";
import { buildPerfSession, buildStreamingScript, perfSessionMeta, runFinishedEvent, type PerfDataset, type StreamingScript } from "./fixture";
export interface FakeBridgeOptions { durationMs: number; seed: number; count: number; dataset: PerfDataset; }
export interface FakeBridgeRuntime {
  getRunCalls: () => number;
  isScriptFinished: () => boolean;
  onEmit: (callback: (event: AguiEvent, atMs: number) => void) => void;
  script: StreamingScript;
  session: ChatSession;
}
function cloneSession(value: ChatSession): ChatSession {
  return { ...value, messages: value.messages.map((entry) => ({ ...entry })) };
}
export function installFakeBridges(options: FakeBridgeOptions): FakeBridgeRuntime {
  const history = buildPerfSession({ dataset: options.dataset, count: options.count, seed: options.seed });
  const replay = buildStreamingScript({ dataset: options.dataset, seed: options.seed, durationMs: options.durationMs });
  let observer: ((event: AguiEvent, atMs: number) => void) | null = null;
  let finished = false;
  let invocations = 0;
  const subscribers = new Set<(event: AguiEvent) => void>();
  function broadcast(event: AguiEvent): void {
    observer?.(event, performance.now());
    for (const receive of subscribers) receive(event);
  }
  let timeout: number | undefined;
  function stopReplay(): void {
    if (timeout !== undefined) window.clearTimeout(timeout);
    timeout = undefined;
  }
  const events: AguiApi = {
    run: async () => {
      invocations += 1;
      finished = false;
      const epoch = performance.now();
      let position = 0;
      function advance(): void {
        if (position >= replay.events.length) { finished = true; return; }
        const scheduled = replay.events[position]!;
        const remaining = Math.max(0, scheduled.atMs - (performance.now() - epoch));
        timeout = window.setTimeout(() => {
          position += 1;
          broadcast(scheduled.event);
          advance();
        }, remaining);
      }
      advance();
      return { success: true, runId: "perf-run-1" };
    },
    onEvent: (receive) => {
      subscribers.add(receive);
      return () => subscribers.delete(receive);
    },
    cancel: async () => {
      stopReplay();
      finished = true;
      broadcast(runFinishedEvent("perf-run-1", "cancelled"));
    },
    reportRunPersisted: () => {},
    getInterruptedRun: async () => null,
  };
  const queue: PendingChatMessage[] = [];
  const storage: ChatStoreApi = {
    list: async () => [perfSessionMeta(history)],
    get: async (sessionId) => sessionId === history.id ? cloneSession(history) : null,
    exportWorkMarkdown: async () => ({ ok: false, canceled: true }),
    create: async () => cloneSession(history),
    append: async (sessionId, incoming) => {
      if (sessionId !== history.id) return null;
      history.messages.push(incoming);
      return cloneSession(history);
    },
    upsert: async (sessionId, incoming) => {
      if (sessionId !== history.id) return null;
      const slot = history.messages.findIndex((saved) => saved.id === incoming.id);
      if (slot === -1) history.messages.push(incoming);
      else history.messages[slot] = incoming;
      return cloneSession(history);
    },
    replaceTail: async (sessionId, from, tail) => {
      if (sessionId !== history.id) return null;
      history.messages.splice(from, history.messages.length - from, ...tail);
      return cloneSession(history);
    },
    rename: async () => cloneSession(history),
    delete: async () => true,
    pendingEnqueue: async (sessionId, incoming) => {
      if (sessionId !== history.id) return { ok: false, error: "session not found" };
      queue.push({ ...incoming, enqueuedAt: Date.now() });
      return { ok: true, queue: [...queue] };
    },
    pendingList: async (sessionId) => sessionId === history.id ? [...queue] : null,
    pendingRemove: async (sessionId, messageId) => {
      if (sessionId !== history.id) return { ok: false, error: "session not found" };
      const slot = queue.findIndex((saved) => saved.id === messageId);
      if (slot !== -1) queue.splice(slot, 1);
      return { ok: true };
    },
    pendingClaim: async (sessionId) => {
      if (sessionId !== history.id) return { ok: false, error: "session not found" };
      const waiting = queue.shift();
      if (!waiting) return { ok: true, claimed: false };
      const claimedMessage: ChatMessage = {
        id: waiting.id,
        role: "user",
        content: waiting.rawContent,
        at: Date.now(),
        ...(waiting.userSticker ? { sticker: waiting.userSticker } : {}),
      };
      history.messages.push(claimedMessage);
      return {
        ok: true,
        claimed: true,
        userMessage: claimedMessage,
        visibleContent: waiting.visibleContent,
        remainingQueue: [...queue],
        session: cloneSession(history),
      };
    },
    pendingCompleteDispatch: async () => ({ ok: true }),
    pendingEdit: async (sessionId, messageId, changes) => {
      if (sessionId !== history.id) return { ok: false, error: "session not found", queue: [...queue] };
      const waiting = queue.find((saved) => saved.id === messageId);
      if (waiting) {
        waiting.rawContent = changes.rawContent;
        waiting.visibleContent = changes.visibleContent;
        waiting.userSticker = changes.userSticker;
      }
      return { ok: true, queue: [...queue] };
    },
    pendingAdjust: async () => ({ ok: false, error: "perf harness 不支持调整", queue: [...queue] }),
    setPinned: async () => cloneSession(history),
    setModelProfile: async () => cloneSession(history),
    pickWorkspaceFolder: async () => ({ ok: false }),
    setWorkspace: async () => ({ ok: true }),
    openWorkspace: async () => ({ ok: true }),
    setActiveSession: async () => null,
    onChanged: () => () => {},
    onReactSwitchSession: () => () => {},
    notifyReactReady: () => {},
  };
  const emptySubscription = () => () => {};
  const chatBridge = {
    getGeneralSettings: async () => ({}), getEnabledStickers: async () => [],
    getImagePreview: async () => ({ ok: false }), minimize: () => {}, toggleMaximize: () => {},
    isMaximized: async () => false, startWindowDrag: () => {}, endWindowDrag: () => {}, close: () => {},
  };
  const settingsBridge = {
    onPermissionApprovalRequest: emptySubscription, onPermissionApprovalSettled: emptySubscription,
    onPopQuizRequest: emptySubscription, onPopQuizSettled: emptySubscription,
    resolvePermissionApproval: async () => ({ ok: true }),
    resolvePopQuiz: async () => ({ ok: true, correct: true, explanation: "" }),
    skipPopQuiz: async () => ({ ok: true }),
  };
  const sidebarBridge = { openSettings: () => {} };
  const modelBridge = { get: async () => ({}), onChanged: emptySubscription };
  const choiceBridge = { resolve: async () => ({ ok: true }) };
  const globals = window as unknown as Record<string, unknown>;
  globals.chatStore = storage;
  globals.agui = events;
  globals.chat = chatBridge;
  globals.settings = settingsBridge;
  globals.sidebar = sidebarBridge;
  globals.modelConfig = modelBridge;
  globals.choice = choiceBridge;
  return {
    session: history,
    script: replay,
    onEmit: (receive) => { observer = receive; },
    isScriptFinished: () => finished,
    getRunCalls: () => invocations,
  };
}
