import type { ChatMessage, ChatSession, ConversationMode, PendingChatMessage } from "../../../../../shared/chat-types";
import type { ChatMessageItem } from "../components/ChatMessageList";
import type { ComposerAttachment } from "../components/ChatComposer";
import type { ChatStoreApi, PendingClaimResult, PendingMutationResult } from "./chat-page-bridge";
import type { AgentRunInput } from "./run/AgentRunController";
import { evaluateClaimRecovery } from "./session-runtime-state";
import { t } from "../../../i18n";

type QueueEntry = {
  resumeFromRunId?: string; userSticker?: string; requireDocumentRead?: boolean; attachments?: ComposerAttachment[];
  visibleContent: string; rawContent: string; id: string;
};
export type PendingQueueFlowHost = {
  reportError(message: string): void;
  startRun(input: AgentRunInput): Promise<void>;
  refreshSessions(mode: ConversationMode): void;
  prepareImageAttachments(sessionId: string, messageId: string, attachments: ComposerAttachment[]): void;
  appendMessages(sessionId: string, items: ChatMessageItem[]): void;
  replaceProjection(sessionId: string, queue: PendingChatMessage[] | null): void;
  hasRenderedMessage(sessionId: string, messageId: string): boolean;
  isSessionBusy(sessionId: string): boolean;
  getStore(): ChatStoreApi | undefined;
};
export type PendingQueueFlow = {
  handleRunFinished(input: { mode: ConversationMode; sessionId: string; queuePaused: boolean }): void;
  syncProjection(sessionId: string): Promise<void>;
  adjustMessage(sessionId: string, messageId: string): Promise<boolean>;
  editMessage(sessionId: string, messageId: string, update: { rawContent: string; visibleContent: string; userSticker?: string }): Promise<boolean>;
  consume(mode: ConversationMode, sessionId: string): Promise<void>;
  enqueue(sessionId: string, mode: ConversationMode, entry: QueueEntry, notifyError?: boolean): Promise<boolean>;
};

const FAILED_ENQUEUE_CACHE_LIMIT = 32;
function copyQueue(entries: PendingChatMessage[]): PendingChatMessage[] {
  return entries.map((entry) => ({ ...entry }));
}

export function createPendingQueueFlow(getHost: () => PendingQueueFlowHost): PendingQueueFlow {
  const retries = new Map<string, string>();
  const blocked = new Set<string>();
  const processing = new Set<string>();
  const nextPass = new Map<string, ConversationMode>();

  function rememberFailedEnqueue(key: string, id: string): void {
    retries.set(key, id);
    while (retries.size > FAILED_ENQUEUE_CACHE_LIMIT) {
      const first = retries.keys().next().value;
      if (first === undefined) break;
      retries.delete(first);
    }
  }

  async function enqueue(sessionId: string, mode: ConversationMode, entry: QueueEntry, notifyError = true): Promise<boolean> {
    const ports = getHost();
    const storage = ports.getStore();
    if (!storage) {
      if (notifyError) ports.reportError(t("chatPage.errorEnqueueFailed", { error: t("chatPage.errorChatStoreUnavailable") }));
      return false;
    }
    const incomplete = (entry.attachments ?? []).find((file) =>
      file.kind !== "image" && file.kind !== "document" || !file.filePath || !file.name);
    if (incomplete) {
      if (notifyError) ports.reportError(t("chatPage.errorAttachmentIncomplete"));
      return false;
    }
    const retryKey = mode + "::" + entry.rawContent;
    const stableId = retries.get(retryKey) ?? entry.id;
    const files = (entry.attachments ?? []).map((file) => {
      if (file.kind !== "image") return { kind: "document" as const, name: file.name, filePath: file.filePath! };
      return {
        kind: "image" as const, name: file.name, filePath: file.filePath!,
        ...(file.mime ? { mime: file.mime } : {}), ...(file.caption ? { caption: file.caption } : {}),
        ...(file.hasAnnotations === true ? { hasAnnotations: true } : {}),
      };
    });
    let reply: Awaited<ReturnType<ChatStoreApi["pendingEnqueue"]>>;
    try {
      reply = await storage.pendingEnqueue(sessionId, {
        id: stableId, rawContent: entry.rawContent, visibleContent: entry.visibleContent,
        ...(files.length > 0 ? { attachments: files } : {}),
        ...(entry.requireDocumentRead ? { requireDocumentRead: true } : {}),
        ...(entry.userSticker ? { userSticker: entry.userSticker } : {}),
        ...(entry.resumeFromRunId ? { resumeFromRunId: entry.resumeFromRunId } : {}),
      });
    } catch (failure) {
      rememberFailedEnqueue(retryKey, stableId);
      if (notifyError) ports.reportError(t("chatPage.errorEnqueueFailed", { error: failure instanceof Error ? failure.message : String(failure) }));
      return false;
    }
    if (!reply.ok) {
      rememberFailedEnqueue(retryKey, stableId);
      if (notifyError && !("canceled" in reply && reply.canceled)) ports.reportError(t("chatPage.errorEnqueueFailed", { error: reply.error }));
      return false;
    }
    retries.delete(retryKey);
    if (processing.has(sessionId)) nextPass.set(sessionId, mode);
    if (ports.isSessionBusy(sessionId)) ports.replaceProjection(sessionId, copyQueue(reply.queue));
    return true;
  }

  async function consume(mode: ConversationMode, sessionId: string): Promise<void> {
    if (processing.has(sessionId)) return;
    processing.add(sessionId);
    try { await consumeCurrent(mode, sessionId); }
    finally {
      processing.delete(sessionId);
      const queuedMode = nextPass.get(sessionId);
      if (queuedMode) {
        nextPass.delete(sessionId);
        void consume(queuedMode, sessionId);
      }
    }
  }

  async function consumeCurrent(mode: ConversationMode, sessionId: string): Promise<void> {
    const ports = getHost();
    const storage = ports.getStore();
    if (!storage) return;
    if (blocked.has(sessionId)) return;
    if (ports.isSessionBusy(sessionId)) return;
    let conversation: ChatSession | null;
    try { conversation = await storage.get(sessionId); }
    catch (failure) {
      console.warn("[pending-queue-flow] 读取会话失败，保留队首待下个触发点:", sessionId, failure);
      await syncProjection(sessionId);
      return;
    }
    if (!conversation) { ports.replaceProjection(sessionId, null); return; }
    if (conversation.pendingDispatch) { await resumePendingDispatch(mode, sessionId, conversation); return; }
    let claimed: PendingClaimResult;
    try { claimed = await storage.pendingClaim(sessionId); }
    catch (failure) {
      console.warn("[pending-queue-flow] 认领请求异常，保留队首待下个触发点:", sessionId, failure);
      await syncProjection(sessionId);
      return;
    }
    if (!claimed.ok || !claimed.claimed) { await syncProjection(sessionId); return; }
    ports.replaceProjection(sessionId, copyQueue(claimed.remainingQueue));
    await startClaimedRun(mode, sessionId, claimed);
  }

  async function resumePendingDispatch(mode: ConversationMode, sessionId: string, session: ChatSession): Promise<void> {
    const ports = getHost();
    const storage = ports.getStore();
    if (!storage) return;
    const dispatch = session.pendingDispatch;
    if (!dispatch) return;
    const recovery = evaluateClaimRecovery(session, dispatch.messageId);
    if (recovery.kind === "claim-message-missing") {
      blocked.add(sessionId);
      ports.reportError(t("chatPage.errorClaimMessageMissing"));
      return;
    }
    if (recovery.kind === "dispatched") {
      const cleared = await storage.pendingCompleteDispatch(sessionId, dispatch.messageId);
      if (!cleared.ok) return;
      await consumeCurrent(mode, sessionId);
      return;
    }
    const question = session.messages.find((entry) => entry.id === dispatch.messageId && entry.role === "user");
    if (!question) {
      blocked.add(sessionId);
      ports.reportError(t("chatPage.errorClaimMessageMissing"));
      return;
    }
    await startClaimedRun(mode, sessionId, { userMessage: question, visibleContent: question.content, session });
    await syncProjection(sessionId);
  }

  async function startClaimedRun(targetMode: ConversationMode, sessionId: string, claim: {
    userMessage: ChatMessage; visibleContent: string; resumeFromRunId?: string; session: ChatSession;
  }): Promise<void> {
    const ports = getHost();
    const replyId = crypto.randomUUID();
    const files: ComposerAttachment[] = (claim.userMessage.attachments ?? []).map((file) => ({ ...file, status: "pending" }));
    const placeholder: ChatMessageItem = {
      id: replyId, role: "assistant", content: "", loading: true, waitingForFirstEvent: true, streaming: false, responseStarted: false,
    };
    if (ports.hasRenderedMessage(sessionId, claim.userMessage.id)) ports.appendMessages(sessionId, [placeholder]);
    else ports.appendMessages(sessionId, [{
      id: claim.userMessage.id, role: "user", content: claim.visibleContent, sticker: claim.userMessage.sticker,
      attachments: files.length > 0 ? files : undefined,
    }, placeholder]);
    if (files.length > 0) ports.prepareImageAttachments(sessionId, claim.userMessage.id, files);
    ports.refreshSessions(targetMode);
    await ports.startRun({
      targetMode, sessionId, userMessageId: claim.userMessage.id, assistantId: replyId,
      session: claim.session, attachments: files,
      ...(claim.resumeFromRunId ? { resumeFromRunId: claim.resumeFromRunId } : {}),
      claimedPendingMessageId: claim.userMessage.id,
    });
  }

  async function editMessage(sessionId: string, messageId: string, update: { rawContent: string; visibleContent: string; userSticker?: string }): Promise<boolean> {
    const ports = getHost();
    const storage = ports.getStore();
    if (!storage) {
      ports.reportError(t("chatPage.errorPendingEditFailed", { error: t("chatPage.errorChatStoreUnavailable") }));
      return false;
    }
    let reply: PendingMutationResult;
    try { reply = await storage.pendingEdit(sessionId, messageId, update); }
    catch (failure) {
      ports.reportError(t("chatPage.errorPendingEditFailed", { error: failure instanceof Error ? failure.message : String(failure) }));
      return false;
    }
    if (!reply.ok) {
      if (reply.queue) ports.replaceProjection(sessionId, copyQueue(reply.queue));
      ports.reportError(t("chatPage.errorPendingEditFailed", { error: reply.error }));
      return false;
    }
    ports.replaceProjection(sessionId, copyQueue(reply.queue));
    return true;
  }

  async function adjustMessage(sessionId: string, messageId: string): Promise<boolean> {
    const ports = getHost();
    const storage = ports.getStore();
    if (!storage) {
      ports.reportError(t("chatPage.errorPendingAdjustFailed", { error: t("chatPage.errorChatStoreUnavailable") }));
      return false;
    }
    let reply: PendingMutationResult;
    try { reply = await storage.pendingAdjust(sessionId, messageId); }
    catch (failure) {
      ports.reportError(t("chatPage.errorPendingAdjustFailed", { error: failure instanceof Error ? failure.message : String(failure) }));
      return false;
    }
    if (!reply.ok) {
      if (reply.queue) ports.replaceProjection(sessionId, copyQueue(reply.queue));
      const detail = reply.error === "no-active-run" || reply.error === "no-safe-next-step"
        ? t("chatPage.errorPendingAdjustNoRun") : reply.error === "has-attachments" ? t("chatPage.errorPendingAdjustAttachments") : reply.error;
      ports.reportError(t("chatPage.errorPendingAdjustFailed", { error: detail }));
      return false;
    }
    ports.replaceProjection(sessionId, copyQueue(reply.queue));
    return true;
  }

  async function syncProjection(sessionId: string): Promise<void> {
    const ports = getHost();
    const storage = ports.getStore();
    if (!storage) return;
    let entries: PendingChatMessage[] | null;
    try { entries = await storage.pendingList(sessionId); }
    catch (failure) {
      console.warn("[pending-queue-flow] 读取待发队列失败，投影保持不变:", sessionId, failure);
      return;
    }
    ports.replaceProjection(sessionId, entries === null ? null : copyQueue(entries));
  }

  function handleRunFinished(input: { mode: ConversationMode; sessionId: string; queuePaused: boolean }): void {
    const ports = getHost();
    ports.refreshSessions(input.mode);
    void syncProjection(input.sessionId);
    if (input.queuePaused) { nextPass.delete(input.sessionId); return; }
    if (processing.has(input.sessionId)) nextPass.set(input.sessionId, input.mode);
    else void consume(input.mode, input.sessionId);
  }

  return { enqueue, consume, editMessage, adjustMessage, syncProjection, handleRunFinished };
}
