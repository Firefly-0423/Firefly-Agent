import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../../i18n";
import { MessageSquareDashed } from "lucide-react";
import { DownOutlined, GlobalOutlined, FolderOpenOutlined, ProfileOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { Group, Panel, Separator, useDefaultLayout, type GroupImperativeHandle } from "react-resizable-panels";
import { useCompactDock, useElementWidth } from "./useCompactDock";
import { useInspectorPanelVisibility } from "./useInspectorPanelVisibility";
import { CHANGES_TAB_PREFIX, changesTabId, collectWorkspaceOutputs, createWorkspaceResultRevealer, workspaceFileRevision, type WorkspaceChangedFile, type WorkspaceRunOutput } from "../workspace/workspace-artifacts";
import { WorkspaceResultsIndex } from "../workspace/WorkspaceRunResults";
import { useBrowserWorkspaceActivation } from "../workspace/useBrowserWorkspaceActivation";
import { ChatComposer, parseComposerMessage } from "../components/ChatComposer";
import { ComposerSlot } from "../components/ComposerSlot";
import { FloatingComposer } from "../components/FloatingComposer";
import { usePresence } from "../components/use-presence";
import { buildStepProgressSummary } from "../components/step-progress";
import { CodeGitPanel } from "../components/CodeGitPanel";
import type { PlanReviewPhase } from "../components/PlanReviewPanel";
import { ChatPageInspector, type ChatPageInspectorDiffTab } from "../components/ChatPageInspector";
import { SessionOverviewPanel } from "../components/SessionOverviewPanel";
import { summarizeOutputFiles } from "../components/session-overview-model";
import { ChatInspectorActionsContext, type ChatInspectorActions } from "../components/inspector-actions";
import {
  normalizeDeferredPlanChoice,
  normalizePopQuizCard,
  shouldDismissAsk,
  type ComposerInteraction,
} from "../components/run-presentation";
import { ChatMessageList } from "../components/ChatMessageList";
import { ChatPageNavigation, type ChatPagePanel } from "../components/ChatPageNavigation";
import { useNavigationHistory } from "./useNavigationHistory";
import { CodeRain } from "../components/CodeRain";
import { sessionsNeedingInput } from "./sidebar-status";
import {
  ContextCompressionNotice,
  FileDropOverlay,
  RunRecoveryNotices,
} from "../components/ChatWorkspaceNotices";

import type {
  ChatMessage,
  ChatSession,
  ChatSessionMeta,
  ConversationMode,
  PendingChatMessage,
} from "../../../../../shared/chat-types";
import { type ContextUsageSnapshot } from "../../../../../shared/context-usage";
import { ChatPagePanelHost } from "../components/ChatPagePanelHost";
import { PanelSidebarSlotContext } from "../components/PanelShell";
import { useUserCallPreference } from "../../../hooks/useUserNickname";
import { resolveRevisableLastTurn } from "../components/last-turn-actions";
import { shouldListenForDeferredPlanEvents } from "./conversation-run-policy";

import {
  aguiApi,
  chatStore,
  choiceApi,
  settingsApprovalApi,
  sidebarApi,
  type ModelConfigApi,
  type PublicModelConfig,
} from "./chat-page-bridge";
import {
  getInitialMode,
  isConversationMode,
  LAST_MODE_STORAGE_KEY,
  permissionInteraction,
  toUiMessages,
} from "./chat-page-normalizers";
import {
  bootstrapReactSession,
  normalizeSessionMode,
  openSessionByIdWithDeps,
  type OpenSessionArgs,
  type OpenSessionResult,
  type SessionSelectionResult,
  type ReactSessionMode,
} from "./openSessionByDeps";
import { useComposerAttachments } from "../hooks/useComposerAttachments";
import { useSessionMessages } from "../hooks/useSessionMessages";
import { useSchedulerEvents } from "../hooks/useSchedulerEvents";
import { useMaximizedWindowDrag } from "../hooks/useMaximizedWindowDrag";
import { useChannelMirrorEvents } from "../hooks/useChannelMirrorEvents";
import { useFeedback } from "../../../components/feedback/FeedbackProvider";
import { AgentRunController, type AgentRunInput } from "./run/AgentRunController";
import {
  clearSessionInteraction,
  bindWorkspaceName,
  findSessionIdForRun,
  hasActiveRunForSession,
  isCurrentRunBusy,
  markInteractionResolved,
  removeInteractionById,
  removeSessionInteractionsWhere,
  sessionInteraction,
  sessionInteractionPending,
  setSessionInteraction,
  setSessionInteractionBusy,
  type SessionInteractionState,
  type TodoStateBySession,
} from "./session-runtime-state";
import {
  createPendingQueueFlow,
  type PendingQueueFlow,
  type PendingQueueFlowHost,
} from "./pending-queue-flow";
import "../../../components/ui/SidebarToggle.css";
import { InspectorToggle } from "../../../components/ui/InspectorToggle";
import { OpenWorkspaceMenu } from "../components/OpenWorkspaceMenu";
import "../../../components/ui/WindowControls.css";
import "../../../components/ui/UserAvatar.css";
import "../../../components/ui/NewTaskButton.css";
import "../../../components/ui/ToolModeButton.css";
import "../components/ChatComposer.css";
import "../components/PermissionControl.css";
import "../components/ChatMessageList.css";
import "../components/ConversationSidebar.css";
/**
 * React 窗口会话打开的纯函数 helper：
 * 从同目录的 openSessionByDeps 模块 re-export 出来，便于 ChatPage 内部组件与
 * 独立测试文件共享同一份实现。
 */
export {
  normalizeSessionMode,
  openSessionByIdWithDeps,
  type ReactSessionMode,
  type OpenSessionArgs,
};

// 空列表固定引用：sessionsByMode[mode] 未加载时避免每次渲染产生新数组穿透导航 memo
const EMPTY_SESSIONS: ChatSessionMeta[] = [];

// 会话列表内容浅比较：run 结束等触发的重复刷新内容未变时保持原引用，
// 避免无谓的 sessionsByMode 新引用穿透导航/侧栏 memo（阶段 1A）
function sessionMetaListEqual(a: ChatSessionMeta[], b: ChatSessionMeta[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.id !== y.id
      || x.title !== y.title
      || x.identityId !== y.identityId
      || x.createdAt !== y.createdAt
      || x.updatedAt !== y.updatedAt
      || x.messageCount !== y.messageCount
      || x.purpose !== y.purpose
      || x.mode !== y.mode
      || x.workspaceRoot !== y.workspaceRoot
      || x.workspaceDisplayName !== y.workspaceDisplayName
      || x.pinned !== y.pinned
    ) return false;
  }
  return true;
}

/** 导航动作函数的最小签名（供 navActionsRef 转发，见组件内注释） */
interface NavActions {
  createNewTask: (workspace?: { path: string; displayName?: string }) => Promise<void>;
  createProjectTask: (workspace: { path: string; displayName?: string }) => Promise<void>;
  startTemporaryChat: () => Promise<void>;
  selectSession: (sessionId: string, targetMode?: ConversationMode) => Promise<SessionSelectionResult>;
  handleRenameSession: (sessionId: string, newTitle: string) => Promise<void>;
  handleDeleteSession: (sessionId: string) => Promise<void>;
  handleTogglePinSession: (sessionId: string, pinned: boolean) => Promise<void>;
  openProject: (workspaceRoot: string) => void;
}

/** Whether the overview card column is open, kept on this computer. */
const OVERVIEW_OPEN_KEY = "ff.chat.overviewOpen";
/** How long the right dock stays mounted while it collapses after its last tab closes; covers the 220ms width motion. */
const DOCK_EXIT_MS = 240;
/** How long the overview cards take to slide out; matches ff-chat-cards-out. */
const CARDS_EXIT_MS = 200;
/** How long the dock takes to widen for a newly opened panel; matches the pane width transition. */
const DOCK_WIDEN_MS = 240;
/** The narrowest the conversation (messages + composer) may get from dragging the dock separator, in px. */
const CHAT_MIN_WIDTH = 480;
/** The overview card column inside the conversation panel, with its inset. */
const CHAT_CARDS_WIDTH = 280;
/** The right panel's own minimum width, in px (the inspector Panel's minSize). */
const INSPECTOR_MIN_WIDTH = 280;

export function ChatPage() {
  const { t } = useTranslation();
  // 统一反馈入口：错误轻提示 / 需阅读的错误弹窗 / 危险确认
  const feedback = useFeedback();
  const preferredAddress = useUserCallPreference();
  const [collapsed, setCollapsed] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);
  const compactDock = useCompactDock(dockRef);
  const dockWidth = useElementWidth(dockRef);
  const [activePanel, setActivePanel] = useState<ChatPagePanel | null>(null);
  // Where the open feature page portals its own sidebar (inside the navigation, in place of the conversations).
  const [panelSlot, setPanelSlot] = useState<HTMLElement | null>(null);
  /** 右侧面板已打开的 diff 标签，ID 规范 diff:<runId>:<文件路径>，同 ID 只激活不重开 */
  const [diffTabs, setDiffTabs] = useState<ChatPageInspectorDiffTab[]>([]);
  /** 右侧面板已打开的文件预览标签，ID 规范 file:<相对路径> */
  const [fileTabs, setFileTabs] = useState<{ id: string; relPath: string; line?: number; lineSeq?: number }[]>([]);
  /** 工作区文件树标签是否打开（ID 固定为 files） */
  const [filesTabOpen, setFilesTabOpen] = useState(false);
  const [browserTabOpen, setBrowserTabOpen] = useState(false);
  const [tasksTabOpen, setTasksTabOpen] = useState(false);
  // The overview cards stay where the user left them, across modes, conversations and restarts.
  const [overviewTabOpen, setOverviewTabOpen] = useState(() => {
    try { return window.localStorage.getItem(OVERVIEW_OPEN_KEY) === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(OVERVIEW_OPEN_KEY, overviewTabOpen ? "1" : "0"); } catch { /* remembered for this window only */ }
  }, [overviewTabOpen]);
  const [inspectorHidden, setInspectorHidden] = useState(false);
  // The panel's real state: dragging the separator to zero (or End) collapses it while inspectorHidden stays false.
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const dockGroupRef = useRef<GroupImperativeHandle | null>(null);
  const [resultTabIds, setResultTabIds] = useState<string[]>([]);
  /** Run outputs whose changed files are open in their own panel. */
  const [changesTabIds, setChangesTabIds] = useState<string[]>([]);
  const [outputsTabOpen, setOutputsTabOpen] = useState(false);
  const [workspaceRevisionBySession, setWorkspaceRevisionBySession] = useState<Record<string, number>>({});
  const revealWorkspaceResult = useRef(createWorkspaceResultRevealer());
  /** 右侧面板当前激活的标签 ID（files / file:... / diff:... / plan:...），null 时面板取第一个标签 */
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // 右栏拖宽布局：聊天区 + 右侧面板套 Group/Panel，宽度持久化到 localStorage。
  // onlySaveAfterUserInteractions 保证只记用户拖动结果，不在挂载/程序化布局时写盘。
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "firefly.chat-page-dock",
    panelIds: ["chat", "inspector"],
    onlySaveAfterUserInteractions: true,
  });
  const [mode, setMode] = useState<ConversationMode>(getInitialMode);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [requiredReadsByScope, setRequiredReadsByScope] = useState<Record<string, boolean>>({});

  const [workspaceNames, setWorkspaceNames] = useState<Partial<Record<ConversationMode, string>>>({});
  /** 点了“临时聊天”但还没发第一条消息：会话在发送时才创建，届时带上 temporary。 */
  const [pendingTemporary, setPendingTemporary] = useState(false);
  const [pendingWorkspaceByMode, setPendingWorkspaceByMode] = useState<
    Partial<Record<ConversationMode, { path: string; displayName?: string }>>
  >({});
  // 欢迎页（无会话）暂存的模型选择：ensureSession 建会话后落地（与 pendingWorkspaceByMode 同构）。
  const [pendingModelProfileByMode, setPendingModelProfileByMode] = useState<
    Partial<Record<ConversationMode, string>>
  >({});
  const [sessionsByMode, setSessionsByMode] = useState<Partial<Record<ConversationMode, ChatSessionMeta[]>>>({});
  const [sessionListErrors, setSessionListErrors] = useState<Partial<Record<ConversationMode, boolean>>>({});
  const [activeSessionIds, setActiveSessionIds] = useState<Partial<Record<ConversationMode, string>>>({});

  const [modelBusyByMode, setModelBusyByMode] = useState<Partial<Record<ConversationMode, boolean>>>({});
  const [runRegistryVersion, setRunRegistryVersion] = useState(0);
  const [isCompressingContext, setIsCompressingContext] = useState(false);
  const [interactionsBySession, setInteractionsBySession] = useState<SessionInteractionState>({});
  const [lastTurnRevisionStarting, setLastTurnRevisionStarting] = useState(false);
  const [stickerSize, setStickerSize] = useState<"small" | "standard" | "large">("standard");

  const [todoStateBySession, setTodoStateBySession] = useState<TodoStateBySession>({});
  // 计划模式（Plan Mode 二期）：会话级计划面板内容与阶段（review → executing → completed）。
  const [planReviewBySession, setPlanReviewBySession] = useState<
    Record<string, { content: string; planPath: string; phase: PlanReviewPhase; executionRunId?: string; executionAssistantId?: string; dispatchAttemptId?: string }>
  >({});
  const [planDrawerOpen, setPlanDrawerOpen] = useState(false);
  const [interruptedRun, setInterruptedRun] = useState<{ runId: string; rounds: number; todoCount: number } | null>(null);
  // 会话守卫冲突（SESSION_RUN_ACTIVE）：主进程拒绝了并发 run，
  // 等用户决定是否终止旧 run 并接管重开本轮。仅 UX 层；正确性由主进程守卫保证。
  const [sessionTakeover, setSessionTakeover] = useState<{
    sessionId: string;
    activeRunId: string;
    retry: () => Promise<void>;
  } | null>(null);
  const activeModeRef = useRef(mode);
  const activeSessionIdsRef = useRef(activeSessionIds);
  const activeScopeRef = useRef(`mode:${mode}`);
  const sessionSelectionGeneration = useRef(0);

  const activeRunsBySession = useRef<Record<string, { assistantId: string; runId?: string; mode: ConversationMode }>>({});
  const runCheckpointBySessionRef = useRef<Record<string, (status: "running" | "waiting_user") => void>>({});
  // bootstrap 标志：只由 cold-start finally 写入；模式切换 effect 仅检查
  const [bootstrapCompleted, setBootstrapCompleted] = useState(false);
  const observedModeRef = useRef(mode);
  // 长期持有的刷新操作 ref：供 IPC 回调读取当前实现
  const refreshSessionsRef = useRef<
    (targetMode: ConversationMode, selectCurrent: boolean, expectedGeneration?: number) => Promise<void>
  >(async () => {});
  // IPC 切换串行链：保证 Ready 后连续切换按顺序完成
  const reactSessionSwitchChainRef = useRef<Promise<void>>(Promise.resolve());
  // 滚动到底部按钮状态
  const [scrollToBottomVisible, setScrollToBottomVisible] = useState(false);
  const scrollToBottomRef = useRef<() => void>(() => {});
  // 阶段 1B：注册回调稳定化——ChatMessageList 的注册 effect 依赖该引用，避免每次渲染反复注销/重注册
  const registerScrollToBottom = useCallback((scroll: () => void) => {
    scrollToBottomRef.current = scroll;
  }, []);

  // 消息域：渲染态消息按会话存储；补丁通道供 run 事件流、取消与附件预处理共用
  const {
    messagesBySession,
    patchMessage: updateMessage,
    hydrateMessages,
    replaceSessionMessages,
    appendMessages,
    patchMessageAttachments: updateMessageAttachments,
  } = useSessionMessages((targetMode) => activeSessionIdsRef.current[targetMode]);

  // 定时任务执行事件：任务触发/流式回复/终态展示在当前会话（主进程 scheduler-runner 推送）
  useSchedulerEvents({
    getActiveSessionId: () => activeSessionIdsRef.current[activeModeRef.current],
    appendMessages,
    patchMessage: updateMessage,
    persistMessage: (sessionId, message) => {
      void chatStore()?.append(sessionId, message);
    },
  });

  // 渠道消息镜像：微信/飞书等外部渠道收发消息以临时系统消息展示在当前会话（dispatcher 推送）
  useChannelMirrorEvents({
    getActiveSessionId: () => activeSessionIdsRef.current[activeModeRef.current],
    appendMessages,
  });

  useEffect(() => {
    const settings = settingsApprovalApi();
    if (!settings) return;
    const offRequest = settings.onPermissionApprovalRequest((request) => {
      const currentMode = activeModeRef.current;
      const currentSessionId = activeSessionIdsRef.current[currentMode];
      const ownerSessionId = findSessionIdForRun(activeRunsBySession.current, request.runId)
        ?? currentSessionId;
      // 路由不到会话时先丢弃：主进程每 10s 幂等重播，会话就绪后卡片自然出现。
      if (!ownerSessionId) return;
      setInteractionForSession(ownerSessionId, permissionInteraction(request));
      const activeRun = activeRunsBySession.current[ownerSessionId];
      if (activeRun) {
        updateMessage(ownerSessionId, activeRun.assistantId, { runStage: { kind: "waiting_permission" } });
        runCheckpointBySessionRef.current[ownerSessionId]?.("waiting_user");
      }
    });
    // 结算广播：pending 已在主进程被结算（用户已答 / run 取消），
    // 渲染端据此立即清卡——这是「僵尸审批卡（点了没反应）」的根治点。
    const offSettled = settings.onPermissionApprovalSettled((settlement) => {
      setInteractionsBySession((current) => removeInteractionById(current, "permission", settlement.id));
    });
    return () => {
      offRequest();
      offSettled();
    };
  }, []);

  // pop_quiz 抽查卡片（learn 模式）：与审批流同构的持久监听。
  // 请求按 runId 路由到所属会话；结算广播只清 skipped/cancelled——
  // submitted 时卡片要留在原地切展示态（判分结果 + 解析），等 run 结束统一收卡。
  useEffect(() => {
    const settings = settingsApprovalApi();
    if (!settings) return;
    const offRequest = settings.onPopQuizRequest((card) => {
      const interaction = normalizePopQuizCard(card);
      if (!interaction) return;
      const currentMode = activeModeRef.current;
      const currentSessionId = activeSessionIdsRef.current[currentMode];
      const ownerSessionId = findSessionIdForRun(activeRunsBySession.current, card.runId)
        ?? currentSessionId;
      // 路由不到会话时先丢弃：主进程每 10s 幂等重播，会话就绪后卡片自然出现。
      if (!ownerSessionId) return;
      setInteractionForSession(ownerSessionId, interaction);
      const activeRun = activeRunsBySession.current[ownerSessionId];
      if (activeRun) {
        updateMessage(ownerSessionId, activeRun.assistantId, { runStage: { kind: "waiting_user" } });
        runCheckpointBySessionRef.current[ownerSessionId]?.("waiting_user");
      }
    });
    const offSettled = settings.onPopQuizSettled((settlement) => {
      if (settlement.reason === "submitted") return;
      setInteractionsBySession((current) => removeInteractionById(current, "quiz", settlement.quizId));
    });
    return () => {
      offRequest();
      offSettled();
    };
  }, []);

  useEffect(() => {
    const modelConfig = (window as typeof window & { modelConfig?: ModelConfigApi }).modelConfig;
    if (!modelConfig) return;
    let active = true;
    const apply = (config: PublicModelConfig) => {
      if (!active) return;
      setStickerSize(config.stickerSize === "small" || config.stickerSize === "large" ? config.stickerSize : "standard");
    };
    void modelConfig.get().then(apply).catch(() => {
      if (active) setStickerSize("standard");
    });
    const off = modelConfig.onChanged(apply);
    return () => {
      active = false;
      off();
    };
  }, []);
  const modelBusyByModeRef = useRef<Partial<Record<ConversationMode, boolean>>>({});
  const lastTurnRevisionStartingRef = useRef(false);
  const activeAguiOffsRef = useRef(new Set<() => void>());
  const cancelRequestedSessionsRef = useRef(new Set<string>());
  // 会话待发队列投影：权威数据是主进程会话文件里的 pendingMessages，
  // 页面只持显示快照，入队/删除/认领/其他窗口变更后按稳定标识（id）对账刷新
  const [pendingQueueBySession, setPendingQueueBySession] = useState<Record<string, PendingChatMessage[]>>({});
  const pendingQueueBySessionRef = useRef(pendingQueueBySession);
  useEffect(() => {
    pendingQueueBySessionRef.current = pendingQueueBySession;
  }, [pendingQueueBySession]);

  const activeSessionId = activeSessionIds[mode];
  const scopeKey = activeSessionId ?? `mode:${mode}`;
  const draft = drafts[scopeKey] ?? "";
  const messages = activeSessionId ? (messagesBySession[activeSessionId] ?? []) : [];
  const activeInteraction = sessionInteraction(interactionsBySession, activeSessionId);
  const composerInteraction = activeInteraction?.interaction;
  const interactionBusy = activeInteraction?.busy ?? false;
  const interactionPending = sessionInteractionPending(activeInteraction);
  const hasMessages = messages.length > 0;
  const {
    attachments,
    attachmentBusy,
    isDraggingFiles,
    chooseFiles,
    handlePastedImage,
    handleScreenshot,
    removeAttachment,
    prepareImageAttachments,
    clearScopeAttachments,
    deleteScopeAttachments,
    dragHandlers,
  } = useComposerAttachments({
    scopeKey,
    getActiveScope: () => activeScopeRef.current,
    patchMessageAttachments: updateMessageAttachments,
  });

  // 渲染态消息快照 ref：待发队列流程查询消息是否已在视图（刷新恢复时不重复追加）
  const messagesBySessionRef = useRef(messagesBySession);
  messagesBySessionRef.current = messagesBySession;

  // 待发队列流程：入队/认领/派发/恢复的页面链路（独立模块，便于流程级测试）。
  // host 经 ref 每次渲染刷新到最新闭包；流程实例与入队失败缓存跨渲染稳定。
  const queueFlowHostRef = useRef<PendingQueueFlowHost | null>(null);
  queueFlowHostRef.current = {
    getStore: () => chatStore(),
    isSessionBusy,
    hasRenderedMessage: (sessionId, messageId) =>
      (messagesBySessionRef.current[sessionId] ?? []).some((item) => item.id === messageId),
    replaceProjection: (sessionId, queue) => {
      setPendingQueueBySession((current) => {
        if (queue === null) {
          if (!(sessionId in current)) return current;
          const next = { ...current };
          delete next[sessionId];
          return next;
        }
        return { ...current, [sessionId]: queue.map((item) => ({ ...item })) };
      });
    },
    appendMessages,
    prepareImageAttachments: (sessionId, messageId, attachmentList) => {
      void prepareImageAttachments(sessionId, messageId, attachmentList);
    },
    refreshSessions: (targetMode) => {
      void refreshSessions(targetMode, false);
    },
    startRun: runModel,
    reportError: (message) => feedback.notice({ tone: "error", message }),
  };
  const queueFlowRef = useRef<PendingQueueFlow | null>(null);
  if (!queueFlowRef.current) {
    queueFlowRef.current = createPendingQueueFlow(() => queueFlowHostRef.current!);
  }
  const queueFlow = queueFlowRef.current;
  const sessions = sessionsByMode[mode] ?? EMPTY_SESSIONS;
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
  // 会话级最新上下文快照（环形图优先读取点）：run 事件实时写入；
  // 手动压缩后随会话重载从 session.currentContextUsage 初始化（known-issues 问题 3）。
  const [sessionContextUsageBySession, setSessionContextUsageBySession] = useState<Record<string, ContextUsageSnapshot>>({});

  activeModeRef.current = mode;
  activeSessionIdsRef.current = activeSessionIds;
  activeScopeRef.current = scopeKey;

  // 缓存用户最后停留的模式，下次打开窗口时恢复
  useEffect(() => {
    try {
      localStorage.setItem(LAST_MODE_STORAGE_KEY, mode);
    } catch {
      // 忽略写入失败
    }
  }, [mode]);

  useEffect(() => () => {
    for (const off of activeAguiOffsRef.current) off();
    activeAguiOffsRef.current.clear();

  }, []);

  useEffect(() => {
    const store = chatStore();
    if (!store) return;
    const refresh = () => {
      const targetMode = activeModeRef.current;
      void refreshSessions(targetMode, true).catch((error) => {
        setSessionListErrors((current) => ({ ...current, [targetMode]: true }));
        console.error("[ChatPage] Failed to refresh changed sessions:", error);
      });
      // 队列投影对账：刷新当前各模式活跃会话与所有仍有投影的会话
      // （其他窗口可能入队/删除/认领；会话已删时 pendingList 返回 null 清除投影）
      const sessionIds = new Set<string>(Object.keys(pendingQueueBySessionRef.current));
      for (const activeId of Object.values(activeSessionIdsRef.current)) {
        if (activeId) sessionIds.add(activeId);
      }
      for (const sessionId of sessionIds) void queueFlow.syncProjection(sessionId);
    };
    const off = store.onChanged(refresh);
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 模式 effect：bootstrap 完成后才刷新；bootstrap 自身由下方合并 effect 接管
  useEffect(() => {
    const previousMode = observedModeRef.current;
    observedModeRef.current = mode;
    if (!bootstrapCompleted || previousMode === mode) return;
    void refreshSessionsRef.current(mode, true).catch((error) => {
      setSessionListErrors((current) => ({ ...current, [mode]: true }));
      console.error("[ChatPage] Failed to refresh sessions after mode change:", error);
    });
  }, [bootstrapCompleted, mode]);

  // 合并 effect：注册 IPC → cold-start → finally 置 bootstrap + 通知 ready
  useEffect(() => {
    const store = chatStore();
    const initialMode = activeModeRef.current;
    if (!store?.onReactSwitchSession) {
      setSessionListErrors((current) => ({ ...current, [initialMode]: true }));
      return;
    }

    let disposed = false;

    const unsubscribe = store.onReactSwitchSession((sessionId) => {
      if (!sessionId) return;
      const generation = ++sessionSelectionGeneration.current;
      reactSessionSwitchChainRef.current = reactSessionSwitchChainRef.current
        .then(async () => {
          const opened = await openSessionById(sessionId, generation);
          if (opened.status === "unavailable" && generation === sessionSelectionGeneration.current) {
            await refreshSessionsRef.current(activeModeRef.current, true, generation);
          }
        })
        .catch(async (error) => {
          if (generation !== sessionSelectionGeneration.current) return;
          console.error("[ChatPage] Failed to switch React session:", error);
          try {
            await refreshSessionsRef.current(activeModeRef.current, true, generation);
          } catch (fallbackError) {
            console.error("[ChatPage] Switch fallback failed:", fallbackError);
          }
        });
    });

    void bootstrapReactSession({
      urlSessionId: new URLSearchParams(window.location.search).get("sessionId"),
      currentMode: activeModeRef.current as ReactSessionMode,
      openSession: openSessionById,
      refreshSessions: async (targetMode, selectCurrent) => {
        await refreshSessions(targetMode as ConversationMode, selectCurrent);
      },
    }).catch((error) => {
      setSessionListErrors((current) => ({ ...current, [initialMode]: true }));
      console.error("[ChatPage] Failed to bootstrap React session:", error);
    }).finally(() => {
        // cold-start 全程完成才标记 bootstrap 完成；只有该标志置位后
        // mode 切换 effect 才会触发 refreshSessions
        setBootstrapCompleted(true);
        if (!disposed) store.notifyReactReady?.();
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const sessionId = activeSessionId;
    const api = aguiApi();
    if (!sessionId || !api?.getInterruptedRun || mode === "chat") {
      setInterruptedRun(null);
      return;
    }
    let active = true;
    void api.getInterruptedRun(sessionId).then((run) => {
      if (active) setInterruptedRun(run ? { runId: run.runId, rounds: run.rounds, todoCount: run.todoCount } : null);
    }).catch(() => { if (active) setInterruptedRun(null); });
    return () => { active = false; };
  }, [activeSessionId, mode]);

  // 计划审阅与批准在 run 结束后发出，必须持久监听。
  // 完成事件由所属 run 控制器校验并处理，不依赖当前会话。
  // 批准后自动发送执行消息（sendMessage 自带 busy 排队机制）。
  useEffect(() => {
    const api = aguiApi();
    if (!api?.onEvent || !shouldListenForDeferredPlanEvents(mode) || !activeSessionId) return;
    const off = api.onEvent((event) => {
      if (event.type !== "CUSTOM" || typeof event.name !== "string") return;
      if (event.name === "firefly.choice") {
        const interaction = normalizeDeferredPlanChoice(event.value, activeSessionId);
        if (interaction) setInteractionForSession(activeSessionId, interaction);
        return;
      }
      if (event.name === "firefly.choice.dismiss") {
        // run 事件闸之外的 dismiss（老版选择卡超时 / run 结束后发出的结算）：
        // 匹配当前 ask 卡时清掉，避免留下点不出结果的僵尸卡。
        setInteractionsBySession((current) => removeSessionInteractionsWhere(
          current,
          activeSessionId,
          (interaction) => interaction.kind === "ask" && shouldDismissAsk(interaction, event.value),
        ));
        return;
      }
      if (!event.name.startsWith("firefly.plan.")) return;
      const value = (event.value ?? null) as { sessionId?: string; planPath?: string; planContent?: string; text?: string } | null;
      if (value?.sessionId && value.sessionId !== activeSessionId) return;
      switch (event.name) {
        case "firefly.plan.review":
          if (value?.sessionId && typeof value.planContent === "string" && value.planContent.trim()) {
            setPlanReviewBySession((current) => ({
              ...current,
              [value.sessionId!]: {
                content: value.planContent!,
                planPath: value.planPath ?? "",
                phase: "review",
              },
            }));
            setPlanDrawerOpen(true);
            setActiveTabId(`plan:${value.sessionId}`);
          }
          break;
        case "firefly.plan.approved":
          if (value?.sessionId) {
            const sessionId = value.sessionId, attemptId = crypto.randomUUID();
            setPlanReviewBySession((current) => current[sessionId]
              ? { ...current, [sessionId]: { ...current[sessionId], phase: "executing", dispatchAttemptId: attemptId } }
              : current);
            const dispatchFailed = () => setPlanReviewBySession(current => {
              const plan = current[sessionId];
              // An earlier approval's failed enqueue must not overwrite a newly
              // reviewed plan or a controller that has already taken execution.
              if (!plan || plan.phase !== "executing" || plan.dispatchAttemptId !== attemptId || plan.executionAssistantId || plan.executionRunId) return current;
              return { ...current, [sessionId]: { ...plan, phase: "failed" } };
            });
            void sendMessage(t("chatPage.planApprovedAutoMessage"), undefined, dispatchFailed).catch(dispatchFailed);
          }
          break;
        case "firefly.plan.supplement":
          // 第二段补充卡提交的文本：作为用户消息发给模型修改计划，改完会重新走审批
          if (value?.sessionId && typeof value.text === "string" && value.text.trim()) {
            void sendMessage(value.text);
          }
          break;
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, activeSessionId]);

  function setInteractionForSession(sessionId: string, interaction: ComposerInteraction): void {
    setInteractionsBySession((current) => setSessionInteraction(current, sessionId, interaction));
  }

  function clearInteractionForSession(sessionId: string, interactionId?: string): void {
    setInteractionsBySession((current) => clearSessionInteraction(current, sessionId, interactionId));
  }

  function setInteractionBusyForSession(sessionId: string, busy: boolean): void {
    setInteractionsBySession((current) => setSessionInteractionBusy(current, sessionId, busy));
  }

  async function selectSession(sessionId: string, targetMode: ConversationMode = mode, expectedGeneration?: number): Promise<SessionSelectionResult> {
    const generation = expectedGeneration ?? ++sessionSelectionGeneration.current;
    if (generation !== sessionSelectionGeneration.current) return "stale";
    const store = chatStore();
    if (!store) return "unavailable";
    const session = await store.get(sessionId);
    if (generation !== sessionSelectionGeneration.current) return "stale";
    if (!session) return "unavailable";
    setActiveSession(session);
    // 环形图快照初始化：session 级（压缩后写入）与消息级（最近 run 留下）取最新。
    setSessionContextUsageBySession((current) => {
      const messageLevel = session.messages.findLast((message) => message.contextUsage)?.contextUsage;
      const sessionLevel = session.currentContextUsage;
      const best = sessionLevel && (!messageLevel || sessionLevel.updatedAt >= messageLevel.updatedAt)
        ? sessionLevel
        : messageLevel;
      if (!best || current[sessionId]?.updatedAt === best.updatedAt) return current;
      return { ...current, [sessionId]: best };
    });
    setActiveSessionIds((current) => {
      const next = { ...current, [targetMode]: sessionId };
      activeSessionIdsRef.current = next;
      return next;
    });
    const uiMessages = toUiMessages(session);
    const latestRunSnapshot = session.messages.findLast((message) => message.runSnapshot)?.runSnapshot;
    if (latestRunSnapshot?.todos) {
      setTodoStateBySession((current) => {
        if (hasActiveRunForSession(activeRunsBySession.current, sessionId) && current[sessionId]) return current;
        return {
          ...current,
          [sessionId]: {
            runId: latestRunSnapshot.runId,
            todos: latestRunSnapshot.todos ?? [],
            updatedAt: latestRunSnapshot.updatedAt,
          },
        };
      });
    }
    hydrateMessages(sessionId, uiMessages, hasActiveRunForSession(activeRunsBySession.current, sessionId));
    setWorkspaceNames((current) => ({
      ...current,
      [targetMode]: session.workspaceBinding?.displayName,
    }));
    if (targetMode === activeModeRef.current) void store.setActiveSession(sessionId, targetMode);
    // 切到会话即对账队列投影，并尝试消费队列/恢复残留认领
    // （页面刷新、进程重启后队列消费的恢复入口；会话忙或队列空时内部直接返回）
    void queueFlow.syncProjection(sessionId);
    void queueFlow.consume(targetMode, sessionId);
    return "selected";
  }

  /**
   * 通过 ref 暴露给 IPC 切换链和初始化 effect；成功切换后同步写回 URL，
   * 不触发页面重新加载。
   */
  async function openSessionById(sessionId: string, generation = ++sessionSelectionGeneration.current): Promise<OpenSessionResult> {
    const isCurrent = () => generation === sessionSelectionGeneration.current;
    const opened = await openSessionByIdWithDeps({
      sessionId,
      isCurrent,
      getSession: async (id) => {
        const store = chatStore();
        if (!store) return null;
        const result = await store.get(id);
        return (result ?? null) as { mode?: string } | null;
      },
      selectSession: (id, targetMode) => selectSession(id, targetMode, generation),
    });
    if (!isCurrent()) return { status: "stale" };
    if (opened.status === "opened") setMode(opened.mode);
    if (opened.status === "opened" && typeof window !== "undefined") {
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("sessionId", sessionId);
        window.history.replaceState(
          null,
          "",
          `${url.pathname}${url.search}${url.hash}`,
        );
      } catch {
        // 忽略 URL 同步失败，不影响会话切换
      }
    }
    return opened;
  }

  async function refreshSessions(targetMode: ConversationMode, selectCurrent: boolean, expectedGeneration?: number) {
    const store = chatStore();
    if (!store) throw new Error("Chat store bridge unavailable");
    const listed = await store.list({ mode: targetMode });
    if (expectedGeneration !== undefined && expectedGeneration !== sessionSelectionGeneration.current) return;
    setSessionListErrors((current) => current[targetMode] ? { ...current, [targetMode]: false } : current);
    // 内容未变时返回原引用：React 对同引用 state 会 bailout，导航/侧栏 memo 不再被重复刷新穿透
    setSessionsByMode((current) => {
      const existing = current[targetMode];
      if (existing && sessionMetaListEqual(existing, listed)) return current;
      return { ...current, [targetMode]: listed };
    });
    if (!selectCurrent) return;
    const currentId = activeSessionIdsRef.current[targetMode];
    const nextId = listed.some((session) => session.id === currentId) ? currentId : listed[0]?.id;
    if (nextId) {
      await selectSession(nextId, targetMode, expectedGeneration);
      return;
    }
    setActiveSessionIds((current) => {
      const next = { ...current };
      delete next[targetMode];
      activeSessionIdsRef.current = next;
      return next;
    });
    setWorkspaceNames((current) => ({ ...current, [targetMode]: undefined }));
    if (targetMode === activeModeRef.current) void store.setActiveSession(null, targetMode);
  }

  // 渲染期间同步安装真实实现，保证 mount effect 不会先观察到默认 no-op。
  refreshSessionsRef.current = refreshSessions;

  /**
   * 模型运行入口：组装运行宿主与共享注册表，交给运行控制器执行。
   * run 结束后的会话列表刷新与待发队列消费在 onRunFinished 中协调。
   */
  async function runModel(input: AgentRunInput) {
    const controller = new AgentRunController(input, {
      api: aguiApi(),
      store: chatStore(),
      host: {
        patchMessage: (sessionId, messageId, patch) => {
          updateMessage(sessionId, messageId, patch);
          if (!patch.toolExecutions) return;
          const id = revealWorkspaceResult.current(sessionId, activeRunsBySession.current[sessionId]?.runId,
            patch.toolExecutions, activeSessionIdsRef.current[activeModeRef.current]);
          if (!id) return;
          setResultTabIds(ids => ids.includes(id) ? ids : [...ids, id]);
          setActiveTabId(id); setTasksTabOpen(true); setInspectorHidden(false);
        },
        setInteraction: setInteractionForSession,
        clearInteraction: clearInteractionForSession,
        bindPlanAttempt: (sessionId, assistantId) => {
          setPlanReviewBySession(current => {
            const plan = current[sessionId];
            if (!plan || (plan.phase !== "executing" && !(plan.phase === "failed" && !plan.executionRunId))) return current;
            if (plan.phase === "executing" && plan.executionAssistantId && plan.executionAssistantId !== assistantId) return current;
            return { ...current, [sessionId]: { ...plan, phase: "executing", executionAssistantId: assistantId } };
          });
        },
        bindPlanRun: (sessionId, runId) => {
          setPlanReviewBySession(current => {
            const plan = current[sessionId];
            if (!plan || plan.phase !== "executing" || plan.executionRunId || plan.executionAssistantId !== input.assistantId) return current;
            return { ...current, [sessionId]: { ...plan, executionRunId: runId } };
          });
        },
        failPlan: (sessionId, runId, phase) => {
          setPlanReviewBySession(current => {
            const plan = current[sessionId];
            if (!plan || plan.executionRunId !== runId || plan.executionAssistantId !== input.assistantId) return current;
            return { ...current, [sessionId]: { ...plan, phase } };
          });
        },
        completePlan: (sessionId, planPath, runId) => {
          setPlanReviewBySession((current) => {
            const plan = current[sessionId];
            if (!plan || plan.phase !== "executing" || plan.planPath !== planPath || plan.executionRunId !== runId) return current;
            return { ...current, [sessionId]: { ...plan, phase: "completed" } };
          });
        },
        dismissAskIfMatched: (sessionId, value) => {
          setInteractionsBySession((current) => removeSessionInteractionsWhere(
            current,
            sessionId,
            (interaction) => interaction.kind === "ask" && shouldDismissAsk(interaction, value),
          ));
        },
        updateTodos: (_sessionId, updater) => setTodoStateBySession((current) => updater(current)),
        updateContextUsage: (sessionId, snapshot) => setSessionContextUsageBySession((current) => ({
          ...current,
          [sessionId]: snapshot,
        })),
        setCompressingContext: (_sessionId, value) => setIsCompressingContext(value),
        setModeBusy: (targetMode, busy) => {
          if (busy) {
            modelBusyByModeRef.current = { ...modelBusyByModeRef.current, [targetMode]: true };
            setModelBusyByMode((current) => ({ ...current, [targetMode]: true }));
          } else {
            const nextBusy = { ...modelBusyByModeRef.current };
            delete nextBusy[targetMode];
            modelBusyByModeRef.current = nextBusy;
            setModelBusyByMode((current) => {
              const next = { ...current };
              delete next[targetMode];
              return next;
            });
          }
        },
        requestTakeover: (sessionId, activeRunId, retry) => setSessionTakeover({ sessionId, activeRunId, retry }),
        clearTakeover: (sessionId) => setSessionTakeover((current) => (current && current.sessionId === sessionId ? null : current)),

        onRunFinished: ({ mode, sessionId, queuePaused }) => {
          setWorkspaceRevisionBySession(current => ({ ...current, [sessionId]: (current[sessionId] ?? 0) + 1 }));
          setRunRegistryVersion((version) => version + 1);
          // 刷新列表与队列投影；queuePaused 时暂停消费（先恢复认领再说），否则消费下一条
          queueFlow.handleRunFinished({ mode, sessionId, queuePaused });
        },
      },
      registries: {
        activeRuns: activeRunsBySession,
        checkpointTriggers: runCheckpointBySessionRef,
        cancelRequestedSessions: cancelRequestedSessionsRef,
        eventUnsubscribers: activeAguiOffsRef,
      },
      startRun: runModel,
    });
    await controller.start();
  }

  function isSessionBusy(sessionId: string): boolean {
    return hasActiveRunForSession(activeRunsBySession.current, sessionId);
  }

  async function restartLastChatTurn(
    expectedUserMessageId: string,
    expectedAssistantMessageId: string,
    disposition: "replace_user" | "keep_user",
    editedContent?: string,
  ): Promise<boolean> {
    if (
      activeModeRef.current !== "chat"
      || modelBusyByModeRef.current.chat
      || lastTurnRevisionStartingRef.current
    ) return false;
    const store = chatStore();
    const sessionId = activeSessionIdsRef.current.chat;
    if (!store || !sessionId) return false;
    lastTurnRevisionStartingRef.current = true;
    setLastTurnRevisionStarting(true);
    try {
      const session = await store.get(sessionId);
      if (!session || session.mode !== "chat") return false;
      const lastTurn = resolveRevisableLastTurn(session.messages, "chat");
      if (
        !lastTurn
        || lastTurn.userMessageId !== expectedUserMessageId
        || lastTurn.assistantMessageId !== expectedAssistantMessageId
      ) return false;

      const nextContent = editedContent === undefined ? undefined : editedContent.trim();
      if (editedContent !== undefined && !nextContent) return false;
      const userIndex = session.messages.length - 2;
      const previousUserMessage = session.messages[userIndex];
      const nextUserMessage: ChatMessage = nextContent === undefined
        ? previousUserMessage
        : {
            ...previousUserMessage,
            content: nextContent,
            at: Date.now(),
          };
      const truncatedSession = await store.replaceTail(sessionId, userIndex, [nextUserMessage]);
      if (!truncatedSession) return false;

      const assistantId = crypto.randomUUID();
      replaceSessionMessages(sessionId, [
        ...toUiMessages(truncatedSession),
        {
          id: assistantId,
          role: "assistant",
          content: "",
          loading: true,
          waitingForFirstEvent: true,
          streaming: false,
          responseStarted: false,
        },
      ]);
      void runModel({
        targetMode: "chat",
        sessionId,
        userMessageId: nextUserMessage.id,
        assistantId,
        session: truncatedSession,
        attachments: (nextUserMessage.attachments ?? []).map((attachment) => ({ ...attachment })),
        // 轨迹回退锚点：主进程据此写 turn_rewind（edit=replace_user / regenerate=keep_user）
        transcriptRewind: { anchorUserTurnId: expectedUserMessageId, disposition },
      });
      return true;
    } catch (error) {
      console.error("[Firefly React] 重建最后一轮对话失败:", error);
      return false;
    } finally {
      lastTurnRevisionStartingRef.current = false;
      setLastTurnRevisionStarting(false);
    }
  }

  async function editLastChatUserMessageImpl(messageId: string, content: string): Promise<boolean> {
    const sessionId = activeSessionIdsRef.current.chat;
    const lastTurn = resolveRevisableLastTurn(sessionId ? (messagesBySessionRef.current[sessionId] ?? []) : [], "chat");
    if (!lastTurn || lastTurn.userMessageId !== messageId) return false;
    return restartLastChatTurn(lastTurn.userMessageId, lastTurn.assistantMessageId, "replace_user", content);
  }

  async function regenerateLastChatResponseImpl(
    userMessageId: string,
    assistantMessageId: string,
  ): Promise<boolean> {
    return restartLastChatTurn(userMessageId, assistantMessageId, "keep_user");
  }

  // 阶段 1B：编辑/重新生成回调稳定化（同 navActionsRef 模式）——ChatMessageList 的 roles
  // 依赖这两个引用，每次渲染新建会连锁重建 roles（全部气泡重渲染）。实现走 ref 取最新闭包。
  const lastTurnActionsRef = useRef({
    editLastChatUserMessage: editLastChatUserMessageImpl,
    regenerateLastChatResponse: regenerateLastChatResponseImpl,
  });
  lastTurnActionsRef.current = {
    editLastChatUserMessage: editLastChatUserMessageImpl,
    regenerateLastChatResponse: regenerateLastChatResponseImpl,
  };
  const editLastChatUserMessage = useCallback(
    async (messageId: string, content: string): Promise<boolean> =>
      lastTurnActionsRef.current.editLastChatUserMessage(messageId, content),
    [],
  );
  const regenerateLastChatResponse = useCallback(
    async (userMessageId: string, assistantMessageId: string): Promise<boolean> =>
      lastTurnActionsRef.current.regenerateLastChatResponse(userMessageId, assistantMessageId),
    [],
  );

  async function ensureSession(targetMode: ConversationMode): Promise<string> {
    const existing = activeSessionIdsRef.current[targetMode];
    if (existing) return existing;
    const store = chatStore();
    if (!store) throw new Error(t("chatPage.errorChatStoreUnavailable"));
    const hasPendingWorkspace = !!pendingWorkspaceByMode[targetMode];
    const temporary = targetMode === "chat" && pendingTemporary;
    let session: ChatSession;
    try {
      session = await store.create({
        identityId: null,
        mode: targetMode,
        title:
          targetMode === "work" || targetMode === "code" || hasPendingWorkspace
            ? t("chatPage.newTaskTitle")
            : t("chatPage.newChatTitle"),
        ...(temporary ? { temporary: true } : {}),
      });
    } catch (error) {
      // 受控记忆模式不托管临时会话：不要悄悄退化成会落盘的普通聊天。
      if (temporary) {
        setPendingTemporary(false);
        throw new Error(t("chatPage.temporaryUnavailable"));
      }
      throw error;
    }
    if (temporary) setPendingTemporary(false);
    await applyPendingModelProfile(store, session.id, targetMode);
    await refreshSessions(targetMode, false);
    await selectSession(session.id, targetMode);
    return session.id;
  }

  /** 欢迎页暂存的模型选择在新会话落地后清除（问题 2：无会话时选择器曾被静默丢弃）。 */
  async function applyPendingModelProfile(store: NonNullable<ReturnType<typeof chatStore>>, sessionId: string, targetMode: ConversationMode) {
    const pendingModelProfileId = pendingModelProfileByMode[targetMode];
    if (!pendingModelProfileId) return;
    await store.setModelProfile(sessionId, pendingModelProfileId);
    setPendingModelProfileByMode((current) => {
      const next = { ...current };
      delete next[targetMode];
      return next;
    });
  }

  async function chooseWorkspace() {
    const targetMode = mode;
    if (targetMode === "chat") return;
    const store = chatStore();
    if (!store) return;
    const picked = await store.pickWorkspaceFolder();
    if (!picked.ok || !picked.path) return;

    await applyWorkspace(targetMode, { path: picked.path, displayName: picked.displayName ?? t("chatPage.defaultWorkspaceName") });
  }

  /** Puts the current (or the next new) task of this mode into a workspace folder. */
  async function applyWorkspace(targetMode: ConversationMode, workspace: { path: string; displayName: string }) {
    const store = chatStore();
    if (!store) return;
    setWorkspaceNames((current) => ({ ...current, [targetMode]: workspace.displayName }));

    const activeId = activeSessionIdsRef.current[targetMode];
    if (activeId) {
      const result = await store.setWorkspace(activeId, workspace.path);
      if (!result.ok) {
        // 长操作失败：错误详情需阅读，用单按钮错误弹窗
        await feedback.alert({
          tone: "error",
          title: t("chatPage.setWorkspaceFailedTitle"),
          message: t("chatPage.setWorkspaceFailed", { error: result.error ?? t("chatPage.unknownError") }),
        });
        return;
      }
      await refreshSessions(targetMode, false);
    } else {
      // 还没有发送第一条消息、未创建 session，先暂存工作区，发消息时一起绑定。
      setPendingWorkspaceByMode((current) => ({ ...current, [targetMode]: workspace }));
    }
  }

  async function createNewTask(workspace?: { path: string; displayName?: string }) {
    const targetMode = mode;
    const store = chatStore();
    if (!store) return;

    setPendingTemporary(false);
    // 点“新建”不真正创建 session，只清空当前模式的状态并回到欢迎页。
    // 工作区保留：如果当前 session 已绑定项目，新任务继续在该项目下创建；
    // 否则沿用之前通过 chooseWorkspace 选好的待绑定目录。
    const activeId = activeSessionIdsRef.current[targetMode];
    const activeSession = activeId ? await store.get(activeId) : null;
    const inheritedWorkspace = workspace ? { path: workspace.path, displayName: workspace.displayName } : activeSession?.workspaceBinding?.workspaceRoot
      ? {
          path: activeSession.workspaceBinding.workspaceRoot,
          displayName: activeSession.workspaceBinding.displayName,
        }
      : pendingWorkspaceByMode[targetMode];

    setActiveSessionIds((current) => {
      const next = { ...current };
      delete next[targetMode];
      activeSessionIdsRef.current = next;
      return next;
    });
    setDrafts((current) => {
      const next = { ...current };
      delete next[`mode:${targetMode}`];
      return next;
    });
    deleteScopeAttachments(`mode:${targetMode}`);
    setPendingWorkspaceByMode((current) => {
      const next = { ...current };
      if (inheritedWorkspace) {
        next[targetMode] = inheritedWorkspace;
      } else {
        delete next[targetMode];
      }
      return next;
    });
    setWorkspaceNames((current) => {
      const next = { ...current };
      if (!inheritedWorkspace) {
        delete next[targetMode];
      } else if (workspace) {
        // A project from the create dialog has no session yet; the composer unlocks on this name.
        next[targetMode] = workspace.displayName ?? t("chatPage.defaultWorkspaceName");
      }
      return next;
    });
    setActivePanel(null);
  }

  /** 新建项目：立即开出绑定该目录的任务，侧栏和环境卡片马上可见；失败时仍按待绑定目录在首条消息时绑定。 */
  async function createProjectTask(workspace: { path: string; displayName?: string }) {
    const targetMode = mode;
    await createNewTask(workspace);
    const store = chatStore();
    if (!store) return;
    let session: ChatSession;
    try {
      session = await store.create({ identityId: null, mode: targetMode, title: t("chatPage.newTaskTitle") });
    } catch {
      return;
    }
    const result = await store.setWorkspace(session.id, workspace.path);
    if (!result.ok) {
      await feedback.alert({
        tone: "error",
        title: t("chatPage.setWorkspaceFailedTitle"),
        message: t("chatPage.setWorkspaceFailed", { error: result.error ?? t("chatPage.unknownError") }),
      });
      return;
    }
    setPendingWorkspaceByMode((current) => {
      const next = { ...current };
      delete next[targetMode];
      return next;
    });
    await applyPendingModelProfile(store, session.id, targetMode);
    await refreshSessions(targetMode, false);
    await selectSession(session.id, targetMode);
  }

  /** 回到欢迎页，下一条消息开出一个不落盘、不进记忆的临时会话（仅 Chat 模式）。 */
  async function startTemporaryChat() {
    if (mode !== "chat") return;
    await createNewTask();
    setPendingTemporary(true);
  }

  async function handleRenameSession(sessionId: string, newTitle: string) {
    const store = chatStore();
    if (!store?.rename) return;
    const title = newTitle.trim();
    if (!title) return;
    await store.rename(sessionId, title);
    await refreshSessionsRef.current(mode, false);
  }

  async function handleDeleteSession(sessionId: string) {
    const store = chatStore();
    if (!store) return;
    const ok = await store.delete(sessionId);
    if (!ok) return;
    await refreshSessionsRef.current(mode, true);
  }

  async function handleTogglePinSession(sessionId: string, pinned: boolean) {
    const store = chatStore();
    if (!store?.setPinned) return;
    await store.setPinned(sessionId, pinned);
    await refreshSessionsRef.current(mode, false);
  }

  async function sendMessage(content: string, resumeFromRunId?: string, onEnqueueFailed?: () => void) {
    const parsedMessage = parseComposerMessage(mode, content);
    const message = parsedMessage.rawContent;
    if (!message) return;

    const userSticker = parsedMessage.userSticker;
    const visibleMessage = parsedMessage.visibleContent;
    const userMessageId = crypto.randomUUID();
    const attachmentsForMessage = attachments.map((attachment) => ({ ...attachment }));
    const targetMode = mode;
    const sessionId = await ensureSession(targetMode);

    // 如果新建任务时已选好工作区但尚未创建 session，在这里一并绑定。
    const pendingWorkspace = pendingWorkspaceByMode[targetMode];
    if (pendingWorkspace) {
      const workspaceResult = await chatStore()?.setWorkspace(sessionId, pendingWorkspace.path);
      if (workspaceResult?.ok) {
        setWorkspaceNames((current) => bindWorkspaceName(
          current,
          targetMode,
          pendingWorkspace.displayName ?? t("chatPage.defaultWorkspaceName"),
        ));
      }
      setPendingWorkspaceByMode((current) => {
        const next = { ...current };
        delete next[targetMode];
        return next;
      });
    }

    // 统一走主进程权威队列：只有入队确认成功后才清草稿和附件（失败保留并提示）。
    // 会话忙时留在队列等 run 结束消费；空闲时立即认领派发——
    // 发送瞬间的并发由主进程 claim 原子性与 SESSION_RUN_ACTIVE 守卫兜底。
    // 入队失败/异常时流程内部复用原稳定标识，重试靠主进程幂等去重不产生重复消息。
    const enqueued = await queueFlow.enqueue(sessionId, targetMode, {
      id: userMessageId,
      rawContent: message,
      visibleContent: visibleMessage,
      attachments: attachmentsForMessage,
      requireDocumentRead: targetMode === "work" && requiredReadsByScope[scopeKey] === true,
      userSticker,
      ...(resumeFromRunId ? { resumeFromRunId } : {}),
    });
    if (!enqueued) { onEnqueueFailed?.(); return; }
    // 请求期间用户继续输入时不清掉新内容：仅当草稿仍是发送时的文本才清空；
    // 附件同样只清随消息发送的那些（空快照不清任何附件），期间新加的保留
    setDrafts((current) => (current[scopeKey] === content ? { ...current, [scopeKey]: "" } : current));
    clearScopeAttachments(attachmentsForMessage);
    setRequiredReadsByScope((current) => ({ ...current, [scopeKey]: false }));
    await queueFlow.consume(targetMode, sessionId);
  }

  /**
   * 外部（语音输入租约）向指定会话提交文本：
   * - 使用提交请求冻结的会话与模式，不读取当前页面状态；
   * - 不清空用户正在编辑的草稿、附件和输入框；
   * - 与手动发送走同一持久队列：入队确认成功（消息已落盘）才返回成功，
   *   绝不能只进页面内存就回执；空闲时随即认领派发，模型运行后台继续。
   */

  async function cancelCurrentRun() {
    const sessionId = activeSessionId;
    if (!sessionId) return;
    const activeRun = activeRunsBySession.current[sessionId];
    if (!activeRun) return;
    updateMessage(activeRun.mode, activeRun.assistantId, {
      streaming: false,
      loading: false,
      waitingForFirstEvent: false,
      responseStarted: false,
    });
    if (!activeRun.runId) {
      cancelRequestedSessionsRef.current.add(sessionId);
      // 首次模型请求尚未返回 ack.runId 时，仍要立即通知主进程。
      // 该窗口内当前窗口只有这一条 active run，桥层会取消它；ack 返回后
      // 仍保留 cancelRequestedSessionsRef 以处理跨进程投递顺序。
      await aguiApi()?.cancel();
      return;
    }
    await aguiApi()?.cancel(activeRun.runId);
  }

  /** 撤回排队消息：主进程按稳定标识删除（已被认领/移除时幂等成功），失败提示且投影不动。 */
  async function removeQueuedMessage(sessionId: string, id: string) {
    const store = chatStore();
    if (!store) return;
    const result = await store.pendingRemove(sessionId, id);
    if (!result.ok) {
      // 简短失败反馈：非阻塞错误轻提示
      feedback.notice({ tone: "error", message: t("chatPage.errorQueueRemoveFailed", { error: result.error ?? t("chatPage.unknownError") }) });
      return;
    }
    await queueFlow.syncProjection(sessionId);
  }

  /** 修改待发文字：保留原条目的附件快照，只更新解析后的正文与表情标记。 */
  async function editQueuedMessage(
    sessionId: string,
    targetMode: ConversationMode,
    id: string,
    content: string,
  ) {
    const parsedMessage = parseComposerMessage(targetMode, content);
    if (!parsedMessage.rawContent) return false;
    return queueFlow.editMessage(sessionId, id, {
      rawContent: parsedMessage.rawContent,
      visibleContent: parsedMessage.visibleContent,
      userSticker: parsedMessage.userSticker,
    });
  }

  /** 运行中把当前草稿排进持久队列（composer 加号按钮）：入队成功才清草稿与附件。 */
  async function queueCurrentDraft(value: string) {
    if (!activeSessionId || !value.trim()) return;
    const sessionId = activeSessionId;
    const parsedMessage = parseComposerMessage(mode, value);
    if (!parsedMessage.rawContent) return;
    const userSticker = parsedMessage.userSticker;
    const visibleContent = parsedMessage.visibleContent;
    const attachmentsForMessage = attachments.map((attachment) => ({ ...attachment }));
    const userMessageId = crypto.randomUUID();
    const enqueued = await queueFlow.enqueue(sessionId, mode, {
      id: userMessageId,
      rawContent: parsedMessage.rawContent,
      visibleContent,
      attachments: attachmentsForMessage,
      requireDocumentRead: mode === "work" && requiredReadsByScope[scopeKey] === true,
      userSticker,
    });
    if (!enqueued) return;
    // 请求期间用户继续输入时不清掉新内容：仅当草稿仍是排队时的文本才清空；
    // 附件同样只清随消息入队的那些（空快照不清任何附件），期间新加的保留
    setDrafts((current) => (current[scopeKey] === value ? { ...current, [scopeKey]: "" } : current));
    clearScopeAttachments(attachmentsForMessage);
    setRequiredReadsByScope((current) => ({ ...current, [scopeKey]: false }));
  }

  const isCurrentScopeRunning = useMemo(
    () => isCurrentRunBusy(activeRunsBySession.current, activeSessionId ?? undefined, Boolean(modelBusyByMode[mode])),
    [activeSessionId, mode, modelBusyByMode, runRegistryVersion],
  );
  const currentPendingQueue = activeSessionId
    ? (pendingQueueBySession[activeSessionId] ?? []).map((item) => ({
      id: item.id,
      content: item.visibleContent || item.rawContent,
      attachmentCount: item.attachments?.length,
    }))
    : [];
  // 工作步骤胶囊：步骤来自 update_todo（firefly.todo → todoStateBySession），文件统计取本轮助手消息的工具变更；
  // 胶囊本身只在运行中且有计划时显示。
  const stepProgress = useMemo(() => {
    const runAssistantId = activeSessionId ? activeRunsBySession.current[activeSessionId]?.assistantId : undefined;
    return buildStepProgressSummary({
      todos: activeSessionId ? todoStateBySession[activeSessionId]?.todos : undefined,
      toolExecutions: messages.find((message) => message.id === runAssistantId)?.toolExecutions,
      running: isCurrentScopeRunning,
    });
  }, [activeSessionId, isCurrentScopeRunning, messages, runRegistryVersion, todoStateBySession]);
  // 上下文容量圆环：session 级快照优先（手动压缩等不产生新消息的操作也即时刷新），
  // 消息级快照兜底兼容旧数据；无快照不渲染。
  const latestContextUsage = (activeSessionId ? sessionContextUsageBySession[activeSessionId] : undefined)
    ?? messages.findLast((message) => message.contextUsage)?.contextUsage;
  const activePlan = mode === "code" && activeSessionId ? planReviewBySession[activeSessionId] : null;

  // ── 右侧面板标签管理 ──
  // 会话隔离：切换会话时清空工作区相关标签，避免把 A 会话的文件带进 B 会话
  useEffect(() => {
    setDiffTabs([]);
    setFileTabs([]);
    setResultTabIds([]);
    setChangesTabIds([]);
    setOutputsTabOpen(false);
    setFilesTabOpen(false);
    setTasksTabOpen(mode !== "chat");
    setInspectorHidden(false);
    setActiveTabId(current => current === "browser" ? "browser" : mode !== "chat" ? "tasks" : null);
  }, [activeSessionId, mode]);

  useBrowserWorkspaceActivation(activeSessionId, () => {
    setBrowserTabOpen(true); setActiveTabId("browser"); setInspectorHidden(false);
  });
  const workspaceOutputs = useMemo(() => collectWorkspaceOutputs(activeSessionId ?? "", messages), [activeSessionId, messages]);
  const refreshRevision = `${workspaceRevisionBySession[activeSessionId ?? ""] ?? 0}:${workspaceFileRevision(activeSessionId ?? "", messages)}`;
  const resultTabs = workspaceOutputs.filter(output => resultTabIds.includes(output.id));
  const changesTabs = workspaceOutputs.filter(output => changesTabIds.includes(output.id));
  const openChangesTab = (output: WorkspaceRunOutput) => {
    if (output.sessionId !== activeSessionId) return;
    setChangesTabIds(ids => ids.includes(output.id) ? ids : [...ids, output.id]);
    setActiveTabId(changesTabId(output.id)); setInspectorHidden(false);
  };
  const outputFiles = useMemo(() => summarizeOutputFiles(workspaceOutputs, activeSession?.workspaceBinding?.workspaceRoot), [workspaceOutputs, activeSession?.workspaceBinding?.workspaceRoot]);
  /** A produced file opens the outputs list first and then its preview beside it, which becomes the active tab. */
  const openOutputFile = (relPath: string) => {
    setOutputsTabOpen(true);
    openFileTab(relPath, undefined, { withTree: false });
  };
  const openResultTab = (id: string) => {
    if (!workspaceOutputs.some(output => output.id === id && output.sessionId === activeSessionId)) return;
    setResultTabIds(ids => ids.includes(id) ? ids : [...ids, id]);
    setActiveTabId(id); setInspectorHidden(false);
  };
  const [focusTask, setFocusTask] = useState<{ taskId: string; seq: number }>();
  // A stable object, so the message list does not re-render when the outputs change; the handler always reads the latest outputs.
  const openDelegationRef = useRef<(taskId: string) => void>(() => undefined);
  openDelegationRef.current = (taskId: string) => {
    const output = workspaceOutputs.find(item => item.sessionId === activeSessionId
      && (item.tasks.some(task => task.taskId === taskId) || item.tools.some(tool => tool.taskResult?.sessionId === taskId)));
    if (!output) return;
    openResultTab(output.id);
    setFocusTask(current => ({ taskId, seq: (current?.seq ?? 0) + 1 }));
  };
  // The overview already knows which run a task belongs to; a resumed agent keeps its taskId across runs.
  const openTaskInRun = (output: WorkspaceRunOutput, taskId: string) => {
    openResultTab(output.id);
    setFocusTask(current => ({ taskId, seq: (current?.seq ?? 0) + 1 }));
  };
  const inspectorActions = useMemo<ChatInspectorActions>(() => ({ openDelegation: (taskId: string) => openDelegationRef.current(taskId) }), []);
  const openResultDiff = (output: WorkspaceRunOutput, file: WorkspaceChangedFile) => {
    if (output.sessionId !== activeSessionId) return;
    const id = `diff:${output.runId}:${file.toolId}:${file.change.file}`;
    const tab = { id, runId: output.runId, fileIndex: 0, filePath: file.change.file, change: file.change };
    setDiffTabs(tabs => tabs.some(item => item.id === id) ? tabs.map(item => item.id === id ? tab : item) : [...tabs, tab]);
    setActiveTabId(id); setInspectorHidden(false);
  };

  /** 打开/激活一个 diff 标签：同 runId + 文件路径已存在则仅激活，不重复开 */
  // 阶段 1B：useCallback 稳定引用——作为 onOpenReviewInspector 进 roles 依赖，每次渲染新建会连锁重建 roles
  const openDiffTab = useCallback((runId: string, fileIndex: number, filePath: string) => {
    setInspectorHidden(false);
    const id = `diff:${runId}:${filePath || `#${fileIndex}`}`;
    setDiffTabs((tabs) =>
      tabs.some((tab) => tab.id === id) ? tabs : [...tabs, { id, runId, fileIndex, filePath }],
    );
    // 点开 diff 时自动带出文件树标签（会话已绑定工作区才有意义）
    if (activeSession?.workspaceBinding) setFilesTabOpen(true);
    setActiveTabId(id);
  }, [activeSession?.workspaceBinding]);

  /** 打开/激活文件树标签 */
  const openFilesTab = () => {
    setInspectorHidden(false);
    setFilesTabOpen(true);
    setActiveTabId("files");
  };

  /** 标题行的面板开关：已打开且可见时关掉它，否则打开。 */
  // The browser closes through the inspector's own path, which revokes its grant and closes the native page first.
  const [browserCloseRequest, setBrowserCloseRequest] = useState(0);
  const togglePanel = (id: string, open: boolean, openIt: () => void) => {
    if (open && !inspectorHidden) {
      if (id === "browser") setBrowserCloseRequest(count => count + 1);
      else closeInspectorTab(id);
    } else openIt();
  };

  /** 收起右侧面板并保留标签；再次点击恢复原标签 */
  const collapseInspector = () => setInspectorHidden(true);

  /** 打开/激活一个文件预览标签：同路径只激活不重开；带行号时更新定位并触发滚动 */
  const fileLineSeqRef = useRef(0);
  // 阶段 1B：useCallback 稳定引用——进 fileLinkEnv 依赖，防止 FileLink 消费者全量更新
  const openFileTab = useCallback((relPath: string, line?: number, options?: { withTree?: boolean }) => {
    setInspectorHidden(false);
    const id = `file:${relPath}`;
    setFileTabs((tabs) => {
      const existing = tabs.some((tab) => tab.id === id);
      if (!existing) {
        return [...tabs, line === undefined ? { id, relPath } : { id, relPath, line, lineSeq: ++fileLineSeqRef.current }];
      }
      // 已打开：带行号则更新定位（lineSeq 变化触发预览重新滚动），不带则清除定位
      return tabs.map((tab) =>
        tab.id === id
          ? line === undefined
            ? { ...tab, line: undefined, lineSeq: undefined }
            : { ...tab, line, lineSeq: ++fileLineSeqRef.current }
          : tab,
      );
    });
    // 文件预览与 diff 一样：打开时自动带出文件树标签（从产出列表打开时，产出列表已经代替了文件树）
    if (activeSession?.workspaceBinding && options?.withTree !== false) setFilesTabOpen(true);
    setActiveTabId(id);
  }, [activeSession?.workspaceBinding]);

  /** 计划标签 ID：会话内唯一（计划内容始终跟随当前会话） */
  const planTabId = `plan:${activeSessionId ?? "session"}`;

  /** 右侧面板标签的固定顺序：文件树 → 文件预览 → Diff → 计划 */
  const inspectorTabIds = [
    ...(tasksTabOpen ? ["tasks"] : []),
    ...(filesTabOpen ? ["files"] : []),
    ...(outputsTabOpen ? ["outputs"] : []),
    ...fileTabs.map((tab) => tab.id),
    ...diffTabs.map((tab) => tab.id),
    ...resultTabs.map((tab) => tab.id),
    ...changesTabs.map((tab) => changesTabId(tab.id)),
    ...((activePlan !== null && planDrawerOpen) ? [planTabId] : []),
    ...(browserTabOpen ? ["browser"] : []),
  ];

  /** 关闭右侧面板标签：活动标签关闭后回退到相邻标签（优先左侧） */
  const closeInspectorTab = (id: string) => {
    const index = inspectorTabIds.indexOf(id);
    if (index < 0) return;
    const remaining = inspectorTabIds.filter((tabId) => tabId !== id);
    if (id === "browser") {
      setBrowserTabOpen(false);
    } else if (id === "tasks") {
      setTasksTabOpen(false);
    } else if (id === "files") {
      setFilesTabOpen(false);
    } else if (id === "outputs") {
      setOutputsTabOpen(false);
    } else if (id.startsWith("file:")) {
      setFileTabs((tabs) => tabs.filter((tab) => tab.id !== id));
    } else if (id.startsWith("results:")) {
      setResultTabIds(ids => ids.filter(item => item !== id));
    } else if (id.startsWith(CHANGES_TAB_PREFIX)) {
      setChangesTabIds(ids => ids.filter(item => changesTabId(item) !== id));
    } else if (id.startsWith("plan:")) {
      setPlanDrawerOpen(false);
    } else {
      setDiffTabs((tabs) => tabs.filter((tab) => tab.id !== id));
    }
    if (activeTabId === id) {
      setActiveTabId(remaining[index - 1] ?? remaining[index] ?? null);
    }
  };

  // Closing the last tab keeps the dock mounted while it collapses like a hidden pane, instead of vanishing in one frame.
  const dockPresence = usePresence(inspectorTabIds.length > 0, DOCK_EXIT_MS);
  const inspectorVisible = !activePanel && !inspectorHidden && !dockPresence.leaving;
  const { panelRef: inspectorPanelRef, onLayoutChange: onInspectorLayoutChange } = useInspectorPanelVisibility(inspectorVisible, dockGroupRef, `${inspectorTabIds.length}:${compactDock}`);
  // Whatever opens or closes the pane (its toggle, the last tab closing, a feature page taking over), the dock carries the
  // motion flag for the width transition. The pane body has its own flag, but it renders nothing once no tab is left.
  // Set in a layout effect so it is in place before the collapse/expand effect runs.
  const lastInspectorVisible = useRef(inspectorVisible);
  useLayoutEffect(() => {
    if (lastInspectorVisible.current === inspectorVisible) return;
    lastInspectorVisible.current = inspectorVisible;
    const dock = dockRef.current;
    if (!dock || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    dock.setAttribute("data-dock-motion", "");
    const settle = setTimeout(() => dock.removeAttribute("data-dock-motion"), DOCK_EXIT_MS);
    return () => clearTimeout(settle);
  }, [inspectorVisible]);

  // The conversation keeps a readable width: the dock separator cannot squeeze it below this, and it grows by the
  // overview card column (272px + its 8px inset) while that column is shown.
  const chatCardsShown = overviewTabOpen && !activePanel;
  // The overview cards slide in and out instead of popping; they stay mounted while they slide out.
  const cardsPresence = usePresence(overviewTabOpen, CARDS_EXIT_MS);
  // On a narrow page the right panel keeps its own 280px minimum, so the conversation yields first.
  const chatMinWidth = Math.min(CHAT_MIN_WIDTH + (chatCardsShown ? CHAT_CARDS_WIDTH : 0),
    dockWidth > 0 ? Math.max(300, dockWidth - INSPECTOR_MIN_WIDTH - 12) : Number.POSITIVE_INFINITY);

  const inspectorPanelCount = inspectorTabIds.length;
  const lastInspectorPanelCount = useRef(inspectorPanelCount);
  // Panels sit side by side, so the right dock widens to give each opened panel room, up to 70% of the page and never into
  // the conversation's minimum width. Closing one of several panels gives its share back: the dock narrows by that panel's
  // part of its width, never below the pane minimum. The resize is programmatic, so it is not saved as the user's own drag width.
  useEffect(() => {
    const previousCount = lastInspectorPanelCount.current;
    if (compactDock || !inspectorVisible || inspectorPanelCount === 0) { lastInspectorPanelCount.current = inspectorPanelCount; return; }
    const frame = requestAnimationFrame(() => {
      // Recorded once the frame runs, so an effect that is cleaned up and re-run still sees the count it changed from.
      lastInspectorPanelCount.current = inspectorPanelCount;
      const panel = inspectorPanelRef.current;
      const dockWidth = dockRef.current?.offsetWidth ?? 0;
      // A panel the user collapsed with the separator stays collapsed.
      if (!panel || dockWidth === 0 || panel.isCollapsed()) return;
      const current = panel.getSize().inPixels;
      const closed = inspectorPanelCount < previousCount;
      const wanted = closed
        ? Math.max(INSPECTOR_MIN_WIDTH, current * inspectorPanelCount / previousCount)
        : Math.min(inspectorPanelCount * 360, dockWidth * 0.7, dockWidth - chatMinWidth - 12);
      if (closed ? current <= wanted + 1 : current >= wanted - 1) return;
      // Resize with the same 220ms width motion as opening and closing the pane, instead of jumping in one frame.
      const dock = dockRef.current;
      dock?.setAttribute("data-dock-motion", "");
      panel.resize(Math.round(wanted));
      settle = setTimeout(() => { settle = undefined; dock?.removeAttribute("data-dock-motion"); }, DOCK_WIDEN_MS);
    });
    let settle: ReturnType<typeof setTimeout> | undefined;
    // Only take the flag down if this resize put it up; an open or close in the same commit has set its own.
    return () => { cancelAnimationFrame(frame); if (settle) { clearTimeout(settle); dockRef.current?.removeAttribute("data-dock-motion"); } };
  }, [inspectorPanelCount, inspectorVisible, compactDock, inspectorPanelRef, chatMinWidth]);

  // Sessions with a run in flight, for the sidebar spinner. The registry is a ref: a run starting flips the busy state,
  // a run finishing bumps the registry version, and either recomputes the list.
  const needsInputSessionIds = useMemo(() => sessionsNeedingInput(interactionsBySession, planReviewBySession), [interactionsBySession, planReviewBySession]);
  const runningSessionIds = useMemo(() => Object.keys(activeRunsBySession.current), [runRegistryVersion, modelBusyByMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 阶段 1A：导航 props 引用稳定化 ──
  // 下方 6 个动作函数读取大量页面状态、内部调用链每次渲染都产生新引用，
  // 属"需读最新状态且引用不能变"的场景：用 ref 转发当次渲染的最新实现，
  // 外层回调引用恒定，配合 React.memo 让导航/侧栏子树在流式期间保持命中。
  const navActionsRef = useRef<NavActions>({
    createNewTask: () => Promise.resolve(),
    createProjectTask: () => Promise.resolve(),
    startTemporaryChat: () => Promise.resolve(),
    selectSession: () => Promise.resolve("unavailable"),
    handleRenameSession: () => Promise.resolve(),
    handleDeleteSession: () => Promise.resolve(),
    handleTogglePinSession: () => Promise.resolve(),
    openProject: () => undefined,
  });
  // 渲染期同步最新实现（函数声明在组件体内提升，此处可安全引用）
  navActionsRef.current = {
    createNewTask,
    createProjectTask,
    startTemporaryChat,
    selectSession,
    handleRenameSession,
    handleDeleteSession,
    handleTogglePinSession,
    openProject: (workspaceRoot) => {
      void chatStore()?.openWorkspace(workspaceRoot).then((result) => {
        // 简短失败反馈：非阻塞错误轻提示
        if (!result.ok) feedback.notice({ tone: "error", message: t("chatPage.openProjectFolderFailed", { error: result.error ?? t("chatPage.unknownError") }) });
      });
    },
  };

  const navToggleCollapsed = useCallback(() => setCollapsed((value) => !value), []);
  const navModeChange = useCallback((nextMode: string) => {
    if (isConversationMode(nextMode)) {
      sessionSelectionGeneration.current++;
      setPendingTemporary(false);
      setMode(nextMode);
    }
  }, []);
  const navNewTask = useCallback(() => {
    void navActionsRef.current.createNewTask();
  }, []);
  const navNewProjectTask = useCallback((path: string, displayName?: string) => {
    void navActionsRef.current.createProjectTask({ path, displayName });
  }, []);
  const navNewTemporaryChat = useCallback(() => {
    void navActionsRef.current.startTemporaryChat();
  }, []);
  const navTogglePanel = useCallback((panel: ChatPagePanel) => {
    setActivePanel((current) => current === panel ? null : panel);
  }, []);
  const navSelectSession = useCallback((sessionId: string) => {
    setActivePanel(null);
    setPendingTemporary(false);
    void navActionsRef.current.selectSession(sessionId);
  }, []);
  const navOpenProject = useCallback((workspaceRoot: string) => {
    navActionsRef.current.openProject(workspaceRoot);
  }, []);
  const navRenameSession = useCallback((sessionId: string, newTitle: string) => {
    void navActionsRef.current.handleRenameSession(sessionId, newTitle);
  }, []);
  const navDeleteSession = useCallback((sessionId: string) => {
    void navActionsRef.current.handleDeleteSession(sessionId);
  }, []);
  const navTogglePinSession = useCallback((sessionId: string, pinned: boolean) => {
    void navActionsRef.current.handleTogglePinSession(sessionId, pinned);
  }, []);
  const navExportSession = useCallback((sessionId: string) => {
    void chatStore()?.exportWorkMarkdown(sessionId).then((result) => {
      if (result && !result.ok && !result.canceled) {
        feedback.notice({ tone: "error", message: t("sidebar.exportFailed") });
      }
    });
  }, [feedback, t]);
  // Back / forward through the conversations and panels already visited.
  const navHistory = useNavigationHistory({
    current: { mode, sessionId: activeSessionId, panel: activePanel },
    go: (location) => {
      setActivePanel((location.panel as ChatPagePanel | null) ?? null);
      // The place may be in another mode: show that mode first, then (for a conversation) open it there.
      if (location.mode !== mode) navModeChange(location.mode);
      if (location.panel === null && location.sessionId) {
        setPendingTemporary(false);
        void navActionsRef.current.selectSession(location.sessionId, location.mode as ConversationMode);
      }
    },
    isAvailable: (location) => location.panel !== null || (sessionsByMode[location.mode as ConversationMode] ?? []).some(session => session.id === location.sessionId),
  });
  // One stable object: the navigation is memoised, so a fresh one per render would re-render it on every streamed token.
  const navHistoryProp = useMemo(
    () => ({ canBack: navHistory.canBack, canForward: navHistory.canForward, onBack: navHistory.back, onForward: navHistory.forward }),
    [navHistory.canBack, navHistory.canForward, navHistory.back, navHistory.forward],
  );
  const navMinimize = useCallback(() => window.chat?.minimize(), []);
  useMaximizedWindowDrag();
  const navMaximize = useCallback(() => window.chat?.toggleMaximize(), []);
  const navCloseWindow = useCallback(() => window.chat?.close(), []);
  const navOpenSettings = useCallback(() => sidebarApi()?.openSettings("general"), []);
  const navOpenApiSettings = useCallback(() => sidebarApi()?.openSettings("api"), []);
  const activeSessionTitle = sessions.find(session => session.id === activeSessionId)?.title
    || (activeSession && activeSession.id === activeSessionId ? activeSession.title : "")
    || t("chatPage.newTaskTitle");
  const selectedModelProfileId = activeSession?.id === activeSessionId && activeSession
    ? activeSession.modelProfileId : pendingModelProfileByMode[mode];

  return (
    <div className={`ff-page ${collapsed ? "is-collapsed" : ""}`}>
      <ChatPageNavigation
        collapsed={collapsed}
        runningSessionIds={runningSessionIds}
        needsInputSessionIds={needsInputSessionIds}
        activePanel={activePanel}
        onPanelSlot={setPanelSlot}
        navHistory={navHistoryProp}
        mode={mode}
        sessions={sessions}
        sessionListStatus={sessionListErrors[mode] ? "error" : sessionsByMode[mode] === undefined ? "loading" : "ready"}
        activeSessionId={activeSessionId}
        activeModelProfileId={selectedModelProfileId}
        onToggleCollapsed={navToggleCollapsed}
        onModeChange={navModeChange}
        onNewTask={navNewTask}
        onNewProjectTask={navNewProjectTask}
        onNewTemporaryChat={navNewTemporaryChat}
        onTogglePanel={navTogglePanel}
        onSelectSession={navSelectSession}
        onOpenProject={navOpenProject}
        onRenameSession={navRenameSession}
        onDeleteSession={navDeleteSession}
        onTogglePinSession={navTogglePinSession}
        onExportSession={navExportSession}
        onMinimize={navMinimize}
        onMaximize={navMaximize}
        onCloseWindow={navCloseWindow}
        onOpenSettings={navOpenSettings}
        onOpenApiSettings={navOpenApiSettings}
      />
      {/* 右栏可拖宽布局：聊天区 Panel 常驻（保证内容不重挂载），右侧面板按需挂载 */}
      <Group
        elementRef={dockRef}
        groupRef={dockGroupRef}
        orientation={compactDock ? "vertical" : "horizontal"}
        className={`ff-page-dock ${compactDock ? "is-compact" : ""}${inspectorTabIds.length > 0 && inspectorVisible && !compactDock && !inspectorCollapsed ? " has-inspector" : ""}`}
        defaultLayout={compactDock ? undefined : defaultLayout}
        onLayoutChange={layout => { onInspectorLayoutChange(layout); setInspectorCollapsed(Object.hasOwn(layout, "inspector") && layout.inspector < 0.5); }}
        onLayoutChanged={compactDock ? undefined : onLayoutChanged}
        // 拖动条命中区外溢到两侧（视觉条只有 12px，命中区鼠标 24px / 触屏 33px）
        resizeTargetMinimumSize={{ coarse: 33, fine: 24 }}
      >
        <Panel id="chat" minSize={compactDock ? "60%" : chatMinWidth} className="ff-dock-body">
      <main
        className={`ff-page-main ff-workspace ${hasMessages ? "has-messages" : "is-empty"} ${isDraggingFiles ? "is-dragging-files" : ""}`}
        onDragEnter={dragHandlers.onDragEnter}
        onDragOver={dragHandlers.onDragOver}
        onDragLeave={dragHandlers.onDragLeave}
        onDrop={dragHandlers.onDrop}
      >
        <FileDropOverlay visible={isDraggingFiles} />
        {/* 标题与工具独立占一行，正文和输入区不再用空白避让浮动按钮。 */}
        {!activePanel && (
          <header className="ff-workspace-header">
            <h1 className="ff-workspace-header__title" title={activeSessionTitle}>{activeSessionTitle}</h1>
            <div className="ff-workspace-header__actions">
              {activeSession?.workspaceBinding && activeSessionId && (
                <>
                  <OpenWorkspaceMenu sessionId={activeSessionId} />
                  <span className="ff-inspector-toggle-divider" aria-hidden="true" />
                </>
              )}
              {/* 面板开关：打开时按下高亮，再点一次关掉对应面板（面板本身在右侧一列里上下叠放）。 */}
              <button type="button" className="ff-inspector-toggle" aria-label={t("browserWorkspace.open")}
                title={t("browserWorkspace.open")} aria-expanded={browserTabOpen && !inspectorHidden} aria-pressed={browserTabOpen && !inspectorHidden}
                onClick={() => togglePanel("browser", browserTabOpen, () => { setBrowserTabOpen(true); setInspectorHidden(false); setActiveTabId("browser"); })}>
                <GlobalOutlined aria-hidden="true" />
              </button>
              <button type="button" className="ff-inspector-toggle" aria-label={t("fileTree.title")}
                title={t("fileTree.title")} aria-expanded={filesTabOpen && !inspectorHidden} aria-pressed={filesTabOpen && !inspectorHidden}
                onClick={() => togglePanel("files", filesTabOpen, openFilesTab)}><FolderOpenOutlined aria-hidden="true" /></button>
              <button type="button" className="ff-inspector-toggle"
                aria-label={t("sessionOverview.open")} title={t("sessionOverview.open")}
                aria-expanded={overviewTabOpen} aria-pressed={overviewTabOpen}
                onClick={() => setOverviewTabOpen(open => !open)}>
                <ProfileOutlined aria-hidden="true" /></button>
              {(mode !== "chat" || workspaceOutputs.length > 0) && <button type="button" className="ff-inspector-toggle"
                aria-label={t("workspace.tasks")} title={t("workspace.tasks")}
                aria-expanded={tasksTabOpen && !inspectorHidden} aria-pressed={tasksTabOpen && !inspectorHidden}
                onClick={() => togglePanel("tasks", tasksTabOpen, () => { setTasksTabOpen(true); setInspectorHidden(false); setActiveTabId("tasks"); })}>
                <UnorderedListOutlined aria-hidden="true" /></button>}
              <InspectorToggle
                open={inspectorTabIds.length > 0 && !inspectorHidden}
                onToggle={() => {
                  if (inspectorTabIds.length > 0 && !inspectorHidden) collapseInspector();
                  else if (inspectorTabIds.length > 0) setInspectorHidden(false);
                  else openFilesTab();
                }}
              />
            </div>
          </header>
        )}
        {activePanel ? (
          <PanelSidebarSlotContext.Provider value={panelSlot}><ChatPagePanelHost panel={activePanel} /></PanelSidebarSlotContext.Provider>
        ) : (
        <div className="ff-workspace-body">
        {/* The rain spans the dialog and the overview cards, so it shows through the gaps around the floating cards. */}
        {!hasMessages && <CodeRain />}
        <div className="ff-workspace-content">
        <RunRecoveryNotices
          interruptedRun={interruptedRun}
          sessionTakeover={sessionTakeover}
          activeSessionId={activeSessionId}
          isRunning={isCurrentScopeRunning}
          onResume={(runId) => void sendMessage(t("chatPage.resumeLastTaskMessage"), runId)}
          onTakeover={() => {
            const takeover = sessionTakeover;
            if (!takeover) return;
            setSessionTakeover(null);
            void takeover.retry();
          }}
        />
        {hasMessages && (
          <ChatInspectorActionsContext.Provider value={inspectorActions}>
          <ChatMessageList
            messages={messages}
            conversationId={activeSessionId}
            mode={mode}
            preferredAddress={preferredAddress}
            stickerSize={stickerSize}
            revisionBusy={Boolean(modelBusyByMode[mode]) || lastTurnRevisionStarting}
            onEditLastUserMessage={mode === "chat" ? editLastChatUserMessage : undefined}
            onRegenerateLastResponse={mode === "chat" ? regenerateLastChatResponse : undefined}

            onScrollToBottomVisibilityChange={setScrollToBottomVisible}
            onRegisterScrollToBottom={registerScrollToBottom}
            onOpenReviewInspector={openDiffTab}
            workspaceRoot={activeSession?.workspaceBinding?.workspaceRoot}
            onOpenFileLink={openFileTab}
          />
          </ChatInspectorActionsContext.Provider>
        )}
        <ContextCompressionNotice visible={isCompressingContext} />
        {!hasMessages && <div className="ff-workspace-greeting">
          <h2 className="ff-workspace-greeting__title">{t(mode === "chat" ? "chatPage.emptyGreeting" : "chatPage.emptyGreetingTask")}</h2>
          <p className="ff-workspace-greeting__hint">{t(`chatPage.emptyHint.${mode}`)}</p>
        </div>}
        {mode === "chat" && (pendingTemporary || activeSession?.temporary === true) && (
          <p className="ff-temporary-chat-banner" role="status">
            <MessageSquareDashed size={14} strokeWidth={1.8} aria-hidden="true" />
            {t("chatPage.temporaryBanner")}
          </p>
        )}
        <div className="ff-workspace-composer">
          {scrollToBottomVisible && (
            <button
              type="button"
              className="ff-workspace-composer__scroll-to-bottom"
              onClick={() => scrollToBottomRef.current()}
              aria-label={t("chatPage.scrollToBottom")}
              title={t("chatPage.scrollToBottom")}
            >
              <DownOutlined />
            </button>
          )}
          <FloatingComposer floating={hasMessages} attention={Boolean(composerInteraction)}>
          <ComposerSlot
            composer={<ChatComposer
            value={draft}
            mode={mode}
            docked={hasMessages}
            onNewTask={navNewTask}
            onNotice={(message, tone) => feedback.notice({ tone, message })}
            conversationId={activeSessionId ?? undefined}
            workspaceName={workspaceNames[mode]}
            workspaceRoot={activeSession?.workspaceBinding?.workspaceRoot}
            attachments={attachments}
            requireDocumentRead={requiredReadsByScope[scopeKey] === true}
            onRequireDocumentReadChange={(value) => setRequiredReadsByScope((current) => ({ ...current, [scopeKey]: value }))}
            attachmentBusy={attachmentBusy}
            modelBusy={isCurrentScopeRunning}
            pendingQueue={currentPendingQueue}
            onChange={(value) => setDrafts((current) => ({ ...current, [scopeKey]: value }))}
            onSubmit={(value) => void sendMessage(value)}
            onCancel={() => void cancelCurrentRun()}
            onQueueMessage={(value) => void queueCurrentDraft(value)}
            onRemoveQueuedMessage={(id) => activeSessionId && void removeQueuedMessage(activeSessionId, id)}
            onEditQueuedMessage={(id, content) => activeSessionId
              ? editQueuedMessage(activeSessionId, mode, id, content)
              : Promise.resolve(false)}
            onAdjustQueuedMessage={(id) => activeSessionId
              ? queueFlow.adjustMessage(activeSessionId, id)
              : Promise.resolve(false)}
            onChooseWorkspace={() => void chooseWorkspace()}
            onChooseFiles={(files) => void chooseFiles(files)}
            onRemoveAttachment={removeAttachment}
            onScreenshot={() => void handleScreenshot()}
            onPasteImage={(file) => void handlePastedImage(file)}
            onChooseSticker={(id) => {
              const separator = draft && !draft.endsWith(" ") ? " " : "";
              setDrafts((current) => ({ ...current, [scopeKey]: `${draft}${separator}[sticker:${id}]` }));
            }}
            activeModelProfileId={selectedModelProfileId}
            contextUsage={latestContextUsage}
            stepProgress={stepProgress}
            onSelectModelProfile={(modelProfileId) => {
              // 欢迎页（无会话）：暂存选择，ensureSession 建会话后落地；不再静默丢弃。
              if (!activeSessionId) {
                setPendingModelProfileByMode((current) => ({ ...current, [mode]: modelProfileId }));
                return;
              }
              const store = chatStore();
              if (!store) return;
              void store.setModelProfile(activeSessionId, modelProfileId).then((session) => setActiveSession(session));
            }}
            />}
            interaction={composerInteraction}
            interactionBusy={interactionBusy}
            interactionPending={interactionPending}
            onAnswer={(id, answer) => {
              if (!activeSessionId) return;
              const choice = choiceApi();
              if (!choice) return;
              setInteractionBusyForSession(activeSessionId, true);
              void choice.resolve(id, answer).then((result) => {
                // ok:false = pending 已在主进程被结算（超时/取消等）：卡片不可能再提交成功，直接清掉，
                // 避免留下一张点多少次都没反应的僵尸卡。
                if (result.ok) {
                  runCheckpointBySessionRef.current[activeSessionId]?.("running");
                }
                clearInteractionForSession(activeSessionId, id);
                setInteractionBusyForSession(activeSessionId, false);
              }).catch(() => setInteractionBusyForSession(activeSessionId, false));
            }}
            onIgnore={(id) => {
              if (!activeSessionId) return;
              const choice = choiceApi();
              if (!choice) return;
              setInteractionBusyForSession(activeSessionId, true);
              void choice.resolve(id, "").then((result) => {
                // 同 onAnswer：ok:false 说明 pending 已被主进程结算，卡片清掉不留僵尸。
                if (result.ok) {
                  runCheckpointBySessionRef.current[activeSessionId]?.("running");
                }
                clearInteractionForSession(activeSessionId, id);
                setInteractionBusyForSession(activeSessionId, false);
              }).catch(() => setInteractionBusyForSession(activeSessionId, false));
            }}
            onPermissionDecision={(id, allowed) => {
              if (!activeSessionId) return;
              const settings = settingsApprovalApi();
              if (!settings) return;
              setInteractionBusyForSession(activeSessionId, true);
              void settings.resolvePermissionApproval(id, allowed).then((result) => {
                // ok:false = pending 已在主进程被结算（run 取消等）：卡片不可能再提交成功，直接清掉，
                // 避免留下一张点多少次都没反应的僵尸卡。
                if (result.ok) {
                  runCheckpointBySessionRef.current[activeSessionId]?.("running");
                }
                clearInteractionForSession(activeSessionId, id);
                setInteractionBusyForSession(activeSessionId, false);
              }).catch(() => setInteractionBusyForSession(activeSessionId, false));
            }}
            onQuizSubmit={(submission) => {
              const settings = settingsApprovalApi();
              if (!settings) return Promise.resolve({ ok: false, error: "E_QUIZ_NO_BRIDGE" });
              // 展示态切换由卡片组件处理，这里只透传判分结果
              return settings.resolvePopQuiz(submission).then((result) => {
                // 判分后的抽查卡留在屏上等 run 终态收卡，但不能再挡住之后到达的审批和提问。
                if (result.ok) setInteractionsBySession((current) => markInteractionResolved(current, "quiz", submission.quizId));
                return result;
              });
            }}
            onQuizSkip={(quizId) => {
              const settings = settingsApprovalApi();
              if (!settings) return Promise.resolve({ ok: false, error: "E_QUIZ_NO_BRIDGE" });
              return settings.skipPopQuiz(quizId);
            }}
          />
          </FloatingComposer>
        </div>
        </div>
        {/* The overview cards live in the conversation panel, on the outer side of the dialog. */}
        {cardsPresence.mounted && (
          <aside className={`ff-chat-cards${cardsPresence.leaving ? " is-leaving" : ""}`} aria-label={t("sessionOverview.title")} inert={cardsPresence.leaving || undefined}>
            <SessionOverviewPanel usage={latestContextUsage} outputs={workspaceOutputs} onOpenChange={openResultDiff} onOpenTask={openTaskInRun}
              environment={{ mode, workspaceName: activeSession?.workspaceBinding?.displayName, temporary: activeSession?.temporary }}
              onOpenEnvironment={activeSession?.workspaceBinding ? openFilesTab : mode !== "chat" ? () => void chooseWorkspace() : undefined}
              onOpenConnectors={() => sidebarApi()?.openSettings("mcp")}
              onOpenMemoryGraph={() => sidebarApi()?.openSettings("memory-graph")}
              onOpenOutputFile={openOutputFile} workspaceRoot={activeSession?.workspaceBinding?.workspaceRoot}
              sessionId={activeSessionId} busy={isCurrentScopeRunning} />
          </aside>
        )}
        </div>
        )}
      </main>
        </Panel>
        {/* 右侧面板打开时才挂载 Panel + 拖动条；默认 40% 宽，最小 280px，最大 70% */}
        {dockPresence.mounted && (
          <>
            {inspectorVisible && <Separator className="ff-dock-separator" onKeyDown={event => {
              if (compactDock || !event.defaultPrevented
                || !["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key)) return;
              // v4 defers onLayoutChanged while a document pointer is active, even
              // after a cancelled sidebar drag. Its native separator key handler
              // has already committed the layout before this React bubble handler.
              // Persist only that explicit keyboard action, never mount/expand.
              const layout = dockGroupRef.current?.getLayout();
              if (layout && Object.hasOwn(layout, "inspector")) onLayoutChanged(layout, { isUserInteraction: true });
            }} />}
            <Panel id="inspector" panelRef={inspectorPanelRef} collapsible collapsedSize={0} defaultSize={compactDock ? "30%" : "40%"} minSize={compactDock ? "15%" : INSPECTOR_MIN_WIDTH} maxSize={compactDock ? "40%" : "70%"} className="ff-dock-body">
              <ChatPageInspector
                sessionId={activeSessionId}
                visible={inspectorVisible}
                refreshRevision={refreshRevision}
                resultTabs={resultTabs}
                runNumberOf={output => workspaceOutputs.indexOf(output) + 1}
                changesTabs={changesTabs}
                onOpenChanges={openChangesTab}
                focusTask={focusTask}
                onOpenResultDiff={openResultDiff}
                workspaceRoot={activeSession?.workspaceBinding?.workspaceRoot}
                filesTabOpen={filesTabOpen}
                outputFiles={outputsTabOpen ? outputFiles : undefined}
                browserCloseRequest={browserCloseRequest}
                browserTabOpen={browserTabOpen}
                tasksTabOpen={tasksTabOpen}
                onOpenFilesTab={openFilesTab}
                onOpenTasksTab={mode !== "chat" || workspaceOutputs.length > 0
                  ? () => { setTasksTabOpen(true); setInspectorHidden(false); setActiveTabId("tasks"); } : undefined}
                onOpenOverviewTab={() => setOverviewTabOpen(true)}
                pendingWorkspaceName={pendingWorkspaceByMode[mode]?.displayName}
                onChooseWorkspace={mode !== "chat" ? () => void chooseWorkspace() : undefined}
                taskPanel={<div className="ff-workspace-task-panel">{mode === "work"
                  ? null
                  : mode === "code" && activeSessionId
                    ? <CodeGitPanel docked expanded sessionId={activeSessionId} projectName={workspaceNames.code}
                        todoState={todoStateBySession[activeSessionId] ?? null}
                        planPhase={planReviewBySession[activeSessionId]?.phase}
                        onOpenPlan={() => { setPlanDrawerOpen(true); setActiveTabId(planTabId); }} />
                    : <div className="ff-workspace-empty"><p>{t("workspace.chooseProject")}</p>
                        {mode !== "chat" && <button type="button" onClick={() => void chooseWorkspace()}>{t("workspace.chooseFolder")}</button>}</div>}
                  <WorkspaceResultsIndex outputs={workspaceOutputs} workspaceRoot={activeSession?.workspaceBinding?.workspaceRoot}
                    onOpenFile={openFileTab} onOpenDiff={openResultDiff} onOpenChanges={openChangesTab} />
                </div>}
                fileTabs={fileTabs}
                diffTabs={diffTabs}
                activePlan={activePlan}
                planDrawerOpen={planDrawerOpen}
                planTabId={planTabId}
                activeTabId={activeTabId}
                onTabChange={setActiveTabId}
                onCloseTab={closeInspectorTab}
                onOpenFile={openFileTab}
              />
            </Panel>
          </>
        )}
      </Group>
    </div>
  );
}
