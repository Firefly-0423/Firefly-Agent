import type { ChatSessionMeta, ConversationMode } from "../../../../../shared/chat-types";
import { orderSidebarSessions, sidebarGroupId, sidebarProjectSection, type SidebarSnapshot } from "../../../../../shared/sidebar-layout";

/** One project folder: its conversations stay inside it whatever tier the folder sits in. */
export interface SidebarFolder { groupId: string; projectId: string; label: string; sessionIds: string[] }
export interface SidebarTier {
  id: "pinned" | "projects" | "recent" | `section:${string}`;
  kind: "pinned" | "projects" | "section" | "recent";
  /** Section name for a section tier; the others are named by the sidebar. */
  label?: string;
  sectionId?: string;
  /** Project folders in this tier. */
  folders: SidebarFolder[];
  /** Conversations with no project, listed flat. */
  flatGroupId?: string;
  flatSessionIds: string[];
}

/**
 * Work and code, grouped by project: 置顶 (pinned projects and pinned conversations that belong to no project), 项目
 * (the rest of the projects), one tier per section (the projects filed there), and 最近 (conversations with no project).
 * A conversation is only ever listed in its own project, so a section or a pin never takes it out of the folder.
 */
export function projectTiers(sessions: readonly ChatSessionMeta[], snapshot: SidebarSnapshot, mode: ConversationMode): SidebarTier[] {
  const layout = snapshot.layout.modes[mode];
  const hidden = new Set(layout.hiddenProjectIds);
  const pinnedProjects = new Set(layout.pinnedProjectIds ?? []);
  const seen = new Set<string>();
  const byProject = new Map<string, ChatSessionMeta[]>();
  const unbound: ChatSessionMeta[] = [];
  for (const session of sessions) {
    if (session.mode !== mode || seen.has(session.id)) continue;
    const projectId = snapshot.sessionProjectIds[session.id];
    if (projectId && hidden.has(projectId)) continue;
    seen.add(session.id);
    if (!projectId) { unbound.push(session); continue; }
    byProject.set(projectId, [...(byProject.get(projectId) ?? []), session]);
  }

  const slot = new Map(layout.groupOrder.map((groupId, index) => [groupId, index]));
  const known = snapshot.layout.projects.filter(project => byProject.has(project.id));
  const folders = known.map((project, index) => ({ project, index })).sort((left, right) => {
    const a = slot.get(sidebarGroupId.project(mode, left.project.id)) ?? layout.groupOrder.length + left.index;
    const b = slot.get(sidebarGroupId.project(mode, right.project.id)) ?? layout.groupOrder.length + right.index;
    return a - b;
  }).map(({ project }): SidebarFolder => {
    const groupId = sidebarGroupId.project(mode, project.id);
    return { groupId, projectId: project.id, label: project.displayName, sessionIds: orderSidebarSessions(byProject.get(project.id)!, layout, groupId).map(session => session.id) };
  });

  const defaultGroup = sidebarGroupId.default(mode);
  const ordered = orderSidebarSessions(unbound, layout, defaultGroup);
  const pinnedFlat = ordered.filter(session => session.pinned).map(session => session.id);
  const recentFlat = ordered.filter(session => !session.pinned).map(session => session.id);

  const pinnedOrder = layout.pinnedProjectIds ?? [];
  const pinnedFolders = folders.filter(folder => pinnedProjects.has(folder.projectId))
    .sort((left, right) => pinnedOrder.indexOf(left.projectId) - pinnedOrder.indexOf(right.projectId));
  const free = folders.filter(folder => !pinnedProjects.has(folder.projectId));
  const sectionOf = (folder: SidebarFolder) => sidebarProjectSection(layout, folder.projectId);

  const tiers: SidebarTier[] = [];
  if (pinnedFolders.length || pinnedFlat.length) tiers.push({ id: "pinned", kind: "pinned", folders: pinnedFolders, flatGroupId: pinnedFlat.length ? `${mode}:pinned` : undefined, flatSessionIds: pinnedFlat });
  const plain = free.filter(folder => !sectionOf(folder));
  // With sections in use, 项目 is only the projects not filed anywhere, so it goes away once all of them are.
  if (plain.length || !layout.sections.length) tiers.push({ id: "projects", kind: "projects", folders: plain, flatSessionIds: [] });
  const sectionSlot = (sectionId: string, index: number) => slot.get(sidebarGroupId.section(mode, sectionId)) ?? layout.groupOrder.length + index;
  layout.sections.map((section, index) => ({ section, index }))
    .sort((left, right) => sectionSlot(left.section.id, left.index) - sectionSlot(right.section.id, right.index))
    .forEach(({ section }) => tiers.push({ id: `section:${section.id}`, kind: "section", label: section.name, sectionId: section.id, folders: free.filter(folder => sectionOf(folder) === section.id), flatSessionIds: [] }));
  if (recentFlat.length) tiers.push({ id: "recent", kind: "recent", folders: [], flatGroupId: defaultGroup, flatSessionIds: recentFlat });
  return tiers;
}
