import * as path from "path";
import * as fs from "fs";
import { randomUUID } from "crypto";
import { app, shell } from "electron";
import { LogTag, logger } from "../logging/logger";
import { ephemeralConversations } from "./ephemeral-conversations";
import { fireflyDataDirectory } from "../storage/firefly-data-paths";
import {
  CHAT_SCHEMA_VERSION, type ChatSession, type ChatSessionMeta, type ChatSessionPurpose,
  type ChatMessage, type ConversationMode, type ConversationWorkspaceBinding,
  type PendingChatAttachment, type PendingChatMessage,
} from "../../shared/chat-types";
import type { ContextUsageSnapshot } from "../../shared/context-usage";

let ready = false;
let unreadable = false;
let directory = "";
let sessionsDirectory = "";
let indexFilename = "";
let catalog: ChatSessionMeta[] = [];
const volatile = new Map<string, ChatSession>();

const validMode = (candidate: unknown): candidate is ConversationMode =>
  candidate === "chat" || candidate === "work" || candidate === "code";
const newest = (left: ChatSessionMeta, right: ChatSessionMeta): number => right.updatedAt - left.updatedAt;
const filenameFor = (id: string): string => path.join(sessionsDirectory, `${id}.json`);

function requireReadable(): void {
  if (unreadable) throw new Error("CHAT_HISTORY_READ_FAILED: 聊天历史读取失败，原文件已保留");
}

function prepareFolders(): void {
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(sessionsDirectory)) fs.mkdirSync(sessionsDirectory, { recursive: true });
}

function writeJson(filename: string, contents: unknown): void {
  requireReadable();
  const stagingFilename = `${filename}.tmp`;
  fs.writeFileSync(stagingFilename, JSON.stringify(contents, null, 2), "utf8");
  fs.renameSync(stagingFilename, filename);
}

function present(filename: string): boolean {
  try {
    fs.statSync(filename);
    return true;
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw failure;
  }
}

function loadCatalog(): ChatSessionMeta[] {
  try {
    if (!present(indexFilename)) return [];
    const decoded: unknown = JSON.parse(fs.readFileSync(indexFilename, "utf8"));
    if (!Array.isArray(decoded)) throw new Error("Invalid history index");
    const loaded: ChatSessionMeta[] = [];
    for (const row of decoded) {
      if (!row || typeof row !== "object") throw new Error("Invalid history entry");
      const fields = row as Partial<ChatSessionMeta>;
      if (!(typeof fields.id === "string" && typeof fields.title === "string"
        && typeof fields.createdAt === "number" && typeof fields.updatedAt === "number"
        && typeof fields.messageCount === "number" && validMode(fields.mode)
        && (fields.purpose === undefined || fields.purpose === "proactive-chat"))) {
        throw new Error("Invalid history entry");
      }
      if (!validMode(fields.mode)) throw new Error("Invalid history mode");
      loaded.push({
        id: fields.id!, title: fields.title!, identityId: fields.identityId ?? null,
        createdAt: fields.createdAt!, updatedAt: fields.updatedAt!, messageCount: fields.messageCount!,
        purpose: fields.purpose, mode: fields.mode, workspaceRoot: fields.workspaceRoot,
        workspaceDisplayName: fields.workspaceDisplayName, pinned: fields.pinned,
      });
    }
    return loaded;
  } catch {
    unreadable = true;
    logger.warn(LogTag.Runtime, "chat history index read failed; writes blocked");
    return [];
  }
}

function read(id: string): ChatSession | null {
  const memoryCopy = volatile.get(id);
  if (memoryCopy) return structuredClone(memoryCopy);
  const filename = filenameFor(id);
  try {
    if (!present(filename)) return null;
    const decoded = JSON.parse(fs.readFileSync(filename, "utf8")) as ChatSession;
    if (!decoded || typeof decoded !== "object" || !Array.isArray(decoded.messages)) {
      throw new Error("Invalid session data");
    }
    if (!validMode(decoded.mode)) throw new Error("Invalid session mode");
    return decoded;
  } catch {
    logger.warn(LogTag.Runtime, "chat session read failed; original file preserved");
    throw new Error("CHAT_SESSION_READ_FAILED: 会话读取失败，原文件已保留");
  }
}

function write(conversation: ChatSession): void {
  if (volatile.has(conversation.id)) volatile.set(conversation.id, structuredClone(conversation));
  else writeJson(filenameFor(conversation.id), conversation);
}

function saveCatalog(): void {
  catalog.sort(newest);
  writeJson(indexFilename, catalog);
}

function updateCatalog(conversation: ChatSession): void {
  const summary: ChatSessionMeta = {
    id: conversation.id, title: conversation.title, identityId: conversation.identityId,
    createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length, purpose: conversation.purpose, mode: conversation.mode,
    workspaceRoot: conversation.workspaceBinding?.workspaceRoot,
    workspaceDisplayName: conversation.workspaceBinding?.displayName, pinned: conversation.pinned,
  };
  if (volatile.has(summary.id)) return;
  const offset = catalog.findIndex((row) => row.id === summary.id);
  if (offset === -1) catalog.push(summary);
  else catalog[offset] = summary;
  saveCatalog();
}

function save(conversation: ChatSession): void {
  write(conversation);
  updateCatalog(conversation);
}

function titleFor(history: ChatMessage[]): string {
  const initial = history.find((row) => row.role === "user" && row.content.trim());
  if (!initial) return "新对话";
  const flattened = initial.content.replace(/\s+/g, " ").trim();
  return flattened.length > 30 ? flattened.slice(0, 30) + "…" : flattened;
}

function retitle(conversation: ChatSession): void {
  if (!conversation.titleIsCustom) conversation.title = titleFor(conversation.messages);
}

function change(id: string, apply: (conversation: ChatSession) => void): ChatSession | null {
  const conversation = read(id);
  if (!conversation) return null;
  apply(conversation);
  save(conversation);
  return conversation;
}

export function initialize(): void {
  if (ready) return;
  directory = fireflyDataDirectory(app.getPath("userData"), "chats");
  sessionsDirectory = path.join(directory, "sessions");
  indexFilename = path.join(directory, "index.json");
  try {
    prepareFolders();
    catalog = loadCatalog();
  } catch {
    unreadable = true;
    logger.warn(LogTag.Runtime, "chat history initialization failed; writes blocked");
  }
  logger.warn(LogTag.Runtime, "startup chats index", {
    indexPresent: fs.existsSync(indexFilename), readFailed: unreadable, sessionCount: catalog.length,
    chatCount: catalog.filter((row) => row.mode === "chat").length,
    workCount: catalog.filter((row) => row.mode === "work").length,
  });
  ready = true;
}

export type CachedCoverageSessions =
  | { ids: null; state: "not-ready" | "read-failed" | "budget-exhausted" }
  | { ids: readonly string[]; rootDir: string; state: "ready" };

export function getCachedSessionIdsForCoverage(): CachedCoverageSessions {
  if (!ready) return { state: "not-ready", ids: null };
  if (unreadable) return { state: "read-failed", ids: null };
  if (catalog.length > 10_000) return { state: "budget-exhausted", ids: null };
  const ids = Object.freeze(catalog.map((row) => row.id));
  return { state: "ready", rootDir: directory, ids };
}

export function getRootDir(): string { return directory; }
export function getSession(id: string): ChatSession | null { return read(id); }
/** A session's mode and whether it is temporary, from the index or memory; never reads the session file. */
export function getSessionKind(id: string): { mode: ConversationMode; temporary: boolean } | null {
  const memoryCopy = volatile.get(id);
  if (memoryCopy) return { mode: memoryCopy.mode, temporary: memoryCopy.temporary === true };
  const row = catalog.find((entry) => entry.id === id);
  return row ? { mode: row.mode, temporary: false } : null;
}

export function listSessions(options?: { mode?: ConversationMode }): ChatSessionMeta[] {
  if (options?.mode !== undefined && !validMode(options.mode)) throw new Error("INVALID_CONVERSATION_MODE");
  requireReadable();
  const selected = options?.mode ? catalog.filter((row) => row.mode === options.mode) : catalog;
  const ordered = [...selected].sort((left, right) => {
    if (left.pinned && !right.pinned) return -1;
    if (!left.pinned && right.pinned) return 1;
    return newest(left, right);
  });
  return ordered.map((row) => ({ ...row }));
}

export function getSessionPage(id: string, before: number | null, limit: number): {
  session: Omit<ChatSession, "messages"> & { messageCount: number }; messages: ChatMessage[]; hasMore: boolean;
} | null {
  const conversation = read(id);
  if (!conversation) return null;
  const until = Math.max(0, Math.min(before ?? conversation.messages.length, conversation.messages.length));
  const count = Math.max(1, Math.min(Math.floor(limit) || 1, 200));
  const from = Math.max(0, until - count);
  const { messages: ignored, ...summary } = conversation;
  return {
    session: { ...summary, messageCount: conversation.messages.length },
    messages: conversation.messages.slice(from, until), hasMore: from > 0,
  };
}

export function createSession(opts?: {
  title?: string; identityId?: string | null; initialMessages?: ChatMessage[];
  purpose?: ChatSessionPurpose; mode?: ConversationMode; modelProfileId?: string; temporary?: boolean;
}): ChatSession {
  const timestamp = Date.now();
  const history = opts?.initialMessages ?? [];
  const selectedMode = opts?.mode ?? (opts?.purpose === "proactive-chat" ? "chat" : "work");
  if (!validMode(selectedMode)) throw new Error("INVALID_CONVERSATION_MODE");
  if (opts?.temporary && (selectedMode !== "chat" || opts.purpose !== undefined || opts.mode === undefined)) {
    throw new Error("TEMPORARY_CHAT_REQUIRES_CHAT_MODE");
  }
  const created: ChatSession = {
    id: randomUUID(), title: opts?.title?.trim() || (history.length > 0 ? titleFor(history) : "新对话"),
    identityId: opts?.identityId ?? null, messages: history, createdAt: timestamp, updatedAt: timestamp,
    schemaVersion: CHAT_SCHEMA_VERSION, purpose: opts?.purpose, titleIsCustom: opts?.purpose ? true : undefined,
    mode: selectedMode, modelProfileId: opts?.modelProfileId,
    ...(opts?.temporary ? { temporary: true as const } : {}),
  };
  if (opts?.temporary) {
    ephemeralConversations.mark(created.id);
    volatile.set(created.id, structuredClone(created));
    return created;
  }
  save(created);
  return created;
}

export function getSessionByPurpose(purpose: ChatSessionPurpose): ChatSession | null {
  const match = catalog.find((row) => row.purpose === purpose);
  return match ? read(match.id) : null;
}

export function getOrCreateSessionByPurpose(purpose: ChatSessionPurpose, opts?: { title?: string; identityId?: string | null }): ChatSession {
  const found = getSessionByPurpose(purpose);
  if (found) return found;
  return createSession({ title: opts?.title, identityId: opts?.identityId ?? null, purpose });
}

export function appendMessage(id: string, message: ChatMessage): ChatSession | null {
  return change(id, (conversation) => {
    conversation.messages.push(message);
    conversation.updatedAt = Date.now();
    retitle(conversation);
  });
}

export function upsertMessage(id: string, message: ChatMessage): ChatSession | null {
  return change(id, (conversation) => {
    const offset = conversation.messages.findIndex((row) => row.id === message.id);
    if (offset >= 0) conversation.messages[offset] = message;
    else conversation.messages.push(message);
    conversation.updatedAt = Date.now();
    retitle(conversation);
  });
}

export function replaceMessages(id: string, messages: ChatMessage[]): ChatSession | null {
  return change(id, (conversation) => {
    conversation.messages = messages;
    conversation.updatedAt = Date.now();
    retitle(conversation);
  });
}

export function replaceMessagesTail(id: string, startIndex: number, messages: ChatMessage[]): ChatSession | null {
  const conversation = read(id);
  if (!conversation || !Number.isInteger(startIndex) || startIndex < 0 || startIndex > conversation.messages.length) return null;
  conversation.messages = conversation.messages.slice(0, startIndex).concat(messages);
  conversation.updatedAt = Date.now();
  retitle(conversation);
  save(conversation);
  return conversation;
}

export function renameSession(id: string, title: string): ChatSession | null {
  const conversation = read(id);
  if (!conversation) return null;
  const requested = title.trim();
  if (!requested) return conversation;
  conversation.title = requested.slice(0, 80);
  conversation.titleIsCustom = true;
  conversation.updatedAt = Date.now();
  save(conversation);
  return conversation;
}

export function setGeneratedTitle(id: string, firstUserMessageId: string, title: string): boolean {
  const conversation = read(id);
  if (!conversation || conversation.titleIsCustom) return false;
  const initial = conversation.messages.find((row) => row.role === "user" && row.content.trim());
  if (initial?.id !== firstUserMessageId) return false;
  const requested = title.trim();
  if (!requested) return false;
  conversation.title = requested.slice(0, 80);
  save(conversation);
  return true;
}

export function setSessionPinned(id: string, pinned: boolean): ChatSession | null {
  return change(id, (conversation) => { conversation.pinned = Boolean(pinned); });
}
export function setSessionModelProfile(id: string, modelProfileId: string | undefined): ChatSession | null {
  return change(id, (conversation) => {
    conversation.modelProfileId = modelProfileId;
    conversation.updatedAt = Date.now();
  });
}
export function setSessionContextUsage(id: string, snapshot: ContextUsageSnapshot): ChatSession | null {
  return change(id, (conversation) => { conversation.currentContextUsage = snapshot; });
}

export function deleteSession(id: string): boolean {
  if (volatile.has(id)) {
    volatile.delete(id);
    return true;
  }
  requireReadable();
  const filename = filenameFor(id);
  let deleted = false;
  if (fs.existsSync(filename)) {
    try {
      fs.unlinkSync(filename);
      deleted = true;
    } catch (failure) { console.warn("[chats-store] 删除 session 文件失败:", id, failure); }
  }
  const indexed = catalog.some((row) => row.id === id);
  if (indexed) {
    catalog = catalog.filter((row) => row.id !== id);
    saveCatalog();
  }
  return deleted || indexed;
}

export function getLatestSessionId(): string | null {
  if (catalog.length === 0) return null;
  return [...catalog].sort(newest)[0].id;
}
export async function openStorageFolder(): Promise<void> {
  prepareFolders();
  await shell.openPath(directory);
}
export function setWorkspaceBinding(sessionId: string, binding: ConversationWorkspaceBinding): ChatSession | null {
  return change(sessionId, (conversation) => {
    conversation.workspaceBinding = binding;
    conversation.updatedAt = Date.now();
  });
}
export function getWorkspaceBinding(sessionId: string): ConversationWorkspaceBinding | undefined {
  return read(sessionId)?.workspaceBinding;
}
export function clearWorkspaceBinding(sessionId: string): ChatSession | null {
  return change(sessionId, (conversation) => {
    conversation.workspaceBinding = undefined;
    conversation.updatedAt = Date.now();
  });
}

export type PendingChatMessageInput = Omit<PendingChatMessage, "enqueuedAt">;
export type EnqueuePendingResult =
  | { enqueued: boolean; queue: PendingChatMessage[]; ok: true }
  | { error: "session-not-found" | "empty-content" | "duplicate-id" | "invalid-attachments" | "write-failed"; ok: false };
export type RemovePendingResult =
  | { removed: boolean; ok: true }
  | { queue?: PendingChatMessage[]; error: "session-not-found" | "already-adjusting" | "write-failed"; ok: false };
export type ClaimPendingResult =
  | { session: ChatSession; remainingQueue: PendingChatMessage[]; resumeFromRunId?: string; visibleContent: string; userMessage: ChatMessage; claimed: true; ok: true }
  | { claimed: false; ok: true }
  | { error: "session-not-found" | "already-dispatching" | "write-failed"; ok: false };
export type CompleteDispatchResult =
  | { cleared: boolean; ok: true } | { error: "session-not-found" | "write-failed"; ok: false };
export type EditPendingResult =
  | { queue: PendingChatMessage[]; ok: true }
  | { queue?: PendingChatMessage[]; error: "session-not-found" | "not-found" | "already-claimed" | "already-adjusting" | "empty-content" | "write-failed"; ok: false };
export type MarkPendingAdjustResult =
  | { queue: PendingChatMessage[]; ok: true }
  | { queue?: PendingChatMessage[]; error: "session-not-found" | "not-found" | "already-claimed" | "already-adjusting" | "has-attachments" | "write-failed"; ok: false };
export type CommitPendingAdjustResult =
  | { remainingQueue: PendingChatMessage[]; userMessage: ChatMessage; ok: true }
  | { error: "session-not-found" | "not-found" | "run-mismatch" | "write-failed"; ok: false };
export type ResetPendingAdjustResult =
  | { reset: number; ok: true } | { error: "session-not-found" | "write-failed"; ok: false };

function persistPending(conversation: ChatSession, warning: string, id: string): boolean {
  try { write(conversation); return true; }
  catch (failure) { console.warn(warning, id, failure); return false; }
}

function indexPending(conversation: ChatSession, warning: string, id: string): void {
  try { updateCatalog(conversation); }
  catch (failure) { console.warn(warning, id, failure); }
}

const copyQueue = (pending: PendingChatMessage[]): PendingChatMessage[] => pending.map((row) => ({ ...row }));

function attachmentInput(candidate: unknown): PendingChatAttachment | null {
  if (!candidate || typeof candidate !== "object") return null;
  const fields = candidate as Partial<PendingChatAttachment>;
  const category = fields.kind === "image" || fields.kind === "document" ? fields.kind : null;
  if (!category || typeof fields.name !== "string" || !fields.name.trim()) return null;
  if (typeof fields.filePath !== "string" || !fields.filePath.trim()) return null;
  return {
    kind: category, name: fields.name.trim(), filePath: fields.filePath.trim(),
    ...(typeof fields.mime === "string" && fields.mime.trim() ? { mime: fields.mime.trim() } : {}),
    ...(typeof fields.caption === "string" && fields.caption.trim() ? { caption: fields.caption.trim() } : {}),
    ...(fields.hasAnnotations === true ? { hasAnnotations: true } : {}),
    ...(fields.kind === "document" && fields.readScope ? { readScope: fields.readScope } : {}),
  };
}

function pendingInput(id: string, input: PendingChatMessageInput): PendingChatMessage | "empty" | "invalid-attachments" {
  if (typeof id !== "string" || !id.trim()) return "empty";
  if (typeof input?.rawContent !== "string" || !input.rawContent.trim()) return "empty";
  const visible = typeof input.visibleContent === "string" ? input.visibleContent : input.rawContent;
  let files: PendingChatAttachment[] | undefined;
  if (input.attachments !== undefined) {
    if (!Array.isArray(input.attachments)) return "invalid-attachments";
    const accepted: PendingChatAttachment[] = [];
    for (const candidate of input.attachments) {
      const parsed = attachmentInput(candidate);
      if (!parsed) return "invalid-attachments";
      accepted.push(parsed);
    }
    if (accepted.length > 0) files = accepted;
  }
  return {
    id: id.trim(), rawContent: input.rawContent, visibleContent: visible,
    ...(files ? { attachments: files } : {}),
    ...(typeof input.userSticker === "string" && input.userSticker.trim() ? { userSticker: input.userSticker.trim() } : {}),
    ...(typeof input.resumeFromRunId === "string" && input.resumeFromRunId.trim() ? { resumeFromRunId: input.resumeFromRunId.trim() } : {}),
    ...(input.requireDocumentRead === true ? { requireDocumentRead: true } : {}),
    enqueuedAt: Date.now(),
  };
}

function samePending(left: PendingChatMessage, right: PendingChatMessage): boolean {
  if (left.rawContent !== right.rawContent || left.visibleContent !== right.visibleContent) return false;
  if ((left.userSticker ?? "") !== (right.userSticker ?? "")) return false;
  if ((left.resumeFromRunId ?? "") !== (right.resumeFromRunId ?? "")) return false;
  if ((left.requireDocumentRead ?? false) !== (right.requireDocumentRead ?? false)) return false;
  const leftFiles = left.attachments ?? [];
  const rightFiles = right.attachments ?? [];
  if (leftFiles.length !== rightFiles.length) return false;
  return leftFiles.every((file, position) => {
    const peer = rightFiles[position];
    return file.kind === peer.kind && file.name === peer.name && file.filePath === peer.filePath
      && (file.mime ?? "") === (peer.mime ?? "") && (file.caption ?? "") === (peer.caption ?? "")
      && (file.hasAnnotations ?? false) === (peer.hasAnnotations ?? false)
      && (file.readScope?.sha256 ?? "") === (peer.readScope?.sha256 ?? "")
      && (file.readScope?.endLine ?? 0) === (peer.readScope?.endLine ?? 0);
  });
}

export function enqueuePendingMessage(sessionId: string, entry: PendingChatMessageInput): EnqueuePendingResult {
  const conversation = read(sessionId);
  if (!conversation) return { ok: false, error: "session-not-found" };
  const prepared = pendingInput(entry?.id ?? "", entry);
  if (prepared === "empty") return { ok: false, error: "empty-content" };
  if (prepared === "invalid-attachments") return { ok: false, error: "invalid-attachments" };
  const pending = conversation.pendingMessages ?? [];
  const previous = pending.find((row) => row.id === prepared.id);
  if (previous) {
    if (samePending(previous, prepared)) return { ok: true, queue: copyQueue(pending), enqueued: false };
    return { ok: false, error: "duplicate-id" };
  }
  const appended = [...pending, prepared];
  conversation.pendingMessages = appended;
  if (!persistPending(conversation, "[chats-store] 待发消息落盘失败:", sessionId)) return { ok: false, error: "write-failed" };
  return { ok: true, queue: appended, enqueued: true };
}

export function getPendingMessages(sessionId: string): PendingChatMessage[] | null {
  const conversation = read(sessionId);
  return conversation ? copyQueue(conversation.pendingMessages ?? []) : null;
}

export function removePendingMessage(sessionId: string, messageId: string): RemovePendingResult {
  const conversation = read(sessionId);
  if (!conversation) return { ok: false, error: "session-not-found" };
  const pending = conversation.pendingMessages ?? [];
  const match = pending.find((row) => row.id === messageId);
  if (!match) return { ok: true, removed: false };
  if (match.adjustRunId) return { ok: false, error: "already-adjusting", queue: copyQueue(pending) };
  conversation.pendingMessages = pending.filter((row) => row.id !== messageId);
  if (!persistPending(conversation, "[chats-store] 待发消息删除落盘失败:", sessionId)) return { ok: false, error: "write-failed" };
  return { ok: true, removed: true };
}

// 两种转正入口对文档范围的处理不同，按各自的历史行为保留。
function historyMessage(pending: PendingChatMessage, timestamp: number, includeReadScope: boolean): ChatMessage {
  return {
    id: pending.id, role: "user", content: pending.rawContent, at: timestamp,
    ...(pending.userSticker ? { sticker: pending.userSticker } : {}),
    ...(pending.attachments && pending.attachments.length > 0 ? {
      attachments: pending.attachments.map((file) => {
        if (file.kind === "image") {
          return {
            kind: "image" as const, name: file.name, filePath: file.filePath,
            mime: file.mime ?? "application/octet-stream", caption: file.caption, status: "pending" as const,
            ...(file.hasAnnotations === true ? { hasAnnotations: true } : {}),
          };
        }
        return {
          kind: "document" as const, name: file.name, filePath: file.filePath, status: "pending" as const,
          ...(includeReadScope && file.readScope ? { readScope: file.readScope } : {}),
        };
      }),
    } : {}),
  };
}

export function claimPendingMessage(sessionId: string): ClaimPendingResult {
  const conversation = read(sessionId);
  if (!conversation) return { ok: false, error: "session-not-found" };
  if (conversation.pendingDispatch) return { ok: false, error: "already-dispatching" };
  const pending = conversation.pendingMessages ?? [];
  if (pending.length === 0) return { ok: true, claimed: false };
  const first = pending[0];
  const timestamp = Date.now();
  const promoted = historyMessage(first, timestamp, true);
  const rest = pending.slice(1);
  conversation.messages = [...conversation.messages, promoted];
  conversation.pendingMessages = rest;
  conversation.pendingDispatch = { messageId: first.id, claimedAt: timestamp };
  conversation.updatedAt = timestamp;
  retitle(conversation);
  if (!persistPending(conversation, "[chats-store] 待发消息认领落盘失败:", sessionId)) return { ok: false, error: "write-failed" };
  indexPending(conversation, "[chats-store] 待发消息认领后索引写入失败（会话列表计数可能滞后）:", sessionId);
  return {
    ok: true, claimed: true, userMessage: promoted, visibleContent: first.visibleContent,
    ...(first.resumeFromRunId ? { resumeFromRunId: first.resumeFromRunId } : {}),
    remainingQueue: copyQueue(rest), session: conversation,
  };
}

export function completePendingDispatch(sessionId: string, messageId: string): CompleteDispatchResult {
  const conversation = read(sessionId);
  if (!conversation) return { ok: false, error: "session-not-found" };
  if (conversation.pendingDispatch?.messageId !== messageId) return { ok: true, cleared: false };
  delete conversation.pendingDispatch;
  if (!persistPending(conversation, "[chats-store] 待发派发确认落盘失败:", sessionId)) return { ok: false, error: "write-failed" };
  return { ok: true, cleared: true };
}

export function editPendingMessage(
  sessionId: string, messageId: string, update: { rawContent: string; visibleContent: string; userSticker?: string },
): EditPendingResult {
  const conversation = read(sessionId);
  if (!conversation) return { ok: false, error: "session-not-found" };
  const pending = conversation.pendingMessages ?? [];
  const original = copyQueue(pending);
  if (conversation.pendingDispatch?.messageId === messageId) return { ok: false, error: "already-claimed", queue: original };
  const offset = pending.findIndex((row) => row.id === messageId);
  if (offset === -1) return { ok: false, error: "not-found", queue: original };
  const matched = pending[offset];
  if (matched.adjustRunId) return { ok: false, error: "already-adjusting", queue: original };
  if (typeof update?.rawContent !== "string" || !update.rawContent.trim()) return { ok: false, error: "empty-content", queue: original };
  const replacement: PendingChatMessage = {
    ...matched, rawContent: update.rawContent,
    visibleContent: typeof update.visibleContent === "string" && update.visibleContent ? update.visibleContent : update.rawContent,
  };
  if (typeof update.userSticker === "string" && update.userSticker.trim()) replacement.userSticker = update.userSticker.trim();
  else delete replacement.userSticker;
  pending[offset] = replacement;
  if (!persistPending(conversation, "[chats-store] 待发消息编辑落盘失败:", sessionId)) {
    return { ok: false, error: "write-failed", queue: original };
  }
  return { ok: true, queue: copyQueue(pending) };
}

export function markPendingAdjust(sessionId: string, messageId: string, runId: string): MarkPendingAdjustResult {
  const conversation = read(sessionId);
  if (!conversation) return { ok: false, error: "session-not-found" };
  const pending = conversation.pendingMessages ?? [];
  if (conversation.pendingDispatch?.messageId === messageId) return { ok: false, error: "already-claimed", queue: copyQueue(pending) };
  const offset = pending.findIndex((row) => row.id === messageId);
  if (offset === -1) return { ok: false, error: "not-found", queue: copyQueue(pending) };
  const matched = pending[offset];
  if (matched.adjustRunId === runId) return { ok: true, queue: copyQueue(pending) };
  if (matched.adjustRunId) return { ok: false, error: "already-adjusting", queue: copyQueue(pending) };
  if (matched.attachments && matched.attachments.length > 0) return { ok: false, error: "has-attachments", queue: copyQueue(pending) };
  pending[offset] = { ...matched, adjustRunId: runId };
  if (!persistPending(conversation, "[chats-store] 待发消息调整标记落盘失败:", sessionId)) {
    return { ok: false, error: "write-failed", queue: copyQueue(pending) };
  }
  return { ok: true, queue: copyQueue(pending) };
}

export function commitPendingAdjust(sessionId: string, messageId: string, runId: string): CommitPendingAdjustResult {
  const conversation = read(sessionId);
  if (!conversation) return { ok: false, error: "session-not-found" };
  const pending = conversation.pendingMessages ?? [];
  const offset = pending.findIndex((row) => row.id === messageId);
  if (offset === -1) return { ok: false, error: "not-found" };
  const matched = pending[offset];
  if (matched.adjustRunId !== runId) return { ok: false, error: "run-mismatch" };
  const timestamp = Date.now();
  const promoted = historyMessage(matched, timestamp, false);
  conversation.messages = [...conversation.messages, promoted];
  conversation.pendingMessages = pending.filter((row) => row.id !== messageId);
  conversation.updatedAt = timestamp;
  if (!persistPending(conversation, "[chats-store] 待发消息调整提交落盘失败:", sessionId)) return { ok: false, error: "write-failed" };
  indexPending(conversation, "[chats-store] 待发消息调整提交后索引写入失败（会话列表计数可能滞后）:", sessionId);
  return { ok: true, userMessage: promoted, remainingQueue: copyQueue(conversation.pendingMessages) };
}

export function resetPendingAdjustByRun(sessionId: string, runId: string): ResetPendingAdjustResult {
  const conversation = read(sessionId);
  if (!conversation) return { ok: false, error: "session-not-found" };
  const pending = conversation.pendingMessages ?? [];
  let count = 0;
  const replacements = pending.map((row) => {
    if (row.adjustRunId !== runId) return row;
    const restored = { ...row };
    delete restored.adjustRunId;
    count++;
    return restored;
  });
  if (count === 0) return { ok: true, reset: 0 };
  conversation.pendingMessages = replacements;
  if (!persistPending(conversation, "[chats-store] 待发消息调整复位落盘失败:", sessionId)) return { ok: false, error: "write-failed" };
  return { ok: true, reset: count };
}

export function clearStalePendingAdjustMarks(): void {
  for (const summary of [...catalog]) {
    try {
      const conversation = read(summary.id);
      if (!conversation?.pendingMessages?.some((row) => row.adjustRunId)) continue;
      let altered = false;
      conversation.pendingMessages = conversation.pendingMessages.map((row) => {
        if (!row.adjustRunId) return row;
        altered = true;
        const restored = { ...row };
        delete restored.adjustRunId;
        return restored;
      });
      if (altered) write(conversation);
    } catch (failure) { console.warn("[chats-store] 清理陈旧调整标记失败:", summary.id, failure); }
  }
}
