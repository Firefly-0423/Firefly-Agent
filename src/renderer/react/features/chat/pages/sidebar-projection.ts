import type { ChatSessionMeta, ConversationMode } from "../../../../../shared/chat-types";
import { orderSidebarSessions, sidebarGroupId, sidebarSessionGroup, type SidebarSnapshot } from "../../../../../shared/sidebar-layout";

export interface SidebarProjectionGroup {
  groupId: string;
  label: string;
  projectId?: string;
  sectionId?: string;
  sessionIds: string[];
}
export interface SidebarProjection { groups: SidebarProjectionGroup[] }

/** Pure projection; collapse is presentation state and never drops row identities. */
export function projectSidebar(sessions: readonly ChatSessionMeta[], snapshot: SidebarSnapshot, mode: ConversationMode): SidebarProjection {
  const layout = snapshot.layout.modes[mode];
  const hidden = new Set(layout.hiddenProjectIds);
  const groups = new Map<string, SidebarProjectionGroup>();
  const members = new Map<string, ChatSessionMeta[]>();
  const add = (group: SidebarProjectionGroup) => { groups.set(group.groupId, group); members.set(group.groupId, []); };
  const visible = new Map<string, ChatSessionMeta>();
  for (const session of sessions) {
    const projectId = snapshot.sessionProjectIds[session.id];
    if (session.mode === mode && !visible.has(session.id) && !(projectId && hidden.has(projectId))) visible.set(session.id, session);
  }
  if (mode !== "chat" && layout.viewMode === "project") {
    const used = new Set([...visible.values()].map(session => snapshot.sessionProjectIds[session.id]));
    for (const project of snapshot.layout.projects) {
      if (used.has(project.id) && !hidden.has(project.id)) add({ groupId: sidebarGroupId.project(mode, project.id), label: project.displayName, projectId: project.id, sessionIds: [] });
    }
  }
  add({ groupId: sidebarGroupId.default(mode), label: mode === "chat" || layout.viewMode === "merged" ? "Recent" : "Unbound", sessionIds: [] });
  for (const section of layout.sections) add({ groupId: sidebarGroupId.section(mode, section.id), label: section.name, sectionId: section.id, sessionIds: [] });
  for (const session of visible.values()) {
    const groupId = sidebarSessionGroup(snapshot, mode, session.id);
    (members.get(groupId) ?? members.get(sidebarGroupId.default(mode))!).push(session);
  }
  for (const [groupId, group] of groups) group.sessionIds = orderSidebarSessions(members.get(groupId)!, layout, groupId).map(session => session.id);
  const ordered = new Map(layout.groupOrder.map((groupId, index) => [groupId, index]));
  const fallback = new Map([...groups.keys()].map((groupId, index) => [groupId, index + ordered.size]));
  return { groups: [...groups.values()].sort((left, right) => (ordered.get(left.groupId) ?? fallback.get(left.groupId)!) - (ordered.get(right.groupId) ?? fallback.get(right.groupId)!)) };
}
