import type { IpcMainInvokeEvent } from "electron";
import type { ChatSession } from "../../../shared/chat-types";
import type { RunStatusItem, RunStatusRequest } from "../../../shared/run-status";
import type { GetChatWindowFn } from "./agui-bridge";
import type { ActiveChatTarget } from "../../platform/interaction/active-chat-target";

interface QueryContext {
  window: ReturnType<GetChatWindowFn>;
  target: ActiveChatTarget | null;
  getSession: (sessionId: string) => ChatSession | null;
  getStatus: (sessionId: string, assistantTurnId: string, session: ChatSession) => RunStatusItem | undefined;
}
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);

/** Fail closed before reading run data; unavailable has the same shape for all ownership failures. */
export function queryRunStatus(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">, payload: unknown, context: QueryContext): RunStatusItem[] {
  const request = payload as RunStatusRequest | null;
  if (!request || !validId(request.sessionId) || !/^[a-zA-Z0-9_-]+$/.test(request.sessionId)
      || !Array.isArray(request.candidates) || request.candidates.length > 512
      || request.candidates.some(candidate => !candidate || !validId(candidate.assistantTurnId) || (candidate.runId !== undefined && !validId(candidate.runId)))) return [];
  const unavailable = (): RunStatusItem[] => request.candidates.map(({ assistantTurnId }) => ({ assistantTurnId, phase: "unavailable" }));
  const { sender, senderFrame } = event;
  const { window, target } = context;
  if (!sender || sender.isDestroyed() || !window || window.isDestroyed() || window.webContents !== sender
      || !senderFrame || senderFrame !== sender.mainFrame || !target || target.webContentsId !== sender.id || target.sessionId !== request.sessionId) return unavailable();
  try {
    const session = context.getSession(request.sessionId);
    if (!session || session.id !== request.sessionId || session.mode !== target.mode) return unavailable();
    return request.candidates.map(({ assistantTurnId, runId }) => {
      const status = context.getStatus(request.sessionId, assistantTurnId, session);
      if (!status || status.phase === "unavailable" || status.sessionId !== request.sessionId || status.assistantTurnId !== assistantTurnId || (runId !== undefined && runId !== status.runId)) return { assistantTurnId, phase: "unavailable" };
      return status;
    });
  } catch { return unavailable(); }
}
