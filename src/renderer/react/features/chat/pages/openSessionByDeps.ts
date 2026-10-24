/** Session opening keeps stale requests distinct from unavailable sessions. */
export type ReactSessionMode = "chat" | "work" | "code";
export type SessionSelectionResult = "selected" | "stale" | "unavailable";
export type OpenSessionResult =
  | { status: "opened"; mode: ReactSessionMode }
  | { status: "stale" | "unavailable" };

// 旧会话模式到当前模式的映射：learn / daily 已并入 work
const SESSION_MODE_TABLE: Record<string, ReactSessionMode> = { chat: "chat", work: "work", code: "code", learn: "work", daily: "work" };

export function normalizeSessionMode(mode: string | undefined): ReactSessionMode | null {
  if (typeof mode !== "string") return null;
  return Object.prototype.hasOwnProperty.call(SESSION_MODE_TABLE, mode) ? SESSION_MODE_TABLE[mode] : null;
}

export type OpenSessionArgs = {
  selectSession: (sessionId: string, mode: ReactSessionMode) => Promise<SessionSelectionResult>;
  getSession: (sessionId: string) => Promise<{ mode?: string } | null>;
  isCurrent: () => boolean;
  sessionId: string;
};

export async function openSessionByIdWithDeps(args: OpenSessionArgs): Promise<OpenSessionResult> {
  if (!args.isCurrent()) return { status: "stale" };
  try {
    const session = await args.getSession(args.sessionId);
    if (!args.isCurrent()) return { status: "stale" };
    const mode = session && normalizeSessionMode(session.mode);
    if (!mode) return { status: "unavailable" };
    const selected = await args.selectSession(args.sessionId, mode);
    if (!args.isCurrent() || selected === "stale") return { status: "stale" };
    return selected === "selected" ? { status: "opened", mode } : { status: "unavailable" };
  } catch (error) {
    if (!args.isCurrent()) return { status: "stale" };
    throw error;
  }
}

export interface BootstrapReactSessionArgs {
  urlSessionId: string | null;
  currentMode: ReactSessionMode;
  openSession: (sessionId: string) => Promise<OpenSessionResult>;
  refreshSessions: (mode: ReactSessionMode, selectCurrent: boolean) => Promise<void>;
}

export async function bootstrapReactSession(args: BootstrapReactSessionArgs): Promise<void> {
  if (args.urlSessionId) {
    let opened: OpenSessionResult = { status: "unavailable" };
    try {
      opened = await args.openSession(args.urlSessionId);
    } catch {
      // Opening a specific session is best-effort; the real list/select path is authoritative.
    }
    if (opened.status === "stale") return;
    await args.refreshSessions(args.currentMode, opened.status !== "opened");
    return;
  }
  await args.refreshSessions(args.currentMode, true);
}
