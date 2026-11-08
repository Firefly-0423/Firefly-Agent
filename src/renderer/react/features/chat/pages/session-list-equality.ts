import type { ChatSessionMeta } from "../../../../../shared/chat-types";

const sidebarFields = [
  "id", "title", "identityId", "createdAt", "updatedAt", "messageCount", "purpose",
  "mode", "workspaceRoot", "workspaceDisplayName", "pinned",
] as const satisfies readonly (keyof ChatSessionMeta)[];

/** Keep the existing list reference when its visible metadata has not changed. */
export function sameSessionList(previous: ChatSessionMeta[], next: ChatSessionMeta[]): boolean {
  return previous.length === next.length && previous.every((item, index) =>
    sidebarFields.every(field => item[field] === next[index]![field]));
}
