import { useCallback, useRef, useState } from "react";
import type { ConversationMode } from "../../../../../shared/chat-types";
import type { ChatMessageItem } from "../components/ChatMessageList";
import { resolveRevisableLastTurn } from "../components/last-turn-actions";
import type { ChatStoreApi } from "./chat-page-bridge";
import type { AgentRunInput } from "./run/AgentRunController";
import { reviseLastTurn } from "./last-turn-revision";

type Host = {
  mode(): ConversationMode;
  busy(): boolean;
  sessionId(): string | undefined;
  messages(sessionId: string): ChatMessageItem[];
  store(): ChatStoreApi | undefined;
  publish(sessionId: string, messages: ChatMessageItem[]): void;
  start(input: AgentRunInput): void;
};

/** Stable UI callbacks always use the newest host while fencing concurrent revisions. */
export function useLastTurnActions(host: Host) {
  const current = useRef(host);
  current.current = host;
  const starting = useRef(false);
  const [revisionBusy, setRevisionBusy] = useState(false);
  const restart = useCallback(async (userId: string, assistantId: string, disposition: "replace_user" | "keep_user", content?: string) => {
    const h = current.current;
    if (h.mode() !== "chat" || h.busy() || starting.current) return false;
    const store = h.store();
    const sessionId = h.sessionId();
    if (!store || !sessionId) return false;
    starting.current = true;
    setRevisionBusy(true);
    try {
      return await reviseLastTurn({ sessionId, userId, assistantId, disposition, content }, {
        store, publish: h.publish, start: h.start,
        newId: () => crypto.randomUUID(), now: () => Date.now(),
      });
    } catch (error) {
      console.error("[Firefly React] 重建最后一轮对话失败:", error);
      return false;
    } finally {
      starting.current = false;
      setRevisionBusy(false);
    }
  }, []);
  const edit = useCallback(async (messageId: string, content: string) => {
    const h = current.current;
    const sessionId = h.sessionId();
    const last = resolveRevisableLastTurn(sessionId ? h.messages(sessionId) : [], "chat");
    if (!last || last.userMessageId !== messageId) return false;
    return restart(last.userMessageId, last.assistantMessageId, "replace_user", content);
  }, [restart]);
  const regenerate = useCallback(async (userId: string, assistantId: string) =>
    restart(userId, assistantId, "keep_user"), [restart]);
  return { edit, regenerate, revisionBusy };
}
