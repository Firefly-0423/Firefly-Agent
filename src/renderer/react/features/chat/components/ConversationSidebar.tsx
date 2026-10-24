import { AppWindow, ChevronRight, Copy, Download, Ellipsis, EyeOff, Folder, FolderCode, FolderOpen, GitBranch, LoaderCircle, Monitor, PencilLine, Pin, PinOff, Plus, SquarePen, Trash2, TriangleAlert } from "lucide-react";
import { chatStore } from "../pages/chat-page-bridge";
import { useSidebarLayout } from "../pages/use-sidebar-layout";
import { projectSidebar } from "../pages/sidebar-projection";
import { useClosedTiers } from "../pages/sidebar-tier";
import { chatTiers, projectTiers, type SidebarTier } from "../pages/sidebar-tiers";
import { sidebarGroupId } from "../../../../../shared/sidebar-layout";
import { STATUS_ORDER, groupByStatus, statusGroupId, useStatusView, type SessionStatus } from "../pages/sidebar-status";
import { SidebarLayoutControls } from "./SidebarLayoutControls";
import { CreateProjectDialog } from "./CreateProjectDialog";
import type { OpenInAppEntry } from "../../../../../shared/open-in-app-types";
import { Conversations, type ConversationItemType } from "@ant-design/x";
import { Dropdown, Input, Menu, Modal, Popover } from "antd";
import type { InputRef } from "antd";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { placeMenu } from "./menu-position";
import { useTranslation } from "../../../i18n";
import { useFeedback } from "../../../components/feedback/FeedbackProvider";
import { reportChatPerfRender } from "./chat-perf-probe";
import type { ChatSessionMeta, ConversationMode } from "../../../../../shared/chat-types";

interface ConversationSidebarProps {
  mode: ConversationMode;
  sessions: ChatSessionMeta[];
  listStatus: "loading" | "error" | "ready";
  activeSessionId?: string;
  /** Sessions with a run in flight: a spinner follows their title. */
  runningSessionIds?: readonly string[];
  /** Sessions with an approval, question or plan waiting on the user. */
  needsInputSessionIds?: readonly string[];
  onSelect: (sessionId: string) => void;
  onOpenProject: (workspaceRoot: string) => void;
  /** Start a new conversation inside a project folder. */
  onNewProjectTask?: (workspaceRoot: string, displayName?: string) => void;
  onRename: (sessionId: string, newTitle: string) => void | Promise<void>;
  onDelete: (sessionId: string) => void | Promise<void>;
  onTogglePin: (sessionId: string, pinned: boolean) => void | Promise<void>;
  onExport: (sessionId: string) => void | Promise<void>;
}

interface ProjectSummary {
  name: string;
  workspaceRoot?: string;
  conversationCount: number;
  updatedAt: number;
}

function ProjectIcon({ mode, open = false }: { mode: ConversationMode; open?: boolean }) {
  const Icon = mode === "code" ? FolderCode : open ? FolderOpen : Folder;
  return <Icon size={16} strokeWidth={1.6} aria-hidden="true" />;
}

/** "6 天" style age of a conversation: minutes, hours or days, whichever reads shortest. */
function sessionAge(t: (key: string, params?: Record<string, unknown>) => string, updatedAt: number, now = Date.now()): string {
  const minutes = Math.max(1, Math.floor((now - updatedAt) / 60_000));
  if (minutes < 60) return t("sidebar.ageMinutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("sidebar.ageHours", { count: hours });
  return t("sidebar.ageDays", { count: Math.floor(hours / 24) });
}

function folderName(workspaceRoot: string): string {
  const parts = workspaceRoot.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? workspaceRoot;
}

/** Current branch per conversation, fetched once while the hover card is open and reused for half a minute. */
const branchCache = new Map<string, { at: number; branch: string | null }>();
const BRANCH_TTL_MS = 30_000;
function useSessionBranch(sessionId: string, enabled: boolean): string | null {
  const cached = branchCache.get(sessionId);
  const [branch, setBranch] = useState<string | null>(cached && Date.now() - cached.at < BRANCH_TTL_MS ? cached.branch : null);
  useEffect(() => {
    if (!enabled) return;
    const hit = branchCache.get(sessionId);
    if (hit && Date.now() - hit.at < BRANCH_TTL_MS) { setBranch(hit.branch); return; }
    let live = true;
    const api = (window as unknown as { codeGit?: { getStatus?: (id: string) => Promise<{ state?: string; branch?: { current: string | null } | null }> } }).codeGit;
    void Promise.resolve(api?.getStatus?.(sessionId)).then(status => {
      const next = status?.state === "ready" ? status.branch?.current ?? null : null;
      branchCache.set(sessionId, { at: Date.now(), branch: next });
      if (live) setBranch(next);
    }).catch(() => { if (live) setBranch(null); });
    return () => { live = false; };
  }, [sessionId, enabled]);
  return branch;
}

function SessionHoverCard({ session, mode, open }: { session: ChatSessionMeta; mode: ConversationMode; open: boolean }) {
  const { t } = useTranslation();
  const branch = useSessionBranch(session.id, open && !!session.workspaceRoot);
  const title = session.title || t("sidebar.defaultSessionTitle");
  return (
    <section className="ff-session-card" aria-label={t("sidebar.sessionCardAria", { title })}>
      <header className="ff-session-card__head">
        <span className="ff-session-card__title" title={title}>{title}</span>
        <Monitor className="ff-session-card__device" size={13} strokeWidth={1.6} aria-hidden="true" />
        <time className="ff-session-card__age" dateTime={new Date(session.updatedAt).toISOString()}>{sessionAge(t, session.updatedAt)}</time>
      </header>
      <ul className="ff-session-card__rows">
        {session.workspaceDisplayName && (
          <li><ProjectIcon mode={mode} /><span>{session.workspaceDisplayName}</span></li>
        )}
        {session.workspaceRoot && folderName(session.workspaceRoot) !== session.workspaceDisplayName && (
          <li title={session.workspaceRoot}><Folder size={15} strokeWidth={1.6} aria-hidden="true" /><span>{folderName(session.workspaceRoot)}</span></li>
        )}
        {branch && (
          <li className="ff-session-card__branch" title={branch}><GitBranch size={15} strokeWidth={1.7} aria-hidden="true" /><span>{branch}</span></li>
        )}
        {!session.workspaceRoot && <li className="ff-session-card__plain"><span>{t("sidebar.messageCount", { count: session.messageCount })}</span></li>}
      </ul>
    </section>
  );
}

// 阶段 1A：memo 隔离——ChatPage 流式重渲染时，只要 props 引用稳定（sessions/回调由父级保证），
// 侧栏子树整体跳过执行，流式期间执行次数应为 0（探针验收）。
export const ConversationSidebar = memo(function ConversationSidebar({
  mode,
  sessions,
  listStatus,
  activeSessionId,
  runningSessionIds,
  needsInputSessionIds,
  onSelect,
  onOpenProject,
  onNewProjectTask,
  onRename,
  onDelete,
  onTogglePin,
  onExport,
}: ConversationSidebarProps) {
  // 性能探针：perf harness 注册后统计侧栏子树执行次数（阶段 1A 验收：流式期间应为 0）
  reportChatPerfRender("sidebarRenders");
  const { t } = useTranslation();
  // 统一反馈入口：删除会话走危险确认
  const feedback = useFeedback();
  const supportsProjects = mode === "work" || mode === "code";
  const sectionTitle = supportsProjects ? t("sidebar.projectsTitle") : t("sidebar.conversationsTitle");
  const layout = useSidebarLayout(typeof window === "undefined" ? undefined : chatStore()?.sidebarLayout, sessions);
  const projection = useMemo(() => layout.snapshot ? projectSidebar(sessions, layout.snapshot, mode) : null, [sessions, layout.snapshot, mode]);
  const groupBySession = useMemo(() => new Map(projection?.groups.flatMap(group => group.sessionIds.map(id => [id, group.groupId] as const)) ?? []), [projection]);
  // Work and code grouped by project read as tiers: 置顶, 项目, one per section, 最近. Chat reads the same way without projects:
  // one tier per section, then 最近.
  const tiers = useMemo(() => !layout.snapshot ? null
    : supportsProjects ? (layout.snapshot.layout.modes[mode].viewMode === "project" ? projectTiers(sessions, layout.snapshot, mode) : null)
      : chatTiers(sessions, layout.snapshot, mode), [sessions, layout.snapshot, mode, supportsProjects]);
  const tierGroupBySession = useMemo(() => new Map(tiers?.flatMap(tier => [
    ...tier.folders.flatMap(folder => folder.sessionIds.map(id => [id, folder.groupId] as const)),
    ...tier.flatSessionIds.map(id => [id, tier.flatGroupId!] as const),
  ]) ?? []), [tiers]);
  const persistedExpanded = projection?.groups.filter(group => !layout.snapshot!.layout.modes[mode].collapsedGroupIds.includes(group.groupId)).map(group => group.groupId);
  const projects = useMemo(() => {
    const result = new Map<string, ProjectSummary>();
    for (const session of sessions) {
      const key = session.workspaceRoot ?? `unbound:${session.id}`;
      const current = result.get(key);
      if (current) {
        current.conversationCount += 1;
        current.updatedAt = Math.max(current.updatedAt, session.updatedAt);
      } else {
        result.set(key, {
          name: session.workspaceDisplayName ?? t("sidebar.unboundProject"),
          workspaceRoot: session.workspaceRoot,
          conversationCount: 1,
          updatedAt: session.updatedAt,
        });
      }
    }
    return result;
  }, [sessions]);
  // A single, expanded, unnamed group (typical Chat history) needs no heading of its own.
  const soleGroup = projection?.groups.length === 1 ? projection.groups[0] : undefined;
  const flat = !!soleGroup && !soleGroup.projectId && !soleGroup.sectionId && !!persistedExpanded?.includes(soleGroup.groupId);
  const projectKeys = useMemo(() => ["pinned", "recent", ...projects.keys()], [projects]);
  const [expandedKeys, setExpandedKeys] = useState<string[]>(projectKeys);

  useEffect(() => {
    setExpandedKeys((current) => [...new Set([...current, ...projectKeys])]);
  }, [projectKeys]);

  const [contextMenu, setContextMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    above?: number;
    sessionId: string;
    sessionTitle: string;
    pinned: boolean;
    workspaceRoot?: string;
  }>({ open: false, x: 0, y: 0, sessionId: "", sessionTitle: "", pinned: false });
  // 「打开方式」里列出的应用：菜单打开时按这个会话的项目文件夹探测一次。
  const [openApps, setOpenApps] = useState<OpenInAppEntry[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const [editing, setEditing] = useState<{
    sessionId: string;
    value: string;
  } | null>(null);

  // antd Input 的 ref 是 InputRef（含 focus/select），不是原生元素
  const renameInputRef = useRef<InputRef | null>(null);

  useEffect(() => {
    if (!editing) return;
    const input = renameInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [editing]);

  const running = useMemo(() => new Set(runningSessionIds ?? []), [runningSessionIds]);
  const needsInput = useMemo(() => new Set(needsInputSessionIds ?? []), [needsInputSessionIds]);
  // "By status": needs input / working / done, chosen from the arrangement menu and remembered per mode on this device.
  const [statusView, setStatusView] = useStatusView(mode);
  const tiered = !!tiers && !statusView;
  const [closedTiers, toggleClosedTier] = useClosedTiers(mode);
  const [renamingProject, setRenamingProject] = useState<{ projectId: string; value: string } | null>(null);
  // Status grouping still honours the arrangement's hidden projects: only conversations the projection shows take part.
  const statusSessions = useMemo(() => {
    if (!projection) return sessions;
    const shown = new Set(projection.groups.flatMap(group => group.sessionIds));
    return sessions.filter(session => shown.has(session.id));
  }, [sessions, projection]);
  const statusOf = useMemo(() => statusView ? new Map(groupByStatus(statusSessions, running, needsInput).map(item => [item.session.id, item.status] as const)) : null,
    [statusView, statusSessions, running, needsInput]);
  const [statusExpanded, setStatusExpanded] = useState<string[]>(() => STATUS_ORDER.map(statusGroupId));

  const sortedSessions = useMemo(
    () => {
      if (statusView) return groupByStatus(statusSessions, running, needsInput).map(item => item.session);
      if (projection) {
        const byId = new Map(sessions.map(session => [session.id, session]));
        return projection.groups.flatMap(group => group.sessionIds.map(id => byId.get(id)!).filter(Boolean));
      }
      return [...sessions].sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return b.updatedAt - a.updatedAt;
      });
    },
    [sessions, projection, statusView, statusSessions, running, needsInput],
  );

  // 阶段 1A：items 数组 useMemo——避免每次渲染重建（Conversations 拿到新数组引用即重渲染全部条目）
  const items: ConversationItemType[] = useMemo(
    () =>
      sortedSessions.map((session) => ({
        key: session.id,
        "data-session-id": session.id,
        "data-pinned": session.pinned ? "true" : undefined,
        label:
          editing?.sessionId === session.id ? (
            <Input
              ref={renameInputRef}
              size="small"
              className="ff-session-rename-input"
              value={editing.value}
              onChange={(e) => setEditing({ ...editing, value: e.target.value })}
              onPressEnter={() => {
                const title = editing.value.trim();
                if (title && title !== session.title) {
                  void onRename(session.id, title);
                }
                setEditing(null);
              }}
              onBlur={() => setEditing(null)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setEditing(null);
                }
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <Popover
              placement="rightTop"
              mouseEnterDelay={0.5}
              mouseLeaveDelay={0.1}
              destroyOnHidden
              overlayClassName="ff-session-popover"
              getPopupContainer={(trigger) => trigger.closest<HTMLElement>("#firefly-context-sidebar") ?? trigger.parentElement!}
              content={<SessionHoverCard session={session} mode={mode} open />}
            >
              <span className="ff-session-label">
                <span className="ff-session-label__title" title={session.title || t("sidebar.defaultSessionTitle")}>{session.title || t("sidebar.defaultSessionTitle")}</span>
                {statusOf?.get(session.id) === "needs-input" ? (
                  <TriangleAlert className="ff-session-label__needs-input" size={14} strokeWidth={1.8} role="img" aria-label={t("sidebar.status.needsInputLabel")} />
                ) : running.has(session.id) && (
                  <LoaderCircle className="ff-session-label__running" size={14} strokeWidth={1.8} role="img" aria-label={t("sidebar.sessionRunning")} />
                )}
                {session.pinned && <Pin className="ff-session-label__pinned" size={12} strokeWidth={1.8} role="img" aria-label={t("sidebar.pin")} />}
                <span className="ff-session-actions" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                  <button type="button" className="ff-session-actions__button" aria-label={session.pinned ? t("sidebar.unpin") : t("sidebar.pin")}
                    title={session.pinned ? t("sidebar.unpin") : t("sidebar.pin")} onClick={() => { void onTogglePin(session.id, !session.pinned); }}>
                    {session.pinned ? <PinOff size={14} strokeWidth={1.7} aria-hidden="true" /> : <Pin size={14} strokeWidth={1.7} aria-hidden="true" />}
                  </button>
                  <button type="button" className="ff-session-actions__button" aria-label={t("sidebar.sessionActions", { title: session.title || t("sidebar.defaultSessionTitle") })}
                    title={t("sidebar.moreActions")} aria-haspopup="menu"
                    onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); openContextMenuAt(session.id, box.left, box.bottom + 4, box.top - 4); }}>
                    <Ellipsis size={14} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                </span>
              </span>
            </Popover>
          ),
        group: statusOf ? statusGroupId(statusOf.get(session.id) ?? "done") : (tiered ? tierGroupBySession : groupBySession).get(session.id) ?? (supportsProjects ? session.workspaceRoot ?? `unbound:${session.id}` : session.pinned ? "pinned" : "recent"),
      })),
    [sortedSessions, editing, t, supportsProjects, onRename, onTogglePin, mode, groupBySession, tierGroupBySession, tiered, running, statusOf],
  );
  // A section the user just made has no conversations yet; the list only draws groups that have rows, so it gets
  // one quiet placeholder row, in its place in the group order, until something is moved into it.
  const listItems: ConversationItemType[] = useMemo(() => {
    if (!projection || statusView) return items;
    const byGroup = new Map<string, ConversationItemType[]>();
    for (const item of items) byGroup.set(String(item.group), [...(byGroup.get(String(item.group)) ?? []), item]);
    return projection.groups.flatMap(group => byGroup.get(group.groupId) ?? (group.sectionId ? [{
      key: `empty:${group.groupId}`, group: group.groupId, disabled: true, className: "ff-session-empty-row",
      label: <span className="ff-session-empty">{t("sidebar.emptySection")}</span>,
    }] : []));
  }, [items, projection, statusView, t]);

  function openContextMenuAt(sessionId: string, x: number, y: number, above?: number) {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;
    setContextMenu({
      open: true,
      x,
      y,
      above,
      sessionId,
      sessionTitle: session.title || t("sidebar.defaultSessionTitle"),
      pinned: session.pinned ?? false,
      workspaceRoot: session.workspaceRoot,
    });
    setOpenApps(null);
    if (session.workspaceRoot) {
      void window.openInApp?.listApps(sessionId).then(reply => setOpenApps(reply.ok ? reply.apps : [])).catch(() => setOpenApps([]));
    }
  }

  const copyText = (text: string) => {
    void navigator.clipboard.writeText(text).then(
      () => feedback.notice({ tone: "success", message: t("sidebar.copied") }),
      () => feedback.notice({ tone: "error", message: t("sidebar.copyFailed") }),
    );
  };

  function openContextMenu(event: React.MouseEvent, sessionId: string) {
    event.preventDefault();
    event.stopPropagation();
    openContextMenuAt(sessionId, event.clientX, event.clientY);
  }

  const menuRef = useRef<HTMLDivElement>(null);
  // Once the menu is measured, move it fully inside the window (a fixed-position menu has no collision handling of its own).
  useLayoutEffect(() => {
    const node = menuRef.current;
    if (!contextMenu.open || !node) return;
    const box = node.getBoundingClientRect();
    const spot = placeMenu({ x: contextMenu.x, y: contextMenu.y, above: contextMenu.above }, { width: box.width, height: box.height }, { width: window.innerWidth, height: window.innerHeight });
    node.style.left = `${spot.left}px`;
    node.style.top = `${spot.top}px`;
  }, [contextMenu.open, contextMenu.x, contextMenu.y, contextMenu.above]);

  function closeContextMenu() {
    setContextMenu((current) => ({ ...current, open: false }));
  }

  async function handleMenuClick(key: string) {
    closeContextMenu();
    if (key === "rename") {
      const target = sessions.find((s) => s.id === contextMenu.sessionId);
      setEditing({
        sessionId: contextMenu.sessionId,
        value: target?.title ?? "",
      });
    } else if (key.startsWith("move-section:")) {
      void layout.mutate({ mode, kind: "move-session", sessionId: contextMenu.sessionId, sectionId: key.slice("move-section:".length) || null });
    } else if (key === "move-up" || key === "move-down") {
      const group = projection?.groups.find(item => item.sessionIds.includes(contextMenu.sessionId));
      if (!group || !layout.snapshot) return;
      const index = group.sessionIds.indexOf(contextMenu.sessionId);
      const beforeSessionId = key === "move-up" ? group.sessionIds[index - 1] : group.sessionIds[index + 2];
      if ((key === "move-up" && index === 0) || (key === "move-down" && index === group.sessionIds.length - 1)) return;
      void layout.mutate({ mode, kind: "move-session", sessionId: contextMenu.sessionId, sectionId: group.sectionId ?? null, beforeSessionId });
    } else if (key === "copy-title") {
      copyText(contextMenu.sessionTitle);
    } else if (key === "copy-path") {
      if (contextMenu.workspaceRoot) copyText(contextMenu.workspaceRoot);
    } else if (key.startsWith("open-in:")) {
      const reply = await window.openInApp?.open(contextMenu.sessionId, key.slice("open-in:".length));
      if (reply && !reply.ok) feedback.notice({ tone: "error", message: t("openWorkspace.openError") });
    } else if (key === "toggle-pin") {
      void onTogglePin(contextMenu.sessionId, !contextMenu.pinned);
    } else if (key === "export-markdown") {
      void onExport(contextMenu.sessionId);
    } else if (key === "delete") {
      // 删除会话不可恢复：危险确认，默认聚焦取消，确认后才触发删除
      const confirmed = await feedback.confirm({
        title: t("sidebar.deleteConfirmTitle", { title: contextMenu.sessionTitle }),
        message: t("sidebar.deleteConfirmContent"),
        confirmText: t("sidebar.delete"),
        cancelText: t("common.cancel"),
        dangerous: true,
      });
      if (confirmed) onDelete(contextMenu.sessionId);
    }
  }

  useEffect(() => {
    if (!contextMenu.open) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (target.closest(".ff-session-context-menu")) return;
      closeContextMenu();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeContextMenu();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu.open]);

  /** The "⋯" menu of a project folder: pin it, rename it, file it in a section, open it, or take it off the sidebar. */
  const projectMenu = (project: ProjectSummary, projectId: string | undefined) => {
    const state = layout.snapshot?.layout.modes[mode];
    const pinned = !!projectId && !!state?.pinnedProjectIds?.includes(projectId);
    const current = projectId && state ? state.projectSections?.[projectId] ?? "" : "";
    const send = (patch: Parameters<typeof layout.mutate>[0]) => { void layout.mutate(patch); };
    return {
      items: [
        ...(projectId ? [
          { key: "pin", label: pinned ? t("sidebar.unpinProject") : t("sidebar.pinProject"), icon: pinned ? <PinOff size={14} strokeWidth={1.6} aria-hidden="true" /> : <Pin size={14} strokeWidth={1.6} aria-hidden="true" />,
            onClick: () => send({ mode, kind: "pin-project", projectId, pinned: !pinned }) },
          { key: "rename", label: t("sidebar.renameProject"), icon: <PencilLine size={14} strokeWidth={1.6} aria-hidden="true" />,
            onClick: () => setRenamingProject({ projectId, value: project.name }) },
          { key: "section", label: t("sidebar.moveToSection"), children: [
            { key: "section:", label: t("sidebar.defaultSection"), disabled: current === "", onClick: () => send({ mode, kind: "move-project", projectId, sectionId: null }) },
            ...(state?.sections ?? []).map(section => ({ key: `section:${section.id}`, label: section.name, disabled: current === section.id,
              onClick: () => send({ mode, kind: "move-project", projectId, sectionId: section.id }) })),
          ] },
        ] : []),
        { key: "open", label: t("sidebar.openProjectFolder"), icon: <FolderOpen size={14} strokeWidth={1.6} aria-hidden="true" />, disabled: !project.workspaceRoot,
          onClick: () => project.workspaceRoot && onOpenProject(project.workspaceRoot) },
        ...(projectId ? [{ key: "hide", label: t("sidebar.hideProject"), icon: <EyeOff size={14} strokeWidth={1.6} aria-hidden="true" />,
          onClick: () => send({ mode, kind: "set-project-visible", projectId, visible: false }) }] : []),
      ],
    };
  };

  const tierTitle = (tier: SidebarTier) => tier.kind === "pinned" ? t("sidebar.pinnedTitle") : tier.kind === "projects" ? t("sidebar.projectsTitle")
    : tier.kind === "recent" ? t("sidebar.recentTitle") : tier.label ?? "";
  const tierOpen = (tier: SidebarTier) => tier.kind === "section"
    ? !layout.snapshot!.layout.modes[mode].collapsedGroupIds.includes(sidebarGroupId.section(mode, tier.sectionId!)) : !closedTiers.has(tier.id);
  const toggleTier = (tier: SidebarTier) => {
    if (tier.kind === "section") void layout.mutate({ mode, kind: "set-expanded", groupId: sidebarGroupId.section(mode, tier.sectionId!), expanded: !tierOpen(tier) });
    else toggleClosedTier(tier.id);
  };
  const rowsOf = (groupIds: readonly string[]) => groupIds.flatMap(groupId => listItems.filter(item => item.group === groupId));
  const layoutControls = layout.snapshot && projection
    ? <SidebarLayoutControls mode={mode} snapshot={layout.snapshot} groups={projection.groups} title={sectionTitle} compact
      statusView={statusView} onStatusViewChange={setStatusView}
      projectIds={sessions.map(session => layout.snapshot!.sessionProjectIds[session.id]).filter((id): id is string => !!id)} pending={layout.pending} mutate={layout.mutate} />
    : null;
  /** "+" on the projects heading: name a project and choose its folder, then start a conversation inside it. */
  const addProjectFolder = () => setCreateOpen(true);
  const renderTier = (tier: SidebarTier, index: number) => {
    const open = tierOpen(tier);
    return (
      <section className="ff-tier" key={tier.id} data-tier={tier.id}>
        <div className="ff-tier__head">
          <button type="button" className="ff-tier__toggle" aria-expanded={open} onClick={() => toggleTier(tier)}>
            <span>{tierTitle(tier)}</span><ChevronRight size={12} strokeWidth={2} aria-hidden="true" />
          </button>
          <span className="ff-tier__actions">
            {index === 0 && layoutControls}
            {supportsProjects && (tier.kind === "projects" || (index === 0 && !tiers!.some(other => other.kind === "projects"))) && onNewProjectTask && (
              <button type="button" className="ff-tier__add" aria-label={t("sidebar.addProject")} title={t("sidebar.addProject")} onClick={addProjectFolder}>
                <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
          </span>
        </div>
        {open && <div className="ff-tier__body">
          {tier.folders.length > 0 && renderList(rowsOf(tier.folders.map(folder => folder.groupId)), new Set(tier.folders.map(folder => folder.groupId)), "ff-conversation-list ff-conversation-list--projects")}
          {tier.flatGroupId && tier.flatSessionIds.length > 0 && (
            <Conversations rootClassName="ff-conversation-list ff-conversation-list--flat" items={rowsOf([tier.flatGroupId])} activeKey={activeSessionId}
              onActiveChange={(key) => { onSelect(String(key)); }} groupable={{ collapsible: false, label: () => null }} />
          )}
          {tier.kind === "section" && tier.folders.length === 0 && tier.flatSessionIds.length === 0 && <p className="ff-tier__empty">{t("sidebar.emptyTier")}</p>}
        </div>}
      </section>
    );
  };

  const renderList = (rows: ConversationItemType[], groupIds: ReadonlySet<string> | null, className: string) => (
      <Conversations
        rootClassName={className}
        items={rows}
        activeKey={activeSessionId}
        onActiveChange={(key) => {
          onSelect(String(key));
        }}
        groupable={{
          collapsible: true,
          expandedKeys: statusView ? statusExpanded : persistedExpanded ?? expandedKeys,
          // @ant-design/x 2.9.0 在 setState updater 内部调用 onExpand（use-collapsible.js），
          // updater 会在渲染期执行，直接 setExpandedKeys 会触发
          // "Cannot update a component while rendering a different component"。
          // 用 queueMicrotask 把 setState 挪出渲染期，行为不变。
          onExpand: (keys) => {
            queueMicrotask(() => {
              if (statusView) { setStatusExpanded(keys); return; }
              if (projection && layout.snapshot) {
                for (const group of projection.groups.filter(item => !groupIds || groupIds.has(item.groupId))) {
                  const expanded = keys.includes(group.groupId);
                  if (expanded === layout.snapshot.layout.modes[mode].collapsedGroupIds.includes(group.groupId)) {
                    void layout.mutate({ mode, kind: "set-expanded", groupId: group.groupId, expanded });
                  }
                }
              } else setExpandedKeys(keys);
            });
          },
          label: (group) => {
            if (group.startsWith("status:")) {
              const status = group.slice("status:".length) as SessionStatus;
              return <span className="ff-conversation-status" data-status={status}>{t(`sidebar.status.${status}`)}</span>;
            }
            if (group === "pinned") return t("sidebar.pinnedTitle");
            if (group === "recent") return t("sidebar.recentTitle");
            const projected = projection?.groups.find(item => item.groupId === group);
            if (projected && !projected.projectId) return projected.sectionId ? projected.label
              : t(mode === "chat" || layout.snapshot?.layout.modes[mode].viewMode === "merged" ? "sidebar.recentTitle" : "sidebar.unboundProject");
            const storedProject = layout.snapshot?.layout.projects.find(item => item.id === projected?.projectId);
            const members = projected?.sessionIds.map(id => sessions.find(session => session.id === id)!).filter(Boolean);
            const project = storedProject ? { name: storedProject.displayName, workspaceRoot: storedProject.workspaceRoot,
              conversationCount: members?.length ?? 0, updatedAt: Math.max(0, ...(members?.map(session => session.updatedAt) ?? [])) } : projects.get(group);
            if (!project) return null;
            const expanded = (persistedExpanded ?? expandedKeys).includes(group);
            return (
              <span className="ff-conversation-project" title={project.workspaceRoot}>
                <ProjectIcon mode={mode} open={expanded} />
                <span className="ff-conversation-project__name">{project.name}</span>
                <span className="ff-conversation-project__actions" onClick={(event) => event.stopPropagation()}>
                  <Dropdown trigger={["click"]} placement="bottomLeft" classNames={{ root: "ff-sidebar-menu" }} menu={projectMenu(project, projected?.projectId)}>
                    <button type="button" className="ff-conversation-project__more" aria-label={t("sidebar.projectActions", { name: project.name })}>
                      <Ellipsis size={14} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                  </Dropdown>
                  {onNewProjectTask && project.workspaceRoot && (
                    <button type="button" className="ff-conversation-project__more" aria-label={t("sidebar.newProjectChat")} title={t("sidebar.newProjectChat")}
                      onClick={() => onNewProjectTask(project.workspaceRoot!, project.name)}>
                      <SquarePen size={14} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                  )}
                </span>
              </span>
            );
          },
        }}
      />
  );

  return (
    <nav className="ff-conversation-sidebar" aria-label={supportsProjects ? t("sidebar.projectsAndConversationsAria") : t("sidebar.conversationListAria")}>
      {tiered && items.length > 0 ? null : layout.snapshot && projection
        ? <SidebarLayoutControls mode={mode} snapshot={layout.snapshot} groups={projection.groups} title={sectionTitle}
          statusView={statusView} onStatusViewChange={setStatusView}
          projectIds={sessions.map(session => layout.snapshot!.sessionProjectIds[session.id]).filter((id): id is string => !!id)} pending={layout.pending} mutate={layout.mutate} />
        : <div className="ff-conversation-sidebar__title">{sectionTitle}</div>}
      {layout.error && <p className="ff-sidebar-layout__error" role="alert">{t(layout.error === "conflict" ? "sidebar.layoutConflict" : "sidebar.layoutFailed")}</p>}
      {items.length === 0 ? (
        <div className="ff-conversation-sidebar__empty">
          {listStatus === "loading"
            ? t("sidebar.listLoading")
            : listStatus === "error"
              ? t("sidebar.listFailed")
              : supportsProjects ? t("sidebar.emptyProjects") : t("sidebar.emptyConversations")}
          {listStatus === "ready" && supportsProjects && onNewProjectTask && (
            <button type="button" className="ff-conversation-sidebar__add" onClick={addProjectFolder}>
              <Plus size={14} strokeWidth={1.8} aria-hidden="true" />{t("sidebar.addProject")}
            </button>
          )}
        </div>
      ) : (
        <>
          <div
            className="ff-conversation-list-wrapper"
            onContextMenu={(e) => {
              const item = (e.target as HTMLElement).closest("[data-session-id]");
              const sessionId = item?.getAttribute("data-session-id");
              if (!sessionId) return;
              openContextMenu(e, sessionId);
            }}
          >
            {tiered
              ? tiers!.map(renderTier)
              : renderList(listItems, null, flat && !statusView ? "ff-conversation-list ff-conversation-list--flat" : `ff-conversation-list${statusView ? " ff-conversation-list--status" : ""}`)}
          </div>
          {contextMenu.open && (
            <div
              ref={menuRef}
              className="ff-session-context-menu"
              style={{
                position: "fixed",
                left: contextMenu.x,
                top: contextMenu.y,
                zIndex: 1050,
              }}
            >
              <Menu
                items={[
                  ...(layout.snapshot && mode === "chat" ? [{ key: "placement", label: t("sidebar.moveToSection"), children: [
                    { key: "move-section:", label: t("sidebar.defaultSection") },
                    ...layout.snapshot.layout.modes[mode].sections.map(section => ({ key: "move-section:" + section.id, label: section.name })),
                  ] }] : []),
                  ...(layout.snapshot && layout.snapshot.layout.modes[mode].sortMode === "manual" ? [
                    { key: "move-up", label: t("sidebar.moveUp") }, { key: "move-down", label: t("sidebar.moveDown") },
                  ] : []),
                  { key: "rename", label: t("sidebar.rename"), icon: <PencilLine size={14} strokeWidth={1.6} aria-hidden="true" /> },
                  {
                    key: "toggle-pin",
                    label: contextMenu.pinned ? t("sidebar.unpin") : t("sidebar.pin"),
                    icon: contextMenu.pinned ? <PinOff size={14} strokeWidth={1.6} aria-hidden="true" /> : <Pin size={14} strokeWidth={1.6} aria-hidden="true" />,
                  },
                  { type: "divider" as const },
                  { key: "copy", label: t("sidebar.copy"), icon: <Copy size={14} strokeWidth={1.6} aria-hidden="true" />, children: [
                    { key: "copy-title", label: t("sidebar.copyTitle") },
                    ...(contextMenu.workspaceRoot ? [{ key: "copy-path", label: t("sidebar.copyProjectPath") }] : []),
                  ] },
                  ...(contextMenu.workspaceRoot ? [{ key: "open-with", label: t("sidebar.openWith"), icon: <AppWindow size={14} strokeWidth={1.6} aria-hidden="true" />,
                    children: openApps === null ? [{ key: "open-with-loading", label: t("openWorkspace.detecting"), disabled: true }]
                      : (openApps.length ? openApps : [{ id: "explorer", name: t("openWorkspace.appExplorer") } as OpenInAppEntry]).map(app => ({
                        key: `open-in:${app.id}`, label: app.id === "explorer" ? t("openWorkspace.appExplorer") : app.name,
                        icon: app.icon ? <img src={app.icon} width={14} height={14} alt="" aria-hidden="true" draggable={false} /> : undefined,
                      })) }] : []),
                  ...(mode === "work" ? [{ key: "export-markdown", label: t("sidebar.exportMarkdown"), icon: <Download size={14} strokeWidth={1.6} aria-hidden="true" /> }] : []),
                  { type: "divider" as const },
                  { key: "delete", label: t("sidebar.delete"), icon: <Trash2 size={14} strokeWidth={1.6} aria-hidden="true" />, danger: true },
                ]}
                onClick={({ key }) => handleMenuClick(key)}
              />
            </div>
          )}
        </>
      )}
      <CreateProjectDialog open={createOpen} onClose={() => setCreateOpen(false)}
        onCreate={(path, displayName) => onNewProjectTask?.(path, displayName)} />
      <Modal open={!!renamingProject} title={t("sidebar.renameProjectTitle")} okText={t("common.confirm")} cancelText={t("common.cancel")}
        okButtonProps={{ disabled: !renamingProject?.value.trim() }} onCancel={() => setRenamingProject(null)}
        onOk={() => { if (renamingProject?.value.trim()) void layout.mutate({ mode, kind: "rename-project", projectId: renamingProject.projectId, name: renamingProject.value.trim() }); setRenamingProject(null); }}>
        <Input value={renamingProject?.value ?? ""} maxLength={120} autoFocus aria-label={t("sidebar.renameProjectTitle")}
          onChange={(event) => setRenamingProject(current => current && { ...current, value: event.target.value })}
          onPressEnter={() => { if (renamingProject?.value.trim()) void layout.mutate({ mode, kind: "rename-project", projectId: renamingProject.projectId, name: renamingProject.value.trim() }); setRenamingProject(null); }} />
      </Modal>
    </nav>
  );
});
