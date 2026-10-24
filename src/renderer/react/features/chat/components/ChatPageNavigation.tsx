import React, { useEffect, useRef, useState } from "react";
import { MessageCircleDashed, Search } from "lucide-react";
import { useTranslation } from "../../../i18n";
import type { ChatSessionMeta, ConversationMode } from "../../../../../shared/chat-types";
import { ModeMenu } from "../../../components/ui/ModeMenu";
import { NewTaskButton } from "../../../components/ui/NewTaskButton";
import { resolveAsset } from "../../../../../shared/renderer-base";
import { NavigationArrows } from "../../../components/ui/NavigationArrows";
import { SidebarToggle } from "../../../components/ui/SidebarToggle";
import { WindowControls } from "../../../components/ui/WindowControls";
import { AppUpdateEntry } from "./AppUpdateEntry";
import { ConversationSidebar } from "./ConversationSidebar";
import { SidebarSearchDialog } from "./SidebarSearchDialog";
import { ActivityRail } from "./ActivityRail";
import { ModelConnectionIndicator } from "./ModelConnectionIndicator";
import { useSidebarWidth } from "../pages/useSidebarWidth";
import { useSidebarFold } from "./use-sidebar-fold";
import { reportChatPerfRender } from "./chat-perf-probe";

export type ChatPagePanel = "tool" | "skill" | "model" | "plugin" | "scheduled";

export interface ChatPageNavigationProps {
  collapsed: boolean;
  activePanel: ChatPagePanel | null;
  mode: ConversationMode;
  sessions: ChatSessionMeta[];
  sessionListStatus: "loading" | "error" | "ready";
  activeSessionId?: string;
  activeModelProfileId?: string;
  onToggleCollapsed: () => void;
  onModeChange: (mode: string) => void;
  onNewTask: () => void;
  /** Start a new conversation inside the given project folder. */
  onNewProjectTask?: (workspaceRoot: string, displayName?: string) => void;
  /** 仅 Chat 模式显示；缺省则不渲染入口。 */
  onNewTemporaryChat?: () => void;
  /** Sessions with a run in flight, shown with a spinner in the list. */
  runningSessionIds?: readonly string[];
  /** Sessions waiting on the user (approval, question or plan review). */
  needsInputSessionIds?: readonly string[];
  onTogglePanel: (panel: ChatPagePanel) => void;
  onSelectSession: (sessionId: string) => void;
  onOpenProject: (workspaceRoot: string) => void;
  onRenameSession: (sessionId: string, newTitle: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onTogglePinSession: (sessionId: string, pinned: boolean) => void;
  onExportSession: (sessionId: string) => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onCloseWindow: () => void;
  onOpenSettings: () => void;
  onOpenApiSettings?: () => void;
  /** Receives the element a full-page feature portals its own sidebar into (shown instead of the conversations while a panel is open). */
  onPanelSlot?: (element: HTMLElement | null) => void;
  /** Back / forward through visited conversations and panels; the arrows are left out when absent. */
  navHistory?: { canBack: boolean; canForward: boolean; onBack: () => void; onForward: () => void };
}

// 阶段 1A：memo 隔离——ChatPage 流式重渲染时，只要 props 引用稳定（sessions/回调由父级保证），
// 导航子树（含内嵌的 ConversationSidebar）整体跳过执行，流式期间执行次数应为 0（探针验收）。
export const ChatPageNavigation = React.memo(function ChatPageNavigation({
  collapsed,
  activePanel,
  mode,
  sessions,
  sessionListStatus,
  activeSessionId,
  activeModelProfileId,
  onToggleCollapsed,
  onModeChange,
  onNewTask,
  onNewProjectTask,
  onNewTemporaryChat,
  runningSessionIds,
  needsInputSessionIds,
  onTogglePanel,
  onSelectSession,
  onOpenProject,
  onRenameSession,
  onDeleteSession,
  onTogglePinSession,
  onExportSession,
  onMinimize,
  onMaximize,
  onCloseWindow,
  onOpenSettings,
  onOpenApiSettings,
  onPanelSlot,
  navHistory,
}: ChatPageNavigationProps) {
  // 性能探针：perf harness 注册后统计导航子树执行次数（阶段 1A 验收：流式期间应为 0）
  reportChatPerfRender("navigationRenders");
  const sidebar = useSidebarWidth(collapsed);
  // Docked until it has slid out of the row; see useSidebarFold.
  const fold = useSidebarFold(collapsed);
  const floating = fold === "floating";
  const folding = fold === "closing" || fold === "opening";
  const { t } = useTranslation();
  // The thin strip along the left window edge is what brings the folded sidebar back on hover.
  const edgeRef = useRef<HTMLElement>(null);
  const contextRef = useRef<HTMLElement>(null);
  const [peeking, setPeeking] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const pointerWithin = useRef(false);
  const keyboardInteraction = useRef(false);
  const owns = (target: EventTarget | null) => target instanceof Node &&
    Boolean(edgeRef.current?.contains(target) || contextRef.current?.contains(target));
  const holdFocus = () => owns(document.activeElement) &&
    (keyboardInteraction.current || Boolean(document.activeElement?.closest('[role="menu"], .ant-popover')));
  const enter = () => { pointerWithin.current = true; if (collapsed) setPeeking(true); };
  const leave = (event: React.PointerEvent) => {
    if (owns(event.relatedTarget)) return;
    pointerWithin.current = false;
    if (!sidebar.isResizing && !holdFocus()) setPeeking(false);
  };
  useEffect(() => { setPeeking(false); }, [collapsed]);
  useEffect(() => {
    const focus = (event: FocusEvent) => {
      if (collapsed && owns(event.target)) setPeeking(true);
      else if (!pointerWithin.current) setPeeking(false);
    };
    const pointerDown = () => { keyboardInteraction.current = false; };
    const pointerMove = (event: globalThis.PointerEvent) => {
      if (owns(event.target)) return;
      pointerWithin.current = false;
      if (!sidebar.isResizing && !holdFocus()) setPeeking(false);
    };
    const shortcut = (event: KeyboardEvent) => {
      keyboardInteraction.current = true;
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "s" && !event.repeat) {
        event.preventDefault(); onToggleCollapsed();
      } else if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault(); setSearchOpen(true);
      }
    };
    const blur = () => { pointerWithin.current = false; setPeeking(false); };
    document.addEventListener("focusin", focus);
    document.addEventListener("pointerdown", pointerDown);
    document.addEventListener("pointermove", pointerMove);
    window.addEventListener("keydown", shortcut);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("focusin", focus);
      document.removeEventListener("pointerdown", pointerDown);
      document.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("keydown", shortcut);
      window.removeEventListener("blur", blur);
    };
  }, [collapsed, onToggleCollapsed, sidebar.isResizing]);
  useEffect(() => {
    if (!sidebar.isResizing && !pointerWithin.current && !holdFocus()) setPeeking(false);
  }, [sidebar.isResizing]);
  const hidden = collapsed && !peeking && !sidebar.isResizing;
  const resizeHandle = <div className={`ff-sidebar-resizer ${sidebar.isResizing ? "is-resizing" : ""}`} role="separator" tabIndex={0}
        aria-label={t("workspace.resizeSidebar")} aria-orientation="vertical"
        aria-controls="firefly-context-sidebar" aria-valuemin={sidebar.min}
        aria-valuemax={sidebar.max} aria-valuenow={sidebar.width}
        onPointerDown={sidebar.beginResize}
        onKeyDown={(event) => {
          const delta = event.key === "Home" ? sidebar.min - sidebar.width
            : event.key === "End" ? sidebar.max - sidebar.width
              : event.key === "ArrowRight" ? 16 : event.key === "ArrowLeft" ? -16 : null;
          if (delta === null) return;
          event.preventDefault();
          sidebar.resizeBy(delta);
        }} />;

  return (
    <>
      <header className="ff-page-titlebar">
        <div className="ff-page-toggle">
          {navHistory && <NavigationArrows canBack={navHistory.canBack} canForward={navHistory.canForward} onBack={navHistory.onBack} onForward={navHistory.onForward} />}
          <SidebarToggle collapsed={collapsed} onToggle={onToggleCollapsed} />
          <div className="ff-page-role">
            <img className="ff-page-role-avatar" src={resolveAsset("avatars/firefly-avatar.png")} alt="Firefly" draggable={false} />
            <ModelConnectionIndicator activeProfileId={activeModelProfileId} onOpenSettings={onOpenApiSettings ?? onOpenSettings} />
          </div>
          {/* 侧栏折叠时顶部那一行不可见，模式入口改放在头像旁，保证随时能切换。 */}
          {collapsed && <ModeMenu variant="compact" value={mode} onChange={onModeChange} />}
        </div>
        <div className="ff-page-windows">
          <WindowControls onMinimize={onMinimize} onMaximize={onMaximize} onClose={onCloseWindow} />
        </div>
      </header>
      {/* Codex-style activity rail: always visible, even when the conversation sidebar is folded away. */}
      <ActivityRail activePanel={activePanel} onTogglePanel={onTogglePanel} onOpenSettings={onOpenSettings} />
      {collapsed && <nav ref={edgeRef} onPointerEnter={enter} onPointerLeave={leave} className="ff-page-edge" aria-label={t("ui.navigation")} />}
      <aside ref={contextRef} onPointerEnter={enter} onPointerLeave={leave} id="firefly-context-sidebar" className={`ff-page-sidebar ${floating ? "is-floating" : ""} ${folding ? "is-folding" : ""} ${peeking ? "is-peeking" : ""}`} style={{ width: sidebar.width, ...(folding ? { marginRight: -sidebar.width } : null) }} inert={hidden} aria-hidden={hidden} aria-label={t("ui.contextSidebar")}>
        {collapsed && <span className="ff-sidebar-hover-corridor" aria-hidden="true" />}
        {/* A feature page owns the sidebar while it is open; the conversations stay mounted underneath so coming back is instant. */}
        <div className="ff-page-panelnav" ref={onPanelSlot} hidden={!activePanel} />
        <div className="ff-page-conversational" hidden={!!activePanel}>
        {/* Header, as in Codex: the mode switch on the left, search on the right. */}
        <div className="ff-page-mode">
          {!collapsed && <ModeMenu value={mode} onChange={onModeChange} />}
          <button type="button" className="ff-page-mode__search" onClick={() => setSearchOpen(true)}
            aria-label={t("sidebar.searchAction")} title={`${t("sidebar.searchAction")} Ctrl+K`} aria-keyshortcuts="Control+K">
            <Search size={16} strokeWidth={1.6} aria-hidden="true" />
          </button>
        </div>
        {/* New conversation: a plain row like Codex's "新聊天", lined up with the conversations below. In Chat mode the
            temporary chat is the small icon button at the right end of this same row (the user's chosen place). */}
        <div className="ff-page-newtask">
          <NewTaskButton label={mode === "chat" ? undefined : t("ui.newTaskButton")} onClick={onNewTask} />
          {mode === "chat" && onNewTemporaryChat && (
            <button type="button" className="ff-page-newtask__temporary" onClick={onNewTemporaryChat}
              aria-label={t("ui.temporaryChat")} title={`${t("ui.temporaryChat")}：${t("ui.temporaryChatHint")}`}>
              <MessageCircleDashed size={16} strokeWidth={1.6} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="ff-page-conversations">
          <ConversationSidebar
            mode={mode}
            sessions={sessions}
            listStatus={sessionListStatus}
            activeSessionId={activeSessionId}
            runningSessionIds={runningSessionIds}
            needsInputSessionIds={needsInputSessionIds}
            onSelect={onSelectSession}
            onOpenProject={onOpenProject}
            onNewProjectTask={onNewProjectTask}
            onRename={onRenameSession}
            onDelete={onDeleteSession}
            onTogglePin={onTogglePinSession}
            onExport={onExportSession}
          />
        </div>
        </div>
        <AppUpdateEntry />
        {sidebar.overlay && !hidden && resizeHandle}
      </aside>
      {!sidebar.overlay && resizeHandle}
      <SidebarSearchDialog open={searchOpen} sessions={sessions} activeSessionId={activeSessionId}
        onClose={() => setSearchOpen(false)} onSelect={onSelectSession} />
    </>
  );
});
