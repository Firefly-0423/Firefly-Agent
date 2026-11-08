import type { ChatSessionMeta } from "../../../../../shared/chat-types";
import { statusGroupId, type SessionStatus } from "../pages/sidebar-status";

export function sessionGroup(session: ChatSessionMeta, options: {
  status?: SessionStatus;
  groups: ReadonlyMap<string, string>;
  projects: boolean;
}): string {
  if (options.status) return statusGroupId(options.status);
  const configured = options.groups.get(session.id);
  if (configured !== undefined) return configured;
  if (options.projects) return session.workspaceRoot ?? `unbound:${session.id}`;
  return session.pinned ? "pinned" : "recent";
}

export interface ProjectSummary {
  name: string;
  workspaceRoot?: string;
  conversationCount: number;
  updatedAt: number;
}

/** Preserve first-seen project names and order while collecting counts and last activity. */
export function summarizeProjects(sessions: ChatSessionMeta[], unboundName: () => string): Map<string, ProjectSummary> {
  return sessions.reduce((projects, session) => {
    const id = session.workspaceRoot ?? `unbound:${session.id}`;
    const previous = projects.get(id);
    projects.set(id, previous ? {
      ...previous,
      conversationCount: previous.conversationCount + 1,
      updatedAt: Math.max(previous.updatedAt, session.updatedAt),
    } : {
      name: session.workspaceDisplayName ?? unboundName(),
      workspaceRoot: session.workspaceRoot,
      conversationCount: 1,
      updatedAt: session.updatedAt,
    });
    return projects;
  }, new Map<string, ProjectSummary>());
}
