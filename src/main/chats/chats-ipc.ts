// 聊天会话的 IPC 层：把 chats-store 的纯数据接口开放给渲染进程。
//
// 写入成功后向窗口广播 `chats:changed`，让设置中心的聊天面板刷新列表，
// 也让聊天窗口在标题被改名等情况下保持同步。
//
// 来源隔离：由渲染进程发起的写入，广播时会跳过发起它的窗口（sender）。
// 发起方已经拿到最新状态，不必被自己的写入再唤醒；聊天窗口的 onChanged
// 因此只对真正的外部变更触发（别的窗口，或主进程自己发起的写入，
// 例如外部主动消息的提交）。这样可以避免本窗口 saveSession() 的广播
// 回来重载当前会话，把临时的思考消息清掉的竞态。
//
// `chats:open-in-chat-window` 要创建 BrowserWindow，由 src/main/index.ts 注册，
// 不在这里；本模块只处理纯数据操作。

import type { MainDesktopMemory } from "../memory-context/main-desktop-memory";
import { mainAttachmentReferences } from "../memory-context/main-attachment-projection";
import { canonicalJson } from "../memory-core/repository-types";
import { app, BrowserWindow, type WebContents, dialog, shell } from "electron";
import { randomUUID } from "crypto";
import { IPC } from "../../shared/ipc-channels";
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from "../../shared/context-window";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import type { ChatMessage, ConversationMode, ConversationWorkspaceBinding, PendingChatMessage } from "../../shared/chat-types";
import * as chatsStore from "./chats-store";
import * as fs from "fs";
import * as path from "path";
import { createWorkMarkdownSnapshot } from "./work-markdown-export";
import { inspectWorkReadFile, isWorkReadScopeCurrent, WORK_READ_PAGE_LINES } from "./work-read-scope";
import { getDefaultModelProfile, loadModelSettings, resolveModelSettingsProfile } from "../settings/model-settings";
import { FileToolOutputStore } from "../orchestrator/harness/tool-output/file-tool-output-store";
import { getHarnessRunStore } from "../orchestrator/harness/run-store";
import { getConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import { projectSSettlementMessages } from "../orchestrator/conversation-transcript-context";
import { getStorageContext } from "../storage-context";
import { getRunReviewTracker } from "../orchestrator/review/run-review-tracker";
import { getAdapterForConfig } from "../orchestrator/vendors";
import { activeChatTargetRegistry } from "../plugin-host/active-chat-target";
import { callSummarizeModel } from "../orchestrator/context-manager";
import { buildContextUsageSnapshot } from "../orchestrator/context-usage";
import type { LlmClient } from "../services/llm/llm-client";
import { enqueueLLMTask } from "../llm-queue";
import { createConversationTitleService, type ConversationTitleService } from "./conversation-title-service";

function broadcastChanged(skip?: WebContents | null): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (win.isDestroyed()) return;
    // 来源隔离：渲染进程自己的写入不必再广播回它自己
    if (skip && win.webContents === skip) return;
    try {
      win.webContents.send(IPC.CHATS_CHANGED);
    } catch {
      // 刚创建、尚未 ready 的窗口发送时可能抛错，忽略
    }
  });
}

/** 主动压缩所针对的模型窗口大小，和渲染层 ChatPage 每轮 run 的 slice(-16) 一致。 */
const COMPACT_MODEL_WINDOW = 16;
/** 主动压缩后保留的最近消息数（约三轮对话），窗口内更早的消息摘要为一条记忆。 */
const COMPACT_KEEP_RECENT = 6;
/** 同一会话压缩进行中时，拒绝再次触发。 */
const compactingSessions = new Set<string>();

function visibleUserText(content: string): string {
  return content.replace(/\[sticker:[^\]]+\]/gi, "").trim();
}

function stripSProjection(message: ChatMessage): ChatMessage {
  const { sSettlement: _projection, ...stored } = message;
  return stored;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// 字符串字段缺失或类型不对时按空串处理
const textOrEmpty = (value: unknown): string => (typeof value === "string" ? value : "");

/** 不读取附件内容，按 claimPendingMessage 的口径构造稳定的用户消息。 */
function pendingUserMessage(head: PendingChatMessage): ChatMessage {
  const message: ChatMessage = { id: head.id, role: "user", content: head.rawContent, at: Date.now() };
  if (head.userSticker) message.sticker = head.userSticker;
  if (head.attachments?.length) {
    message.attachments = head.attachments.map((item) => {
      if (item.kind === "image") {
        return {
          kind: "image" as const,
          name: item.name,
          filePath: item.filePath,
          mime: item.mime ?? "application/octet-stream",
          caption: item.caption,
          status: "pending" as const,
          ...(item.hasAnnotations ? { hasAnnotations: true } : {}),
        };
      }
      return {
        kind: "document" as const,
        name: item.name,
        filePath: item.filePath,
        status: "pending" as const,
        ...(item.readScope ? { readScope: item.readScope } : {}),
      };
    });
  }
  return message;
}

type ChatsIpcOptions = {
  titleService?: ConversationTitleService;
  llmClient?: LlmClient;
  isPrimaryModelBusy?: () => boolean;
  memory?: Pick<MainDesktopMemory, "appendUser" | "mutate" | "ownsSession"> & {
    readonly usesCanonicalUserContent?: boolean;
    /** Only a memory owner that honours the session's temporary mode may host a temporary chat. */
    readonly supportsTemporarySessions?: boolean;
  };
};

// 手动压缩：窗口外的历史只是界面记录，不进入模型上下文，原样保留；
// 窗口内保留最近若干条，更早的摘要成一条记忆消息（格式与 Chat 模式循环内的
// 自动压缩一致，下一轮 run 归一化后会作为 assistant 消息进入模型上下文）。
async function compactSession(sessionId: string, memory: ChatsIpcOptions["memory"]) {
  if (memory?.ownsSession?.(sessionId)) return { ok: false, error: "MEMORY_CONTEXT_LEGACY_COMPACTION_UNSUPPORTED" };
  if (compactingSessions.has(sessionId)) return { ok: false, error: "正在压缩，请稍候" };
  const session = chatsStore.getSession(sessionId);
  if (!session) return { ok: false, error: "会话不存在" };

  const inWindow = session.messages.slice(-COMPACT_MODEL_WINDOW);
  const recent = inWindow.slice(-COMPACT_KEEP_RECENT);
  const toSummarize = inWindow.slice(0, -COMPACT_KEEP_RECENT);
  const tooShort = { ok: false, error: "对话还很短，不需要压缩" };
  if (toSummarize.length === 0) return tooShort;

  // 界面消息转模型消息，口径同 normalizeChatMessages：model 映射为 assistant，空内容丢弃
  const history = toSummarize
    .filter((m) => typeof m.content === "string" && m.content.trim())
    .map((m) => ({
      role: m.role === "user" ? ("user" as const) : ("assistant" as const),
      content: m.content,
    }));
  if (history.length === 0) return tooShort;

  compactingSessions.add(sessionId);
  try {
    const base = loadModelSettings();
    const settings = session.modelProfileId ? resolveModelSettingsProfile(base, session.modelProfileId) : base;
    if (!settings.baseUrl) {
      return { ok: false, error: "还没有填写 API URL，请先在设置里保存 API 配置。" };
    }
    const { provider, baseUrl, model, apiKey, explicitTransport, reasoning } = settings;
    const adapter = getAdapterForConfig({
      provider, baseUrl, model, apiKey,
      ...(explicitTransport ? { explicitTransport } : {}),
      ...(reasoning ? { reasoning } : {}),
    });

    // 摘要失败直接返回错误，不落库也不动原消息，历史安全优先
    const summary = await callSummarizeModel(history, adapter, settings);
    const summaryMessage: ChatMessage = {
      id: `compact-${randomUUID().slice(0, 8)}`, role: "model",
      content: `[此前对话已压缩为记忆摘要]\n${summary}`, at: Date.now(),
    };

    const untouched = session.messages.slice(0, session.messages.length - COMPACT_MODEL_WINDOW);
    const nextMessages = [...untouched, summaryMessage, ...recent];
    if (!chatsStore.replaceMessages(sessionId, nextMessages)) return { ok: false, error: "会话不存在" };

    // 压缩成功后写入会话级上下文快照，环形图立刻体现压缩效果（手动压缩不产生 run，
    // 也就没有 preRequest 快照）。除 conversation 外的分类压缩前后不变，
    // 继承最近一条消息级快照；conversation 分类按压缩后的消息重新计算。
    const previous = session.messages.filter((m) => m.contextUsage).pop()?.contextUsage;
    const modelMessages = nextMessages
      .filter((m) => typeof m.content === "string" && m.content.trim())
      .map((m) => ({
        role: m.role === "user" ? ("user" as const) : ("assistant" as const),
        content: m.content as string,
      }));
    const snapshot = buildContextUsageSnapshot({
      phase: "terminal",
      contextWindowTokens: previous?.contextWindowTokens ?? settings.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
      personaContent: "",
      messages: modelMessages as never,
    });
    if (previous) {
      snapshot.categories = snapshot.categories.map((cat) =>
        cat.key === "conversation" || cat.key === "toolDefinitions"
          ? cat
          : { key: cat.key, tokens: previous.categories.find((c) => c.key === cat.key)?.tokens ?? 0 },
      );
      snapshot.totalTokens = snapshot.categories.reduce((sum, cat) => sum + cat.tokens, 0);
    }
    chatsStore.setSessionContextUsage(sessionId, snapshot);

    // 结果是主进程改写的，发起窗口并不知道；必须广播给包括 sender 在内的所有窗口，
    // 让聊天窗口重载，所以不能走跳过 sender 的来源隔离
    broadcastChanged();
    return { ok: true, before: session.messages.length, after: nextMessages.length };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  } finally {
    compactingSessions.delete(sessionId);
  }
}

export function registerChatsIpc(ipcOption?: IpcScope, options: ChatsIpcOptions = {}): void {
  const ipc = ipcOption ?? createIpcScope();
  const memory = options.memory;
  const titleService =
    options.titleService ??
    (options.llmClient
      ? createConversationTitleService({
          onTitleChanged: () => broadcastChanged(),
          enqueueTask: enqueueLLMTask,
          llmClient: options.llmClient,
          isPrimaryModelBusy: options.isPrimaryModelBusy,
          resolveSettings: (session) => resolveModelSettingsProfile(loadModelSettings(), session.modelProfileId),
          setGeneratedTitle: chatsStore.setGeneratedTitle,
          getSession: chatsStore.getSession,
        })
      : undefined);

  // 找出内容发生变化（含新增、删除）的用户消息 id
  const changedUsers = (id: string, next: ChatMessage[]): string[] => {
    const before = chatsStore.getSession(id)?.messages ?? [];
    const userIds = new Set([...before, ...next].filter((m) => m.role === "user").map((m) => m.id));
    const sameId = (list: ChatMessage[], target: string) => JSON.stringify(list.filter((m) => m.id === target));
    return [...userIds].filter((target) => sameId(before, target) !== sameId(next, target));
  };
  const mutate = <T>(event: any, id: string, ids: string[], commit: () => T): T | Promise<T> =>
    memory ? memory.mutate(event, id, ids, commit) : commit();

  chatsStore.initialize();
  // 进程刚启动时没有任何存活的运行，磁盘上遗留的插话标记都已过期，清回普通队列
  chatsStore.clearStalePendingAdjustMarks();

  ipc.handle(IPC.CHATS_LIST, (_event, opts?: { mode?: ConversationMode }) => chatsStore.listSessions(opts));

  const project = async <T extends { messages: ChatMessage[] }>(id: string, value: T | null): Promise<T | null> => {
    if (!value) return value;
    const transcripts = getConversationTranscriptStore(getStorageContext().dataRoot);
    return transcripts.withReadLease(id, async (read) => ({
      ...value,
      messages: projectSSettlementMessages(value.messages, (await read()).entries),
    }));
  };
  ipc.handle(IPC.CHATS_GET, (_event, id: string) => project(id, chatsStore.getSession(id)));

  ipc.handle(IPC.CHATS_EXPORT_WORK_MARKDOWN, async (event, id: unknown) => {
    if (typeof id !== "string" || !id) return { ok: false, error: "invalid-session" };
    const session = chatsStore.getSession(id);
    const markdown = session && createWorkMarkdownSnapshot(session);
    if (!markdown) return { ok: false, error: "work-task-not-finished" };
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) return { ok: false, error: "no-window" };
    const picked = await dialog.showSaveDialog(owner, {
      properties: ["showOverwriteConfirmation"],
      filters: [{ name: "Markdown", extensions: ["md"] }],
      defaultPath: "work-task.md",
      title: "导出 Work 任务",
    });
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
    await fs.promises.writeFile(picked.filePath, markdown, "utf8");
    return { ok: true };
  });

  ipc.handle(
    IPC.CHATS_CREATE,
    (event, payload?: { title?: string; identityId?: string | null; mode?: ConversationMode; temporary?: boolean }) => {
      const temporary = payload?.temporary === true;
      if (temporary && memory && memory.supportsTemporarySessions !== true) {
        throw new Error("TEMPORARY_CHAT_UNAVAILABLE");
      }
      const created = chatsStore.createSession({
        title: payload?.title,
        identityId: payload?.identityId ?? null,
        mode: payload?.mode,
        modelProfileId: getDefaultModelProfile()?.id,
        ...(temporary ? { temporary: true } : {}),
      });
      broadcastChanged(event.sender);
      return created;
    },
  );

  ipc.handle(IPC.CHATS_APPEND, async (event, payload: { id: string; message: ChatMessage }) => {
    if (!payload || !payload.id || !payload.message) return null;
    const { id, message } = payload;
    const commit = () => chatsStore.appendMessage(id, stripSProjection(message));
    const session =
      message.role === "user" && memory
        ? await memory.appendUser(event, id, message, commit)
        : await mutate(event, id, [], commit);
    if (!session) return session;

    broadcastChanged(event.sender);
    if (message.role === "user" && !memory?.ownsSession?.(id)) {
      titleService?.schedule({
        sessionId: id,
        userMessageId: message.id,
        text: visibleUserText(message.content),
      });
    }
    return session;
  });

  ipc.handle(IPC.CHATS_UPSERT, async (event, payload: { id: string; message: ChatMessage } | null | undefined) => {
    if (!payload?.id || !payload.message) return null;
    const { id, message } = payload;
    const before = chatsStore.getSession(id)?.messages ?? [];
    const next = before.filter((m) => m.id !== message.id).concat(message);
    if (memory?.ownsSession?.(id) && changedUsers(id, next).length) {
      throw Error("MEMORY_CONTEXT_TRANSCRIPT_EDIT_UNSUPPORTED");
    }
    const session = await mutate(event, id, changedUsers(id, next), () =>
      chatsStore.upsertMessage(id, stripSProjection(message)),
    );
    if (session) broadcastChanged(event.sender);
    return session;
  });

  ipc.handle(
    IPC.CHATS_REPLACE_TAIL,
    async (event, payload: { id: string; startIndex: number; messages: ChatMessage[] }) => {
      if (!payload?.id || !Array.isArray(payload.messages)) return null;
      const { id, startIndex, messages } = payload;
      const before = chatsStore.getSession(id)?.messages ?? [];
      const next = before.slice(0, startIndex).concat(messages);

      if (memory?.ownsSession?.(id) && changedUsers(id, next).length) {
        // 记忆接管的会话只允许一种用户消息改动：重新生成最后一条用户消息
        const lastUserIndex = before.map((m) => m.role).lastIndexOf("user");
        const old = before[lastUserIndex];
        const replacement = messages.filter((m) => m.role === "user");
        const notRegenerate =
          startIndex !== lastUserIndex ||
          !old ||
          replacement.length !== 1 ||
          replacement[0].id !== old.id ||
          replacement[0].modelContext;
        if (notRegenerate) throw Error("MEMORY_CONTEXT_TRANSCRIPT_EDIT_UNSUPPORTED");

        const newAttachments = replacement[0].attachments;
        if (newAttachments?.length) {
          const scopeOf = (list: NonNullable<ChatMessage["attachments"]>) =>
            canonicalJson(list.map((item) => (item.kind === "document" ? item.readScope ?? null : null)));
          const refsOf = (list: NonNullable<ChatMessage["attachments"]>) =>
            canonicalJson(mainAttachmentReferences(list));
          const denied =
            memory.usesCanonicalUserContent !== true ||
            !old.attachments?.length ||
            refsOf(newAttachments) !== refsOf(old.attachments) ||
            scopeOf(newAttachments) !== scopeOf(old.attachments);
          if (denied) throw Error("MEMORY_ATTACHMENT_DENIED");
        }
      }

      const session = await mutate(event, id, changedUsers(id, next), () =>
        chatsStore.replaceMessagesTail(id, startIndex, messages.map(stripSProjection)),
      );
      if (session) broadcastChanged(event.sender);
      return session;
    },
  );

  // 主动压缩：由上下文容量菜单里的小人点击触发
  ipc.handle(IPC.CHATS_COMPACT, async (_event, payload: { sessionId?: unknown }) => {
    const sessionId = payload && typeof payload === "object" ? (payload as { sessionId?: unknown }).sessionId : undefined;
    if (typeof sessionId !== "string" || !sessionId) return { ok: false, error: "missing sessionId" };
    return await compactSession(sessionId, memory);
  });

  ipc.handle(IPC.CHATS_RENAME, (event, payload: { id: string; title: string }) => {
    if (!payload || !payload.id) return null;
    const renamed = chatsStore.renameSession(payload.id, payload.title ?? "");
    if (renamed) broadcastChanged(event.sender);
    return renamed;
  });

  ipc.handle(IPC.CHATS_DELETE, async (event, id: string) => {
    if (!id) return false;
    const userMessageIds = (chatsStore.getSession(id)?.messages ?? []).filter((m) => m.role === "user").map((m) => m.id);
    const deleted = await mutate(event, id, userMessageIds, () => chatsStore.deleteSession(id));
    if (!deleted) return deleted;

    // 若删的是当前活动目标会话，让语音输入租约的目标失效（是否命中由登记表判断）
    activeChatTargetRegistry.notifySessionDeleted(id);

    // 会话已经删掉，附属数据清理失败只记日志，不能让界面回滚成“删除失败”。
    // 只有原本就是异步的两步需要等待，harness run 的删除是同步的。
    const warnCleanup = (what: string, error: unknown): void => {
      console.error(`[ChatsIpc] failed to delete ${what}`, error);
    };
    try {
      await new FileToolOutputStore(app.getPath("userData")).deleteConversation(id);
    } catch (error) {
      warnCleanup("persisted tool outputs", error);
    }
    try {
      getHarnessRunStore(app.getPath("userData")).deleteConversation(id);
    } catch (error) {
      warnCleanup("persisted harness runs", error);
    }
    try {
      await getConversationTranscriptStore(app.getPath("userData")).deleteConversation(id);
    } catch (error) {
      warnCleanup("conversation transcript", error);
    }
    broadcastChanged(event.sender);
    return deleted;
  });

  ipc.handle(IPC.CHATS_SET_PINNED, (event, payload: { id: string; pinned: boolean }) => {
    if (!payload || typeof payload.id !== "string") return null;
    const pinned = chatsStore.setSessionPinned(payload.id, Boolean(payload.pinned));
    if (pinned) broadcastChanged(event.sender);
    return pinned;
  });

  // ── 会话级待发队列：入队、读取、删除 ──
  // 入队成功才返回 ok:true 与权威队列；失败原因用机器可读的字符串，渲染层据此保留草稿并提示。
  // 幂等命中（enqueued=false，同标识同内容重试）不广播，因为磁盘和队列都没变。
  ipc.handle(IPC.CHATS_PENDING_ENQUEUE, async (event, payload: { sessionId?: unknown; entry?: unknown }) => {
    const sessionId = textOrEmpty(payload?.sessionId);
    const entry = payload?.entry as chatsStore.PendingChatMessageInput | undefined;
    if (!sessionId || !entry || typeof entry !== "object") return { ok: false, error: "invalid-payload" };

    const session = chatsStore.getSession(sessionId);
    if (!session) return { ok: false, error: "session-not-found" };
    const wantsRead = session.mode === "work" && entry.requireDocumentRead === true;
    const hasDocument = (entry.attachments ?? []).some((a) => a.kind === "document");
    if (wantsRead && !hasDocument) return { ok: false, error: "no-document-selected" };

    const prepared: NonNullable<chatsStore.PendingChatMessageInput["attachments"]> = [];
    for (const attachment of entry.attachments ?? []) {
      const { readScope: _dropped, ...plain } = attachment;
      if (!wantsRead || attachment.kind !== "document") {
        prepared.push(plain);
        continue;
      }

      let scope;
      try {
        scope = inspectWorkReadFile(attachment.filePath);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "file-not-readable" };
      }
      if (scope.totalLines > WORK_READ_PAGE_LINES) {
        const owner = BrowserWindow.fromWebContents(event.sender);
        if (!owner) return { ok: false, error: "no-window" };
        const answer = await dialog.showMessageBox(owner, {
          cancelId: 2,
          defaultId: 0,
          type: "question" as const,
          title: "确认读取范围",
          message: `${scope.name} 共 ${scope.totalLines} 行。read_file 每次最多读取 ${WORK_READ_PAGE_LINES} 行。`,
          detail: `完整读取需要逐段读取 1–${scope.totalLines} 行。也可只要求读取 1–${WORK_READ_PAGE_LINES} 行；${WORK_READ_PAGE_LINES + 1}–${scope.totalLines} 行将保持未覆盖。`,
          buttons: ["完整读取", `只读前 ${WORK_READ_PAGE_LINES} 行`, "取消"],
        });
        if (answer.response !== 0 && answer.response !== 1) return { ok: false, canceled: true };
        if (answer.response === 1) scope = { ...scope, endLine: WORK_READ_PAGE_LINES, partialAccepted: true };
      }
      prepared.push({ ...plain, readScope: scope });
    }

    if (prepared.some((a) => a.readScope && !isWorkReadScopeCurrent(a.readScope))) {
      return { ok: false, error: "file-changed-before-enqueue" };
    }
    const outcome = chatsStore.enqueuePendingMessage(sessionId, { ...entry, attachments: prepared, requireDocumentRead: wantsRead });
    if (outcome.ok && outcome.enqueued) broadcastChanged(event.sender);
    return outcome;
  });

  ipc.handle(IPC.CHATS_PENDING_LIST, (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId) return null;
    return chatsStore.getPendingMessages(sessionId);
  });

  // 删除按稳定标识处理竞争：条目恰好已被认领或移除时幂等成功（removed=false 不广播）
  ipc.handle(IPC.CHATS_PENDING_REMOVE, (event, payload: { sessionId?: unknown; messageId?: unknown }) => {
    const sessionId = textOrEmpty(payload?.sessionId);
    const messageId = textOrEmpty(payload?.messageId);
    if (!sessionId || !messageId) return { ok: false, error: "invalid-payload" };
    const outcome = chatsStore.removePendingMessage(sessionId, messageId);
    if (outcome.ok && outcome.removed) broadcastChanged(event.sender);
    return outcome;
  });

  // 认领队首：一次会话文件写入，把待发条目变成正式用户消息并记录派发状态。
  // 认领会产生真实历史消息，所以要广播刷新；队列为空或认领冲突时原样透传结果。
  const claimsInFlight = new Map<string, Promise<chatsStore.ClaimPendingResult>>();
  ipc.handle(IPC.CHATS_PENDING_CLAIM, (event, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId) return { ok: false, error: "invalid-payload" };

    const claimHead = async (): Promise<chatsStore.ClaimPendingResult> => {
      const session = chatsStore.getSession(sessionId);
      const head = session?.pendingMessages?.[0];
      let result: chatsStore.ClaimPendingResult;

      if (memory && session && !session.pendingDispatch && head) {
        const snapshotOfHead = JSON.stringify(head);
        let stale = false;
        let claimed: chatsStore.ClaimPendingResult | undefined;
        await memory.appendUser(event, sessionId, pendingUserMessage(head), () => {
          // 主进程授权期间队列可能变化，只有恰好是这个队首才可以拿到回执
          const now = chatsStore.getSession(sessionId);
          if (!now || now.pendingDispatch || JSON.stringify(now.pendingMessages?.[0]) !== snapshotOfHead) {
            stale = true;
            return false;
          }
          claimed = chatsStore.claimPendingMessage(sessionId);
          return claimed.ok && claimed.claimed ? claimed : false;
        });
        if (stale) throw Error("MEMORY_SOURCE_STALE");
        if (!claimed) throw Error("MEMORY_USER_SOURCE_DENIED");
        result = claimed;
      } else {
        result = chatsStore.claimPendingMessage(sessionId);
      }

      if (result.ok && result.claimed) {
        broadcastChanged(event.sender);
        if (!memory?.ownsSession?.(sessionId)) {
          titleService?.schedule({ sessionId, userMessageId: result.userMessage.id, text: result.visibleContent });
        }
      }
      return result;
    };

    // 重复的认领请求必须串行，否则同一个用户身份的来源准入会互相竞争
    const earlier = claimsInFlight.get(sessionId);
    const current = (earlier ? earlier.catch(() => undefined) : Promise.resolve()).then(claimHead);
    claimsInFlight.set(sessionId, current);
    const release = () => {
      if (claimsInFlight.get(sessionId) === current) claimsInFlight.delete(sessionId);
    };
    void current.then(release, release);
    return current;
  });

  // 派发确认：run 被主进程接受后清除认领状态。纯簿记，不广播。
  ipc.handle(IPC.CHATS_PENDING_COMPLETE_DISPATCH, (event, payload: { sessionId?: unknown; messageId?: unknown }) => {
    const sessionId = textOrEmpty(payload?.sessionId);
    const messageId = textOrEmpty(payload?.messageId);
    if (!sessionId || !messageId) return { ok: false, error: "invalid-payload" };
    return chatsStore.completePendingDispatch(sessionId, messageId);
  });

  // 修改未认领条目的文字：内容沿用页面现有的解析规则（原文、展示文字、表情标记），
  // 条目标识、入队时间、顺序和附件都不变；冲突或失败时返回最新的权威队列。
  type PendingEditPayload = {
    userSticker?: unknown;
    visibleContent?: unknown;
    rawContent?: unknown;
    messageId?: unknown;
    sessionId?: unknown;
  };
  ipc.handle(IPC.CHATS_PENDING_EDIT, (event, payload: PendingEditPayload) => {
    const sessionId = textOrEmpty(payload?.sessionId);
    const messageId = textOrEmpty(payload?.messageId);
    if (!sessionId || !messageId || typeof payload.rawContent !== "string") {
      return { ok: false, error: "invalid-payload" };
    }
    const outcome = chatsStore.editPendingMessage(sessionId, messageId, {
      rawContent: payload.rawContent,
      visibleContent: typeof payload.visibleContent === "string" ? payload.visibleContent : payload.rawContent,
      ...(typeof payload.userSticker === "string" ? { userSticker: payload.userSticker } : {}),
    });
    if (outcome.ok) broadcastChanged(event.sender);
    return outcome;
  });

  ipc.handle(IPC.CHATS_SET_MODEL_PROFILE, (event, payload: { id: string; modelProfileId?: string }) => {
    if (!payload || typeof payload.id !== "string") return null;
    const updated = chatsStore.setSessionModelProfile(payload.id, payload.modelProfileId);
    if (updated) broadcastChanged(event.sender);
    return updated;
  });

  ipc.handle(IPC.CHATS_OPEN_WORKSPACE, async (_event, root: unknown) => {
    if (typeof root !== "string" || !root.trim()) return { ok: false, error: "missing workspaceRoot" };
    try {
      const resolved = validateAndNormalizeWorkspace(root);
      const bound = chatsStore.listSessions().some((s) => s.workspaceRoot === resolved);
      if (!bound) return { ok: false, error: "workspace is not bound to a conversation" };
      const failure = await shell.openPath(resolved);
      return failure ? { ok: false, error: failure } : { ok: true };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  });

  // ── 会话的工作区绑定 ──

  ipc.handle(IPC.CHATS_SET_WORKSPACE, async (event, payload: { sessionId: string; workspaceRoot: string }) => {
    if (!(payload?.sessionId && payload?.workspaceRoot)) {
      return { ok: false, error: "missing sessionId or workspaceRoot" };
    }
    const existing = chatsStore.getSession(payload.sessionId);
    if (!existing) return { ok: false, error: "session not found" };
    const mode = existing.mode;
    if (mode !== "work" && mode !== "code") {
      return { ok: false, error: `${mode ?? "unknown"} mode does not support workspace binding` };
    }
    // 校验路径：目录要存在，并解析 realpath
    try {
      const resolved = validateAndNormalizeWorkspace(payload.workspaceRoot);
      const binding: ConversationWorkspaceBinding = { workspaceRoot: resolved, displayName: path.basename(resolved), boundAt: Date.now() };
      if (!chatsStore.setWorkspaceBinding(payload.sessionId, binding)) {
        return { ok: false, error: "session not found" };
      }
      console.log("[Workspace] 绑定成功:", "sessionId=" + payload.sessionId.slice(0, 8) + "...", "workspaceRoot=" + resolved);
      return { ok: true, binding };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  });

  ipc.handle(IPC.CHATS_PICK_WORKSPACE_FOLDER, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) return { ok: false, error: "no window" };
    const picked = await dialog.showOpenDialog(owner, {
      properties: ["openDirectory"],
      title: "选择工作区目录",
    });
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true };
    try {
      const resolved = validateAndNormalizeWorkspace(picked.filePaths[0]);
      return { ok: true, path: resolved, displayName: path.basename(resolved) };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  });

  // ── Review 快照：取指定 Run 不可变的文件变更审查数据 ──
  // 正常结束的 Run 已在 harness-adapter 里主动 finalize；
  // 崩溃恢复（interrupted）的 Run 在这里按 "halted" 补生成；
  // 仍在运行（status=running）的 Run 不生成快照，避免拿到不完整的 diff。
  ipc.handle(IPC.REVIEW_GET, (_event, runId: string) => {
    if (!runId || typeof runId !== "string") return null;
    const reviews = getRunReviewTracker(app.getPath("userData"));
    const saved = reviews.loadReview(runId);
    if (saved) return saved;
    const run = getHarnessRunStore(app.getPath("userData")).get(runId);
    if (!run || run.status === "running") return null;
    return reviews.finalizeIfPending(runId, run.createdAt, "halted");
  });

  // ── Review 恢复：把本次 Run 改过的文件回滚到运行前 ──
  // 以 journal 和 before/ 基线为准；二进制文件只存元数据，无法恢复，计入 skipped。
  // 单个文件恢复失败不影响其他文件，failed 非空时 ok=false。
  ipc.handle(IPC.REVIEW_RESTORE, (_event, runId: string) => {
    const nothingRestored = (error: string) => ({ ok: false, restored: 0, skipped: [], failed: [], error });
    if (!runId || typeof runId !== "string") return nothingRestored("invalid runId");
    const reviews = getRunReviewTracker(app.getPath("userData"));
    try {
      const outcome = reviews.restoreRun(runId);
      return { ok: outcome.failed.length === 0, ...outcome };
    } catch (err) {
      return nothingRestored(errorText(err));
    }
  });
}

/**
 * 校验并规范化工作区路径：目录必须存在，
 * 用 realpath 消除 symlink 与 junction，再按 Windows 习惯标准化。
 */
function validateAndNormalizeWorkspace(inputPath: string): string {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`目录不存在: ${inputPath}`);
  }
  if (!fs.statSync(inputPath).isDirectory()) {
    throw new Error(`不是目录: ${inputPath}`);
  }
  return path.resolve(fs.realpathSync(inputPath));
}

// 给 main/index.ts 使用的广播入口（删除当前活动会话后调用一次；
// 主动消息提交 commitLocalProactiveMessage 也用它）。
// 这些写入都由主进程发起，没有 sender，会广播给所有窗口（含聊天窗口）——
// 对聊天窗口来说属于真正的外部变更，应当触发重载。
export { broadcastChanged as broadcastChatsChanged };
