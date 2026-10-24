import { useState } from "react";
import { Dropdown } from "antd";
import type { MenuProps } from "antd";
import { ArrowDownUp, Check, Ellipsis, PanelLeft, SlidersHorizontal } from "lucide-react";
import { useTranslation } from "../../../i18n";
import type { ConversationMode } from "../../../../../shared/chat-types";
import type { SidebarPatch, SidebarSnapshot } from "../../../../../shared/sidebar-layout";
import type { SidebarProjectionGroup } from "../pages/sidebar-projection";
import { SidebarGroupsDialog, type SidebarGroupRow, type SidebarProjectRow } from "./SidebarGroupsDialog";
import "./SidebarLayoutControls.css";

const CHECK_SLOT = 14;
const checked = (on: boolean) => on ? <Check size={CHECK_SLOT} strokeWidth={2} aria-hidden="true" /> : <span style={{ width: CHECK_SLOT }} aria-hidden="true" />;

/**
 * Hidden groups keep their slots in the stored order: the visible groups are written back into the
 * slots they already occupy, in the new order, and anything not yet ordered is appended after the stored order.
 */
export function mergeGroupOrder(groupOrder: readonly string[], nextVisibleOrder: readonly string[]): string[] {
  const visible = new Set(nextVisibleOrder);
  const ordered = [...groupOrder, ...nextVisibleOrder.filter(id => !groupOrder.includes(id))];
  let next = 0;
  return ordered.map(id => visible.has(id) ? nextVisibleOrder[next++] : id);
}

/** The arrangement menu (group by, sort by, which projects to show, reset) and the groups dialog it opens. */
export function SidebarLayoutControls({ mode, snapshot, groups, projectIds, pending, mutate, title, statusView = false, onStatusViewChange, compact = false }: {
  mode: ConversationMode; snapshot: SidebarSnapshot; groups: SidebarProjectionGroup[]; title: string;
  projectIds: readonly string[]; pending: boolean; mutate(patch: SidebarPatch): Promise<boolean>;
  /** Grouped by status (needs input / working / done) instead of the stored view; kept on this device only. */
  statusView?: boolean; onStatusViewChange?(on: boolean): void;
  /** Only the arrangement button (and its dialog), for placing inside another heading. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const state = snapshot.layout.modes[mode];
  const projects = snapshot.layout.projects.filter(project => projectIds.includes(project.id));
  const hiddenProjects = projects.filter(project => state.hiddenProjectIds.includes(project.id));
  const defaultView = mode === "chat" ? "merged" : "project";
  const atDefaults = !statusView && state.viewMode === defaultView && state.sortMode === "recent" && hiddenProjects.length === 0;
  const label = (group: SidebarProjectionGroup) => group.projectId || group.sectionId ? group.label
    : t(mode === "chat" || state.viewMode === "merged" ? "sidebar.recentTitle" : "sidebar.unboundProject");
  /** Applies patches one after another and stops at the first one that did not go through. */
  const applyInOrder = async (patches: SidebarPatch[]) => {
    for (const patch of patches) if (!(await mutate(patch))) return;
  };
  const unhide = hiddenProjects.map(project => ({ mode, kind: "set-project-visible", projectId: project.id, visible: true } as const));
  const resetDefaults = () => { onStatusViewChange?.(false); return applyInOrder([
    ...(state.viewMode === defaultView ? [] : [{ mode, kind: "set-view", viewMode: defaultView } as const]),
    ...(state.sortMode === "recent" ? [] : [{ mode, kind: "set-sort", sortMode: "recent" } as const]),
    ...unhide,
  ]); };

  // Every project appears in the dialog exactly once: in the ordered list while it has a group, otherwise in the visibility list.
  const groupRows: SidebarGroupRow[] = groups.map(group => ({ groupId: group.groupId, label: label(group), sectionId: group.sectionId, projectId: group.projectId }));
  const projectRows: SidebarProjectRow[] = mode === "chat" ? [] : projects
    .filter(project => !groups.some(group => group.projectId === project.id))
    .map(project => ({ id: project.id, label: project.displayName, title: project.workspaceRoot, visible: !state.hiddenProjectIds.includes(project.id) }));

  // Two entries, each opening its own list: how the sidebar is arranged, and how chats inside it are ordered.
  const organize: NonNullable<MenuProps["items"]> = [
    ...(mode === "chat" ? [] : [{
      key: "group-by", label: t("sidebar.groupBy"),
      extra: t(statusView ? "sidebar.viewStatusShort" : state.viewMode === "project" ? "sidebar.viewProjectsShort" : "sidebar.viewMergedShort"), disabled: pending,
      children: [
        ...(["project", "merged"] as const).map(view => ({
          key: `view:${view}`, icon: checked(!statusView && state.viewMode === view), disabled: pending,
          label: t(view === "project" ? "sidebar.viewProjectsShort" : "sidebar.viewMergedShort"),
          onClick: () => {
            onStatusViewChange?.(false);
            if (state.viewMode !== view) void mutate({ mode, kind: "set-view", viewMode: view });
          },
        })),
        ...(onStatusViewChange ? [{
          key: "view:status", icon: checked(statusView), disabled: pending,
          label: t("sidebar.viewStatusShort"), onClick: () => onStatusViewChange(true),
        }] : []),
      ],
    }]),
    ...(mode === "chat" ? [] : [{
      key: "show", label: t("sidebar.show"), disabled: pending || projects.length === 0,
      children: projects.map(project => {
        const visible = !state.hiddenProjectIds.includes(project.id);
        return {
          key: `project:${project.id}`, icon: checked(visible), label: project.displayName, title: project.workspaceRoot, disabled: pending,
          onClick: () => { void mutate({ mode, kind: "set-project-visible", projectId: project.id, visible: !visible }); },
        };
      }),
    }]),
    ...(mode === "chat" ? [] : [{ type: "divider" as const }]),
    { key: "new-section", label: t("sidebar.newSection"), disabled: pending, onClick: () => setDialogOpen(true) },
    { key: "manage", label: t("sidebar.manageSections"), disabled: pending, onClick: () => setDialogOpen(true) },
    { type: "divider" as const },
    { key: "reset", label: t("sidebar.resetDefaults"), disabled: pending || atDefaults, onClick: () => { void resetDefaults(); } },
    ...(mode === "chat" ? [] : [{ key: "view-all", label: t("sidebar.viewAll"), disabled: pending || hiddenProjects.length === 0, onClick: () => { void applyInOrder(unhide); } }]),
  ];
  const items: MenuProps["items"] = [
    { key: "organize", label: t("sidebar.organizeSidebar"), icon: <PanelLeft size={14} strokeWidth={1.6} aria-hidden="true" />, children: organize },
    {
      key: "sort-by", label: t("sidebar.sortChats"), icon: <ArrowDownUp size={14} strokeWidth={1.6} aria-hidden="true" />,
      extra: t(state.sortMode === "recent" ? "sidebar.recentSort" : "sidebar.manualSort"), disabled: pending,
      children: (["recent", "manual"] as const).map(sort => ({
        key: `sort:${sort}`, icon: checked(state.sortMode === sort), disabled: pending,
        label: t(sort === "recent" ? "sidebar.recentSort" : "sidebar.manualSort"),
        onClick: () => { if (state.sortMode !== sort) void mutate({ mode, kind: "set-sort", sortMode: sort }); },
      })),
    },
  ];

  return <div className={compact ? "ff-sidebar-layout ff-sidebar-layout--compact" : "ff-sidebar-layout"}>
    <div className="ff-sidebar-layout__head">
      {compact ? null : <span className="ff-conversation-sidebar__title">{title}</span>}
      <Dropdown menu={{ items, selectable: false, triggerSubMenuAction: "click" }} trigger={["click"]} placement="bottomRight"
        onOpenChange={setMenuOpen} classNames={{ root: "ff-sidebar-menu" }}>
        <button type="button" className="ff-sidebar-layout__toggle" aria-label={t("sidebar.manageLayout")} title={t("sidebar.manageLayout")}
          aria-haspopup="menu" aria-expanded={menuOpen}>
          {compact ? <Ellipsis size={14} strokeWidth={1.8} aria-hidden="true" /> : <SlidersHorizontal size={14} strokeWidth={1.8} aria-hidden="true" />}
        </button>
      </Dropdown>
    </div>
    <SidebarGroupsDialog open={dialogOpen} pending={pending} rows={groupRows} projectRows={projectRows}
      onClose={() => setDialogOpen(false)}
      onAdd={name => mutate({ mode, kind: "create-section", name })}
      onRename={(sectionId, name) => void mutate({ mode, kind: "rename-section", sectionId, name })}
      onDelete={sectionId => void mutate({ mode, kind: "delete-section", sectionId })}
      onReorder={nextVisible => void mutate({ mode, kind: "set-group-order", groupIds: mergeGroupOrder(state.groupOrder, nextVisible) })}
      onToggleProject={(projectId, visible) => void mutate({ mode, kind: "set-project-visible", projectId, visible })} />
  </div>;
}
