// 侧栏"按状态"分组：需要你处理 → 进行中 → 已完成，组内按最近更新排序。
// 只在本机记住是否开启（每种模式各记一份），不改主进程里的侧栏布局。
import { useCallback, useState } from "react";
import type { ChatSessionMeta, ConversationMode } from "../../../../../shared/chat-types";
import type { SessionInteractionState } from "./session-runtime-state";

export type SessionStatus = "needs-input" | "working" | "done";
export const STATUS_ORDER: readonly SessionStatus[] = ["needs-input", "working", "done"];
export const statusGroupId = (status: SessionStatus) => `status:${status}`;

export function sessionStatus(id: string, running: ReadonlySet<string>, needsInput: ReadonlySet<string>): SessionStatus {
  // A run that is waiting on the user is "needs input", not "working": the user is the one holding it up.
  if (needsInput.has(id)) return "needs-input";
  return running.has(id) ? "working" : "done";
}

/** Sessions ordered by status, then most recently updated first, each tagged with its group. */
export function groupByStatus(sessions: readonly ChatSessionMeta[], running: ReadonlySet<string>, needsInput: ReadonlySet<string>): Array<{ session: ChatSessionMeta; status: SessionStatus }> {
  return sessions
    .map(session => ({ session, status: sessionStatus(session.id, running, needsInput) }))
    .sort((left, right) => STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status) || right.session.updatedAt - left.session.updatedAt);
}

/** Sessions with an approval or question waiting, or a plan waiting for review. */
export function sessionsNeedingInput(interactions: SessionInteractionState, planReviews: Readonly<Record<string, { phase: string } | undefined>>): string[] {
  const ids = new Set<string>();
  for (const [id, entry] of Object.entries(interactions)) if (!entry.resolved || entry.queued.length > 0) ids.add(id);
  for (const [id, plan] of Object.entries(planReviews)) if (plan?.phase === "review") ids.add(id);
  return [...ids].sort();
}

const storageKey = (mode: ConversationMode) => `ff.sidebar.statusView.${mode}`;

export function readStatusView(mode: ConversationMode): boolean {
  try { return window.localStorage.getItem(storageKey(mode)) === "1"; } catch { return false; }
}

/** Whether the sidebar is grouped by status in this mode; remembered on this device. */
export function useStatusView(mode: ConversationMode): [boolean, (on: boolean) => void] {
  const [byMode, setByMode] = useState<Partial<Record<ConversationMode, boolean>>>({});
  const on = byMode[mode] ?? readStatusView(mode);
  const set = useCallback((next: boolean) => {
    setByMode(current => ({ ...current, [mode]: next }));
    try { window.localStorage.setItem(storageKey(mode), next ? "1" : "0"); } catch { /* lasts for this window only */ }
  }, [mode]);
  return [on, set];
}
