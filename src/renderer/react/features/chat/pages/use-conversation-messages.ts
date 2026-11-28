import type { ConversationMode } from "../../../../../shared/chat-types";
import { useSessionMessages } from "../hooks/useSessionMessages";
import { useSchedulerEvents } from "../hooks/useSchedulerEvents";
import { useChannelMirrorEvents } from "../hooks/useChannelMirrorEvents";
import { chatStore } from "./chat-page-bridge";

/** Connect external message feeds to the same per-session message store as chat. */
export function useConversationMessages(sessionForMode: (mode: ConversationMode) => string | undefined, activeMode: () => ConversationMode) {
  const messages = useSessionMessages(sessionForMode);
  const currentSession = () => sessionForMode(activeMode());
  useSchedulerEvents({
    getActiveSessionId: currentSession,
    appendMessages: messages.appendMessages,
    patchMessage: messages.patchMessage,
    persistMessage: (sessionId, message) => { void chatStore()?.append(sessionId, message); },
  });
  useChannelMirrorEvents({ getActiveSessionId: currentSession, appendMessages: messages.appendMessages });
  return messages;
}
