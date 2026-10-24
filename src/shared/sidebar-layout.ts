import type { ChatSessionMeta, ConversationMode } from "./chat-types";

export interface SidebarProject { id: string; workspaceRoot: string; displayName: string }
export interface SidebarSection { id: string; name: string }
export interface ModeSidebarLayout {
  viewMode: "project" | "merged";
  sortMode: "recent" | "manual";
  hiddenProjectIds: string[];
  sections: SidebarSection[];
  collapsedGroupIds: string[];
  membership: Record<string, string>;
  manualOrders: Record<string, string[]>;
  groupOrder: string[];
  /** Projects pinned to the top tier (work and code). */
  pinnedProjectIds?: string[];
  /** The section each project sits in (work and code). Conversations always stay inside their project; in Chat,
   *  which has no projects, `membership` places conversations in sections directly. */
  projectSections?: Record<string, string>;
}
export interface SidebarLayout {
  schemaVersion: 1;
  revision: number;
  projects: SidebarProject[];
  modes: Record<ConversationMode, ModeSidebarLayout>;
}
export interface SidebarSnapshot {
  layout: SidebarLayout;
  sessionProjectIds: Record<string, string | null>;
  notices: string[];
}
export type SidebarPatch = { mode: ConversationMode } & (
  | { kind: "set-view"; viewMode: ModeSidebarLayout["viewMode"] }
  | { kind: "set-sort"; sortMode: ModeSidebarLayout["sortMode"] }
  | { kind: "set-project-visible"; projectId: string; visible: boolean }
  | { kind: "set-expanded"; groupId: string; expanded: boolean }
  | { kind: "create-section"; name: string }
  | { kind: "rename-section"; sectionId: string; name: string }
  | { kind: "delete-section"; sectionId: string }
  | { kind: "move-session"; sessionId: string; sectionId: string | null; beforeSessionId?: string }
  | { kind: "set-group-order"; groupIds: string[] }
  | { kind: "pin-project"; projectId: string; pinned: boolean }
  | { kind: "move-project"; projectId: string; sectionId: string | null }
  | { kind: "rename-project"; projectId: string; name: string }
);
export type SidebarMutationResult =
  | { ok: true; snapshot: SidebarSnapshot }
  | { ok: false; code: "conflict" | "invalid" | "storage_error"; snapshot?: SidebarSnapshot; error?: string };
export interface SidebarMutation { expectedRevision: number; patch: SidebarPatch }

export const SIDEBAR_MODES = ["chat", "work", "code"] as const;
export const sidebarGroupId = {
  default: (mode: ConversationMode) => `${mode}:default`,
  project: (mode: ConversationMode, projectId: string) => `${mode}:project:${projectId}`,
  section: (mode: ConversationMode, sectionId: string) => `${mode}:section:${sectionId}`,
};
/** Where a project sits: its section, or null for the plain 项目 tier. */
export function sidebarProjectSection(layout: ModeSidebarLayout, projectId: string): string | null {
  const sectionId = layout.projectSections?.[projectId];
  return sectionId && layout.sections.some(section => section.id === sectionId) ? sectionId : null;
}
/** Placement never changes a session's workspace binding. */
export function sidebarSessionGroup(snapshot: SidebarSnapshot, mode: ConversationMode, sessionId: string): string {
  const layout = snapshot.layout.modes[mode];
  const sectionId = layout.membership[sessionId];
  if (layout.sections.some(section => section.id === sectionId)) return sidebarGroupId.section(mode, sectionId);
  const projectId = snapshot.sessionProjectIds[sessionId];
  return mode !== "chat" && layout.viewMode === "project" && projectId
    ? sidebarGroupId.project(mode, projectId) : sidebarGroupId.default(mode);
}
export function compareSidebarCreation(left: ChatSessionMeta, right: ChatSessionMeta): number {
  return left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
/** Pins stay within their group; new manual IDs append by stable creation time/id. */
export function orderSidebarSessions(sessions: readonly ChatSessionMeta[], mode: ModeSidebarLayout, groupId: string): ChatSessionMeta[] {
  const manual = new Map((mode.manualOrders[groupId] ?? []).map((id, index) => [id, index]));
  const appended = new Map(sessions.filter(session => !manual.has(session.id)).sort(compareSidebarCreation).map((session, index) => [session.id, index + manual.size]));
  return [...sessions].sort((left, right) => {
    const pinned = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
    if (pinned) return pinned;
    if (mode.sortMode === "manual") return (manual.get(left.id) ?? appended.get(left.id)!) - (manual.get(right.id) ?? appended.get(right.id)!);
    return right.updatedAt - left.updatedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  });
}

export const SIDEBAR_LAYOUT_IPC = Object.freeze({ get: "sidebar:layout:get", mutate: "sidebar:layout:mutate", changed: "sidebar:layout:changed" });

export type SidebarSnapshotReply = { ok: true; snapshot: SidebarSnapshot } | { ok: false; code: "owner_mismatch" | "storage_error" };
export interface SidebarLayoutApi { get(): Promise<SidebarSnapshotReply>; mutate(input: SidebarMutation): Promise<SidebarMutationResult | { ok: false; code: "owner_mismatch" }>; onChanged(callback: () => void): () => void }
