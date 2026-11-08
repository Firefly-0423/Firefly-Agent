import type { ChatSession } from "../../../../../shared/chat-types";
import type { TodoStateBySession } from "./session-runtime-state";

export function restoreSessionTodos(current: TodoStateBySession, sessionId: string, session: ChatSession, active: boolean): TodoStateBySession {
  const snapshot = session.messages.findLast(message => message.runSnapshot)?.runSnapshot;
  if (!snapshot?.todos || (active && current[sessionId])) return current;
  return { ...current, [sessionId]: { runId: snapshot.runId, todos: snapshot.todos, updatedAt: snapshot.updatedAt } };
}
