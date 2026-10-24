import { publicRunFailure } from "../shared/run-failure";
import {readMainAttachmentGrant,type MainAttachmentGrant} from "./memory-context/main-attachment-projection";
import type {MainDesktopMemory} from "./memory-context/main-desktop-memory";
import * as fs from "fs";
import { app, IpcMainInvokeEvent, WebContents } from "electron";
import { getHarnessRunStore } from "./orchestrator/harness/run-store";
import { IPC } from "../shared/ipc-channels";
import { createIpcScope, type IpcScope } from "./application/ipc-scope";
import { Subscription } from "rxjs";
import { AgentRuntimeError } from "./orchestrator/agent-runtime-error";
import {
  FireflyAgent,
  type AgentExecutionMode,
  type FireflyRunOptions,
  type FireflyRunResult,
} from "./orchestrator/firefly-agent";
import { RunSettlementGate } from "./orchestrator/run-settlement";
import { toastEvents } from "./toast/toast-events";
import type { AguiRunAck, FireflyRunTerminalResult } from "../shared/run-terminal";
import { indexConversationTurn } from "./orchestrator/tools/history-tools";
import type { RelationshipChannel } from "./relationship/relationship-log";
import { createThinkFilter, type ThinkStreamFilter, type ThinkFilterMode } from "./chat/think-filter";
import { ChatTimeStreamPrefixFilter } from "./chat/chat-time-stream-filter";
import { runLearnPostTurnHook } from "./knowledge/progress/learn-post-turn";
import { openKnowledgeWorkspace } from "./knowledge/knowledge-workspace";
import { getAdapterForConfig } from "./orchestrator/vendors";
import { perf } from "./perf-trace";
import type { PendingTurnLifecycle } from "./plugin-host/pending-turn-lifecycle";
import * as chatsStore from "./chats/chats-store";
import { createRunAdjustmentPoller } from "./chats/pending-adjustment";
import { broadcastChatsChanged } from "./chats/chats-ipc";
import type { ConversationMode, PendingChatAttachment } from "../shared/chat-types";
import { prepareTranscriptDispatch, type TranscriptRewindRequest } from "./orchestrator/conversation-transcript-coordinator";
import { isWorkReadScopeCurrent } from "./chats/work-read-scope";
import { evaluateWorkFileEvidence } from "./chats/work-file-evidence";
import { getConversationTranscriptStore } from "./orchestrator/conversation-transcript-store";
import { createTranscriptSink, type TranscriptSink } from "./orchestrator/transcript-sink";
import { controlledSettlement } from "./orchestrator/controlled-responses";
import {
  requestUserClarification,
  cancelPendingChoicesForRun,
  type ChoiceCardData,
  type ChoiceSettlement,
} from "./user-choice";
import { cancelPendingApprovalsForRun, getCurrentLevel } from "./permission";
import { cancelPendingQuizzesForRun, takeQuizEvidenceForRun } from "./orchestrator/pop-quiz";
import { approvePlan, getPlanPath, moveToReview, supplementPlan } from "./orchestrator/plan-mode";
import { buildPlanReviewCard, buildPlanSupplementCard } from "./orchestrator/harness/plan-tools";
import type { AskUserAnswer } from "../shared/ask-clarification";
import type { PluginPromptMode, PluginTurnCompletedEvent } from "../plugins/types";
import { runWithUsageAttribution } from "./usage-attribution";
// 桌面运行的输入、归属与结算都在 Main 内维护。
export interface AguiRunInput {
  messages: unknown[];
  userTurnId?: string;
  assistantTurnId?: string;
  sessionId?: string;
  workspaceBindingSessionId?: string | null;
  channel?: RelationshipChannel;
  promptSource?: "conversation" | "plugin-agent";
  promptChannel?: string;
  executionMode?: ConversationMode;
  mode?: ConversationMode;
  attachments?: { name: string; text: string }[];
  workDocuments?: Array<{
    name: string; path: string; requiredEndLine?: number;
    totalLines?: number; partialAccepted?: boolean;
  }>;
  imageAttachments?: { name: string; filePath: string; mime?: string }[];
  recoveryContext?: string;
  resumeFromRunId?: string;
  takeoverFromRunId?: string;
  modelProfileId?: string;
  transcriptRewind?: TranscriptRewindRequest;
  useTranscriptContext?: boolean;
}

export interface MainBuildOptionsContext {
  attachmentGrant?: MainAttachmentGrant;
}
export type BuildOptionsFn = ((input: AguiRunInput, mainContext?: MainBuildOptionsContext) => Promise<{
  options: FireflyRunOptions;
  latestUserText: string;
}>) & {
  prepareTranscript?: (input: AguiRunInput) => Promise<void>;
};

export interface RunFinishedEffects {
  sticker?: string | null;
}
export type OnRunFinishedFn = (
  result: FireflyRunResult,
  latestUserText: string,
  context: {
    source: PluginTurnCompletedEvent["source"];
    mode: PluginPromptMode;
    conversationId: string;
    channel?: string;
    runId?: string;
    modelProfileId?: string;
  },
) => Promise<void | RunFinishedEffects> | void | RunFinishedEffects;
export type GetChatWindowFn = () => { webContents: WebContents; isDestroyed(): boolean } | null;
export interface AguiConversationLifecycle {
  onUserMessage(): void;
  onConversationStarted(): void;
  onConversationEnded(): void;
}

interface SessionActiveRun {
  runId: string;
  abort: () => void;
  settled: Promise<void>;
}
const runsById = new Map<string, {
  subscription: Subscription;
  endLifecycle: () => void;
  abortController: AbortController;
  cancel: () => void;
}>();
const runsByConversation = new Map<string, SessionActiveRun>();
let takeoverWaitMs = 5_000;
let optionBuilder: BuildOptionsFn | null = null;
let resolveChatWindow: GetChatWindowFn = () => null;

export function resolveTranscriptContextSource(
  value = fireflyEnvironment(process.env, "FIREFLY_TRANSCRIPT_CONTEXT_SOURCE"),
): "transcript" | "renderer" {
  if (value === "renderer") return "renderer";
  return "transcript";
}

export function hasActiveConversationRun(): boolean {
  return runsByConversation.size > 0;
}

export function isActiveConversationRun(sessionId: string, runId: string): boolean {
  const entry = runsById.get(runId);
  return runsByConversation.get(sessionId)?.runId === runId && !!entry && !entry.abortController.signal.aborted;
}

export function __hasActiveRunForTest(runId: string): boolean {
  return runsById.has(runId);
}

export function __getSessionActiveRunForTest(sessionId: string): string | undefined {
  return runsByConversation.get(sessionId)?.runId;
}

export function __setTakeoverSettleTimeoutForTest(ms: number): void {
  takeoverWaitMs = ms;
}

export function __releaseSessionGuardForTest(sessionId: string, runId: string): void {
  releaseSessionGuardEntry(sessionId, runId);
}

function releaseSessionGuardEntry(sessionId: string, runId: string, resolveSettled?: () => void): void {
  const owned = runsByConversation.get(sessionId)?.runId === runId;
  if (owned) runsByConversation.delete(sessionId);
  resolveSettled?.();
}

function extractTerminalFromRunFinished(baseEvent: unknown): FireflyRunTerminalResult {
  const candidate = (baseEvent as { result?: unknown })?.result;
  if (candidate && typeof candidate === "object" && "status" in candidate
      && typeof (candidate as { status: unknown }).status === "string") {
    const kind = (candidate as { status: string }).status;
    switch (kind) {
      case "success":
      case "cancelled":
      case "timeout":
      case "runtime_error": {
        const detail = (candidate as { reason?: unknown }).reason;
        const uncertainty = (candidate as { externalEffectsMayContinue?: unknown }).externalEffectsMayContinue;
        const normalized: FireflyRunTerminalResult = {
          status: kind,
          externalEffectsMayContinue: typeof uncertainty === "boolean" ? uncertainty : kind !== "success",
        };
        if (typeof detail === "string") normalized.reason = detail;
        return normalized;
      }
    }
  }
  return { status: "success", externalEffectsMayContinue: false };
}

function startPlanReviewFlow(params: {
  sessionId: string;
  threadId: string;
  runId: string;
  send: (event: unknown) => void;
}): void {
  const conversation = params.sessionId;
  const thread = params.threadId;
  const execution = params.runId;
  const deliver = params.send;
  const sendPlanCard = (card: ChoiceCardData): void => {
    deliver({
      type: "CUSTOM", name: "firefly.choice",
      value: { ...card, sessionId: conversation },
      threadId: thread, runId: execution,
    });
  };
  const sendPlanDismiss = (closed: ChoiceSettlement): void => {
    deliver({
      type: "CUSTOM", name: "firefly.choice.dismiss", value: closed,
      threadId: thread, runId: execution,
    });
  };

  // 审批在终态之后独立运行，卡片仍沿用该轮身份。
  void (async () => {
    if (!moveToReview(conversation)) return;
    console.log("[AgUiBridge][Plan] run finished with write_plan, entering PLAN_REVIEW");
    const documentPath = getPlanPath(conversation);
    let documentText = "";
    try {
      documentText = await fs.promises.readFile(documentPath, "utf8");
    } catch (failure) {
      console.warn("[AgUiBridge][Plan] read plan.md for review failed:", failure);
    }
    deliver({
      type: "CUSTOM", name: "firefly.plan.review",
      value: { planPath: documentPath, planContent: documentText, sessionId: conversation },
      threadId: thread, runId: execution,
    });
    toastEvents.publishPlanReview({ sessionId: conversation, runId: execution });
    const reviewReply = await requestUserClarification(
      buildPlanReviewCard(documentPath), sendPlanCard, sendPlanDismiss,
      { runId: execution, revision: 1 },
    ) as AskUserAnswer;
    const selected = reviewReply.answers.find((field) => field.field === "plan_decision");
    if (selected?.selectedValues?.includes("approve") && approvePlan(conversation)) {
      console.log("[AgUiBridge][Plan] plan approved, entering EXECUTING");
      deliver({
        type: "CUSTOM", name: "firefly.plan.approved",
        value: { planPath: documentPath, sessionId: conversation },
        threadId: thread, runId: execution,
      });
      toastEvents.publishPlanApproved({ sessionId: conversation, runId: execution });
      return;
    }
    supplementPlan(conversation);
    if (!selected?.selectedValues?.includes("supplement")) return;
    console.log("[AgUiBridge][Plan] user wants to supplement, asking for details");
    const detailsReply = await requestUserClarification(
      buildPlanSupplementCard(), sendPlanCard, sendPlanDismiss,
      { runId: execution, revision: 2 },
    ) as AskUserAnswer;
    const details = detailsReply.answers.find((field) => field.field === "plan_supplement")?.customText?.trim();
    if (!details) {
      console.log("[AgUiBridge][Plan] supplement card timed out / empty, waiting for user message");
      return;
    }
    console.log("[AgUiBridge][Plan] supplement submitted, back to PLAN_DISCUSSING with user text");
    deliver({
      type: "CUSTOM", name: "firefly.plan.supplement",
      value: { sessionId: conversation, text: details },
      threadId: thread, runId: execution,
    });
  })().catch((failure) => {
    console.warn("[AgUiBridge][Plan] review flow failed:", failure);
    supplementPlan(conversation);
    toastEvents.publishPlanReviewEnded({ sessionId: conversation, runId: execution });
  });
}

import { fireflyEnvironment } from "../shared/firefly-environment";

export function registerAgUiIpc(
  buildOptions: BuildOptionsFn,
  onRunFinished: OnRunFinishedFn,
  getChatWindow: GetChatWindowFn,
  lifecycle?: AguiConversationLifecycle,
  ipcOption?: IpcScope,
  pendingTurns?: PendingTurnLifecycle,
  memory?:Pick<MainDesktopMemory,"authorizeRun"|"afterTranscript"> & {
    readonly usesCanonicalUserContent?:boolean;
    readonly retiresLegacyHistoryIndex?:boolean;
    // 成功后的记忆处理独立执行，不把失败带回聊天。
    onTurnSucceeded?:(input:{sessionId:string;runId:string})=>Promise<void>;
    prepareAttachmentGrant?:(event:Electron.IpcMainInvokeEvent,sessionId:string,input:{userTurnId:string})=>Promise<MainAttachmentGrant|undefined>;
  },
): void {
  const routes = ipcOption ?? createIpcScope();
  optionBuilder = buildOptions;
  resolveChatWindow = getChatWindow;

  if (pendingTurns) {
    routes.on(IPC.AGUI_RUN_PERSISTED, (_notice, data: unknown) => {
      const confirmation = data as { runId?: unknown; finalMessageId?: unknown };
      if (typeof confirmation?.runId !== "string" || !confirmation.runId) return;
      pendingTurns.confirmPersistence(confirmation.runId, {
        ...(typeof confirmation.finalMessageId === "string" && confirmation.finalMessageId
          ? { finalMessageId: confirmation.finalMessageId } : {}),
      });
    });
  }

  routes.handle(IPC.HARNESS_GET_INTERRUPTED_RUN, (_notice, id: unknown) => {
    if (typeof id !== "string" || !id) return null;
    const checkpoint = getHarnessRunStore(app.getPath("userData")).getLatestInterrupted(id);
    return checkpoint ? {
      runId: checkpoint.runId,
      rounds: checkpoint.rounds,
      todoCount: checkpoint.state.todoItems.length,
      updatedAt: checkpoint.updatedAt,
    } : null;
  });

  const finishTurn = onRunFinished;
  routes.handle(IPC.AGUI_RUN, async (invocation: IpcMainInvokeEvent, payload: unknown) => perf.withTurn(async (telemetry) => {
    if (!optionBuilder || !finishTurn) throw new Error("AG-UI 桥未初始化");
    const suppliedMode = (payload as AguiRunInput)?.mode;
    if (suppliedMode !== undefined && suppliedMode !== "chat" && suppliedMode !== "work" && suppliedMode !== "code") {
      throw new Error("INVALID_CONVERSATION_MODE");
    }
    lifecycle?.onUserMessage();
    lifecycle?.onConversationStarted();
    const request = payload as AguiRunInput;
    const origin = invocation.sender;
    const executionId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    telemetry.beginTurn(`desktop:${executionId}`);
    const beganAt = Date.now();
    let isControlled = false;

    const emit = (packet: unknown): void => {
      const stamped = packet && typeof packet === "object"
        ? { ...(packet as Record<string, unknown>), runId: (packet as { runId?: unknown }).runId ?? executionId }
        : packet;
      const recipients: WebContents[] = [];
      if (!origin.isDestroyed()) recipients.push(origin);
      const companion = resolveChatWindow();
      if (companion && !companion.isDestroyed() && companion.webContents !== origin) {
        recipients.push(companion.webContents);
      }
      for (const recipient of recipients) {
        try {
          if (isControlled && (packet as { type?: string })?.type === "TEXT_MESSAGE_START") {
            recipient.send(IPC.AGUI_EVENT, {
              type: "CUSTOM", name: "firefly.sResponse", value: { pending: true }, runId: executionId,
            });
          }
          recipient.send(IPC.AGUI_EVENT, stamped);
        } catch (failure) {
          console.error("[AgUiBridge] send 失败:", (failure instanceof Error ? failure.message : String(failure)), "事件类型=", (packet as { type?: string })?.type);
        }
      }
    };

    const conversationId = request.sessionId;
    if (!conversationId) {
      lifecycle?.onConversationEnded();
      throw new Error("AGUI_RUN 缺少 sessionId");
    }
    const storedSession = chatsStore.getSession(conversationId);
    if (!storedSession) {
      lifecycle?.onConversationEnded();
      throw new Error(`AGUI_RUN 会话不存在: ${conversationId}`);
    }
    const conversationMode = storedSession.mode ?? (storedSession.purpose === "proactive-chat" ? "chat" : "work");
    const userRecord = request.userTurnId
      ? storedSession.messages.find((entry) => entry.id === request.userTurnId && entry.role === "user")
      : undefined;
    let documents: PendingChatAttachment[] = conversationMode === "work"
      ? (userRecord?.attachments ?? []).filter((entry) => entry.kind === "document") : [];
    let readScopes = documents.flatMap((entry) => entry.kind === "document" && entry.readScope ? [entry.readScope] : []);
    if ((conversationMode === "work" || conversationMode === "code") && !storedSession.workspaceBinding?.workspaceRoot) {
      lifecycle?.onConversationEnded();
      throw new Error(`${conversationMode} 模式需要先绑定项目工作区`);
    }

    const abortSource = new AbortController();
    let settlementPort: TranscriptSink | undefined;
    const cancelRun = () => {
      if (!settlementPort || controlledSettlement(settlementPort).requestCancel()) abortSource.abort();
    };
    let relinquish: (() => void) | null = null;

    // 取得守卫之前不让出执行权；接管醒来后仍须重新竞争。
    for (let attempts = 0; ; attempts++) {
      const incumbent = runsByConversation.get(conversationId);
      if (!incumbent) {
        let notifySettled!: () => void;
        const completion = new Promise<void>((notify) => { notifySettled = notify; });
        runsByConversation.set(conversationId, {
          runId: executionId, abort: cancelRun, settled: completion,
        });
        relinquish = () => releaseSessionGuardEntry(conversationId, executionId, notifySettled);
        break;
      }
      if (request.takeoverFromRunId !== incumbent.runId) {
        lifecycle?.onConversationEnded();
        throw new Error(`SESSION_RUN_ACTIVE:${incumbent.runId}`);
      }
      if (attempts >= 2) {
        lifecycle?.onConversationEnded();
        throw new Error(`SESSION_RUN_TAKEOVER_STUCK:${incumbent.runId}`);
      }
      incumbent.abort();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        incumbent.settled,
        new Promise<void>((notify) => { deadline = setTimeout(notify, takeoverWaitMs); }),
      ]);
      clearTimeout(deadline);
    }

    try {
      const authorization = memory?.authorizeRun(invocation, conversationId);
      if (authorization) {
        if (!request.userTurnId || !request.assistantTurnId) {
          authorization.release();
          throw Error("MEMORY_DESKTOP_SESSION_DENIED");
        }
        const revoke = () => cancelRun();
        const freeGuard = relinquish!;
        authorization.signal.addEventListener("abort", revoke, { once: true });
        relinquish = () => {
          authorization.signal.removeEventListener("abort", revoke);
          authorization.release();
          freeGuard();
        };
        if (authorization.signal.aborted) throw Error("MEMORY_DESKTOP_SESSION_DENIED");
      }
    } catch (failure) {
      relinquish?.();
      relinquish = null;
      lifecycle?.onConversationEnded();
      throw failure;
    }

    if (!memory?.prepareAttachmentGrant && readScopes.some((range) => !isWorkReadScopeCurrent(range))) {
      relinquish?.();
      relinquish = null;
      lifecycle?.onConversationEnded();
      throw new Error("WORK_READ_SCOPE_CHANGED:所选文件已变化，请重新发送并确认读取范围");
    }

    const abandonPreparedRun = (): void => {
      telemetry.dump();
      try { chatsStore.resetPendingAdjustByRun(conversationId, executionId); } catch { /* 保留原失败原因 */ }
      relinquish?.();
      relinquish = null;
      lifecycle?.onConversationEnded();
    };
    const contextSource = resolveTranscriptContextSource();
    if (request.userTurnId) {
      try {
        await optionBuilder.prepareTranscript?.({
          ...request, mode: conversationMode, executionMode: conversationMode, modelProfileId: storedSession.modelProfileId,
        });
        await prepareTranscriptDispatch({
          store: getConversationTranscriptStore(app.getPath("userData")),
          session: storedSession,
          userTurnId: request.userTurnId,
          assistantTurnId: request.assistantTurnId,
          runId: executionId,
          rewind: request.transcriptRewind,
          ...(memory?.usesCanonicalUserContent === true ? { forceUserContent: true } : {}),
        });
        await memory?.afterTranscript(conversationId, request);
      } catch (failure) {
        abandonPreparedRun();
        throw failure;
      }
    }
    request.useTranscriptContext = Boolean(request.userTurnId) && contextSource === "transcript";
    const executionMode: AgentExecutionMode = conversationMode === "chat" ? "chat" : "work";
    let preparation;
    try {
      const attachmentContext: MainBuildOptionsContext | undefined = memory?.prepareAttachmentGrant && request.userTurnId
        ? { attachmentGrant: await memory.prepareAttachmentGrant(invocation, conversationId, { userTurnId: request.userTurnId }) }
        : undefined;
      if (memory?.prepareAttachmentGrant) {
        if (readScopes.length && !attachmentContext?.attachmentGrant) throw Error("MEMORY_ATTACHMENT_DENIED");
        if (attachmentContext?.attachmentGrant) {
          const projection = readMainAttachmentGrant(attachmentContext.attachmentGrant);
          if (projection.sessionId !== conversationId || projection.userTurnId !== request.userTurnId) {
            throw Error("MEMORY_ATTACHMENT_DENIED");
          }
          documents = conversationMode === "work" ? projection.attachments.filter((entry) => entry.kind === "document") : [];
          readScopes = documents.flatMap((entry) => entry.readScope ? [entry.readScope] : []);
          if (readScopes.some((range) => !isWorkReadScopeCurrent(range))) {
            throw Error("WORK_READ_SCOPE_CHANGED:所选文件已变化，请重新发送并确认读取范围");
          }
        }
      }
      const buildWithContext = (nextInput: AguiRunInput) => attachmentContext
        ? optionBuilder!(nextInput, attachmentContext) : optionBuilder!(nextInput);
      preparation = await telemetry.track("build_options", () => buildWithContext({
        ...request,
        workDocuments: documents.map((entry) => ({
          name: entry.name,
          path: entry.kind === "document" && entry.readScope ? entry.readScope.path : entry.filePath,
          ...(entry.kind === "document" && entry.readScope ? {
            requiredEndLine: entry.readScope.endLine,
            totalLines: entry.readScope.totalLines,
            partialAccepted: entry.readScope.partialAccepted,
          } : {}),
        })),
        mode: conversationMode,
        modelProfileId: storedSession.modelProfileId,
        executionMode,
      }));
    } catch (failure) {
      abandonPreparedRun();
      throw failure;
    }

    const { options: runOptions, latestUserText: userText } = preparation;
    runOptions.executionMode = executionMode;
    const recovery = [runOptions.recoveryContext, request.recoveryContext]
      .filter((fragment): fragment is string => Boolean(fragment?.trim())).join("\n\n");
    if (recovery) runOptions.recoveryContext = recovery;
    runOptions.resumeFromRunId = request.resumeFromRunId;
    runOptions.conversationMode = conversationMode;
    runOptions.runId = executionId;
    isControlled = Boolean(runOptions.controlledResponses);
    if (runOptions.controlledResponses) {
      runOptions.isControlledRunCurrent = () => runsByConversation.get(conversationId)?.runId === executionId;
    }
    runOptions.workReadScopes = readScopes;
    const writesTranscript = Boolean(request.userTurnId);
    runOptions.transcriptSink = writesTranscript ? createTranscriptSink({
      store: getConversationTranscriptStore(app.getPath("userData")),
      conversationId,
      runId: executionId,
      ...(request.assistantTurnId ? { assistantTurnId: request.assistantTurnId } : {}),
    }) : undefined;
    if (runOptions.controlledResponses && runOptions.transcriptSink) settlementPort = runOptions.transcriptSink;
    runOptions.signal = abortSource.signal;
    if (conversationMode !== "chat") {
      runOptions.pollRunAdjustments = createRunAdjustmentPoller(
        conversationId, executionId, chatsStore,
        writesTranscript ? {
          appendUser: async ({ turnId, text: content, attachments: files }) => {
            const journal = getConversationTranscriptStore(app.getPath("userData"));
            await journal.append(conversationId, {
              id: `user:v1:${turnId}:r1`,
              at: Date.now(),
              kind: "user",
              turnId,
              revision: 1,
              payload: { text: content, ...(files ? { attachments: files } : {}) },
            });
          },
        } : undefined,
      );
    }
    runOptions.requestUserClarification = (question) => requestUserClarification(
      question,
      (card) => { emit({ type: "CUSTOM", name: "firefly.choice", value: card, threadId: threadKey, runId: executionId }); },
      (closed) => { emit({ type: "CUSTOM", name: "firefly.choice.dismiss", value: closed, threadId: threadKey, runId: executionId }); },
      { runId: executionId, revision: 1 },
    );
    const learningSpace = openKnowledgeWorkspace(conversationMode, storedSession.workspaceBinding?.workspaceRoot);
    const threadKey = `thread-${Date.now()}`;
    const runner = new FireflyAgent({ threadId: threadKey, description: "流萤主聊天" });

    let unwatchOrigin: (() => void) | null = null;
    if (pendingTurns) {
      pendingTurns.beginTurn({
        runId: executionId,
        conversationId,
        mode: conversationMode,
        inputMessageId: request.userTurnId ?? "",
        ...(request.assistantTurnId ? { assistantMessageId: request.assistantTurnId } : {}),
        startedAt: beganAt,
        runTimeoutMs: runOptions.timeoutMs,
      });
      const disposePendingTurn = (): void => { pendingTurns?.disposeEntry(executionId); };
      origin.once("destroyed", disposePendingTurn);
      origin.once("did-start-navigation", disposePendingTurn);
      unwatchOrigin = () => {
        origin.removeListener("destroyed", disposePendingTurn);
        origin.removeListener("did-start-navigation", disposePendingTurn);
      };
    }

    let deferredTerminal: unknown | null = null;
    const gate = new RunSettlementGate();
    let ended = false;
    const cleanupRunState = (): void => {
      runsById.delete(executionId);
      cancelPendingChoicesForRun(executionId);
      cancelPendingApprovalsForRun(executionId);
      cancelPendingQuizzesForRun(executionId);
      unwatchOrigin?.();
      unwatchOrigin = null;
    };
    const endLifecycle = (): void => {
      if (ended) return;
      ended = true;
      try {
        chatsStore.resetPendingAdjustByRun(conversationId, executionId);
      } catch (failure) {
        console.warn("[AgUiBridge] 插话标记复位失败:", failure);
      }
      relinquish?.();
      relinquish = null;
      lifecycle?.onConversationEnded();
    };

    let thoughtStream: ThinkStreamFilter | null = null;
    let clockStream: ChatTimeStreamPrefixFilter | null = null;
    const filterPolicy: ThinkFilterMode = "leading-only";
    let withheldStart: { type: string; messageId?: string; [key: string]: unknown } | null = null;
    let bodyOpened = false;
    let reasoningOpen = false;
    let reasoningId = "";

    const forwardTextStart = (): void => {
      if (!withheldStart || bodyOpened) return;
      bodyOpened = true;
      emit(withheldStart);
    };
    const forwardEmbeddedReasoning = (piece: string): void => {
      if (!piece) return;
      if (!reasoningOpen) {
        reasoningOpen = true;
        reasoningId = `${withheldStart?.messageId ?? executionId}-reasoning`;
        emit({
          type: "REASONING_MESSAGE_START", messageId: reasoningId, role: "reasoning",
          threadId: threadKey, runId: executionId,
        });
      }
      emit({
        type: "REASONING_MESSAGE_CONTENT", messageId: reasoningId, delta: piece,
        threadId: threadKey, runId: executionId,
      });
    };
    const endEmbeddedReasoning = (): void => {
      if (!reasoningOpen) return;
      emit({ type: "REASONING_MESSAGE_END", messageId: reasoningId, threadId: threadKey, runId: executionId });
      reasoningOpen = false;
    };

    // 正文开始延迟到可见文本出现；终态延迟到该轮副作用结束。
    telemetry.mark("agent_run_start");
    const streamSubscription = runner.runWithEvents(runOptions).subscribe({
      next: (packet) => {
        const kind = (packet as { type?: string })?.type;
        switch (kind) {
          case "RUN_FINISHED": {
            endEmbeddedReasoning();
            thoughtStream = null;
            clockStream = null;
            withheldStart = null;
            bodyOpened = false;
            let outcome = extractTerminalFromRunFinished(packet);
            if (runOptions.controlledResponses) {
              const durableState = settlementPort ? controlledSettlement(settlementPort).get() : "unknown";
              if (durableState === "success") outcome = { status: "success", externalEffectsMayContinue: false };
              if (outcome.status === "success" && durableState !== "success" || durableState === "unknown"
                  || durableState === "success_reserved" || durableState === "interrupted_reserved") {
                outcome = { status: "runtime_error", reason: "MEMORY_CONTEXT_SETTLEMENT_UNKNOWN", externalEffectsMayContinue: false };
              }
            }
            if (!gate.trySettle(outcome)) return;
            if (outcome.status === "runtime_error") {
              const safe = publicRunFailure({ code: outcome.reason });
              emit({
                type: "RUN_ERROR", message: safe.code, code: safe.code, errorSource: safe.source,
                threadId: threadKey, runId: executionId,
              });
              deferredTerminal = null;
              return;
            }
            deferredTerminal = runOptions.controlledResponses ? { ...(packet as object), result: outcome } : packet;
            return;
          }
          case "TEXT_MESSAGE_START":
            thoughtStream = createThinkFilter(filterPolicy);
            clockStream = new ChatTimeStreamPrefixFilter();
            withheldStart = packet as typeof withheldStart;
            bodyOpened = false;
            reasoningOpen = false;
            reasoningId = "";
            return;
          case "TEXT_MESSAGE_CONTENT": {
            if (!thoughtStream) {
              emit(packet);
              return;
            }
            const chunk = packet as { type: string; delta?: string };
            const incoming = typeof chunk.delta === "string" ? chunk.delta : "";
            const visible = clockStream?.push(thoughtStream.push(incoming)) ?? thoughtStream.push(incoming);
            forwardEmbeddedReasoning(thoughtStream.takeThinking());
            if (visible) {
              endEmbeddedReasoning();
              forwardTextStart();
              emit({ ...chunk, delta: visible });
            }
            return;
          }
          case "TEXT_MESSAGE_END": {
            if (thoughtStream) {
              const buffered = clockStream?.push(thoughtStream.flush()) ?? thoughtStream.flush();
              const clockRemainder = clockStream?.finish() ?? "";
              forwardEmbeddedReasoning(thoughtStream.takeThinking());
              if (buffered || clockRemainder) {
                endEmbeddedReasoning();
                forwardTextStart();
                emit({ type: "TEXT_MESSAGE_CONTENT", delta: `${buffered}${clockRemainder}`, threadId: threadKey, runId: executionId });
              }
              thoughtStream = null;
              clockStream = null;
            }
            endEmbeddedReasoning();
            if (bodyOpened) emit(packet);
            withheldStart = null;
            bodyOpened = false;
            return;
          }
          default:
            emit(packet);
        }
      },
      error: (failure) => {
        endEmbeddedReasoning();
        thoughtStream = null;
        withheldStart = null;
        bodyOpened = false;
        const safe = publicRunFailure(failure);
        const { code: failureCode, source: failureSource } = safe;
        console.error("[AgUiBridge] run failed:", { runId: executionId, ...safe });
        telemetry.dump();
        const failedOutcome: FireflyRunTerminalResult = {
          status: "runtime_error",
          reason: failureCode,
          errorSource: failureSource,
          externalEffectsMayContinue: true,
        };
        if (!gate.trySettle(failedOutcome)) {
          if (deferredTerminal) {
            emit(deferredTerminal);
            deferredTerminal = null;
          }
          const priorOutcome = gate.get();
          if (priorOutcome) {
            pendingTurns?.settleTerminal(executionId, {
              status: priorOutcome.status, durationMs: Date.now() - beganAt,
            });
          }
          cleanupRunState();
          endLifecycle();
          return;
        }
        pendingTurns?.settleTerminal(executionId, {
          status: "runtime_error", durationMs: Date.now() - beganAt,
        });
        emit({
          type: "RUN_ERROR", message: failureCode, code: failureCode, errorSource: failureSource,
          threadId: threadKey, runId: executionId,
        });
        cleanupRunState();
        endLifecycle();
      },
      complete: async () => {
        telemetry.mark("agent_run_complete");
        cleanupRunState();
        if (!gate.isSettled()) {
          const unconfirmed = Boolean(runOptions.controlledResponses)
            && (!settlementPort || controlledSettlement(settlementPort).get() !== "success");
          const fallback: FireflyRunTerminalResult = unconfirmed
            ? { status: "runtime_error", reason: "MEMORY_CONTEXT_SETTLEMENT_UNKNOWN", externalEffectsMayContinue: false }
            : { status: "success", externalEffectsMayContinue: false };
          gate.trySettle(fallback);
          if (unconfirmed) {
            emit({
              type: "RUN_ERROR", message: "MEMORY_CONTEXT_SETTLEMENT_UNKNOWN", code: "MEMORY_CONTEXT_SETTLEMENT_UNKNOWN",
              threadId: threadKey, runId: executionId,
            });
          }
          deferredTerminal = { type: "RUN_FINISHED", threadId: threadKey, runId: executionId, result: fallback };
        }
        const finalState = gate.get();
        const succeeded = finalState?.status === "success";
        if (finalState) {
          pendingTurns?.settleTerminal(executionId, {
            status: finalState.status, durationMs: Date.now() - beganAt,
          });
        }
        try {
          if (runner.lastResult && succeeded) {
            const response = runner.lastResult;
            const extras = await telemetry.track("on_run_finished", async () => finishTurn(response, userText, {
              source: "desktop",
              mode: conversationMode,
              conversationId,
              runId: executionId,
              modelProfileId: request.modelProfileId,
            }));
            void runWithUsageAttribution(
              { feature: "memory" }, async () => memory?.onTurnSucceeded?.({ sessionId: conversationId, runId: executionId }),
            ).catch(() => undefined);
            if (conversationMode !== "code" && extras?.sticker !== undefined) {
              emit({ type: "CUSTOM", name: "firefly.sticker", value: extras.sticker, threadId: threadKey, runId: executionId });
            }
            if (!isControlled && memory?.retiresLegacyHistoryIndex !== true) {
              void indexConversationTurn(request.sessionId || "default", userText, response.reply);
            }
            if (learningSpace) {
              const learningAdapter = getAdapterForConfig({
                provider: runOptions.settings.provider,
                baseUrl: runOptions.settings.baseUrl,
                model: runOptions.settings.model,
                apiKey: runOptions.settings.apiKey,
              });
              const answers = takeQuizEvidenceForRun(executionId);
              void runLearnPostTurnHook({
                workspace: learningSpace,
                accessLevel: runOptions.permissionMode === "allow_all" ? "full" : getCurrentLevel(),
                adapter: learningAdapter,
                cfg: {
                  provider: runOptions.settings.provider,
                  baseUrl: runOptions.settings.baseUrl,
                  model: runOptions.settings.model,
                  apiKey: runOptions.settings.apiKey,
                },
                systemPrompt: runOptions.soulSystemBaseContent ?? "",
                userMessage: userText,
                assistantMessage: response.reply,
                quizEvidence: answers.length > 0 ? answers : undefined,
              });
            }
          }
        } catch (failure) {
          console.warn("[AgUiBridge] 副作用失败（不影响结果）:", failure);
        }
        if (readScopes.length > 0) {
          try {
            const recorded = await getConversationTranscriptStore(app.getPath("userData")).read(conversationId);
            const evidence = evaluateWorkFileEvidence({
              runId: executionId, scopes: readScopes, entries: recorded.entries, isCurrent: isWorkReadScopeCurrent,
            });
            emit({ type: "CUSTOM", name: "firefly.workRead", value: evidence, threadId: threadKey, runId: executionId });
          } catch (failure) {
            console.error("[AgUiBridge] Work 读取证据核对失败:", failure);
          }
        }
        if (finalState?.status === "runtime_error") {
          deferredTerminal = null;
        } else if (deferredTerminal) {
          emit(deferredTerminal);
          deferredTerminal = null;
        }
        if ((conversationMode === "code" || conversationMode === "chat") && succeeded) {
          startPlanReviewFlow({ sessionId: conversationId, threadId: threadKey, runId: executionId, send: emit });
        }
        endLifecycle();
        telemetry.dump();
      },
    });
    if (!gate.isSettled()) {
      runsById.set(executionId, {
        subscription: streamSubscription, endLifecycle, abortController: abortSource, cancel: cancelRun,
      });
    }
    return { success: true, runId: executionId };
  }));

  routes.handle(IPC.AGUI_CANCEL, (_notice, runId?: string) => {
    const abortRun = (execution: string): void => {
      const running = runsById.get(execution);
      if (running && !running.abortController.signal.aborted) running.cancel();
      cancelPendingChoicesForRun(execution);
      cancelPendingApprovalsForRun(execution);
      cancelPendingQuizzesForRun(execution);
    };
    if (runId) {
      abortRun(runId);
    } else {
      for (const execution of [...runsById.keys()]) abortRun(execution);
    }
    return true;
  });

  routes.handle(IPC.CHATS_PENDING_ADJUST, (invocation: IpcMainInvokeEvent, data: unknown) => {
    const adjustment = data as { sessionId?: unknown; messageId?: unknown };
    const conversation = typeof adjustment?.sessionId === "string" ? adjustment.sessionId : "";
    const message = typeof adjustment?.messageId === "string" ? adjustment.messageId : "";
    if (!conversation || !message) return { ok: false, error: "invalid-payload" };
    const saved = chatsStore.getSession(conversation);
    if (!saved) return { ok: false, error: "session-not-found" };
    const owner = runsByConversation.get(conversation);
    if (!owner) {
      return { ok: false, error: "no-active-run", queue: chatsStore.getPendingMessages(conversation) ?? [] };
    }
    const savedMode = saved.mode ?? (saved.purpose === "proactive-chat" ? "chat" : "work");
    if (savedMode === "chat") {
      return { ok: false, error: "no-safe-next-step", queue: chatsStore.getPendingMessages(conversation) ?? [] };
    }
    const marked = chatsStore.markPendingAdjust(conversation, message, owner.runId);
    if (marked.ok) broadcastChatsChanged(invocation.sender);
    return marked;
  });
}
