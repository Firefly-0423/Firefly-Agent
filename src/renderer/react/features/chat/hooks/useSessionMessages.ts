import { useState } from "react";
import type { ComposerAttachment } from "../components/ChatComposer";
import type { ChatMessageItem } from "../components/ChatMessageList";
import type { ConversationMode } from "../../../../../shared/chat-types";
import { isConversationMode } from "../pages/chat-page-normalizers";
import { patchSessionMessage, hydrateSessionMessages } from "../pages/session-runtime-state";

export type SessionMessagesApi = {
  patchMessageAttachments: (sessionId: string, messageId: string, updater: (attachments: ComposerAttachment[]) => ComposerAttachment[]) => void;
  appendMessages: (sessionId: string, items: ChatMessageItem[]) => void;
  replaceSessionMessages: (sessionId: string, next: ChatMessageItem[]) => void;
  hydrateMessages: (sessionId: string, storedMessages: ChatMessageItem[], hasActiveRun: boolean) => void;
  patchMessage: (targetScope: ConversationMode | string, id: string, patch: Partial<ChatMessageItem>) => void;
  messagesBySession: Record<string, ChatMessageItem[]>;
};

export function useSessionMessages(getActiveSessionId: (mode: ConversationMode) => string | undefined): SessionMessagesApi {
  const [sessions, updateSessions] = useState<Record<string, ChatMessageItem[]>>({});
  function patchMessage(targetScope: ConversationMode | string, id: string, patch: Partial<ChatMessageItem>) {
    updateSessions((previous) => {
      let owner = targetScope;
      if (isConversationMode(targetScope)) {
        const matching = Object.entries(previous).find(([, entries]) => entries.some((entry) => entry.id === id));
        owner = matching?.[0] ?? getActiveSessionId(targetScope)!;
      }
      return owner ? patchSessionMessage(previous, owner, id, patch) : previous;
    });
  }
  function hydrateMessages(sessionId: string, storedMessages: ChatMessageItem[], hasActiveRun: boolean) {
    updateSessions((previous) => hydrateSessionMessages(previous, sessionId, storedMessages, hasActiveRun));
  }
  function replaceSessionMessages(sessionId: string, next: ChatMessageItem[]) {
    updateSessions((previous) => ({ ...previous, [sessionId]: next }));
  }
  function appendMessages(sessionId: string, items: ChatMessageItem[]) {
    updateSessions((previous) => ({ ...previous, [sessionId]: [...(previous[sessionId] ?? []), ...items] }));
  }
  function patchMessageAttachments(sessionId: string, messageId: string, updater: (attachments: ComposerAttachment[]) => ComposerAttachment[]) {
    updateSessions((previous) => {
      const entries = (previous[sessionId] ?? []).map((entry) => {
        if (entry.id !== messageId) return entry;
        return { ...entry, attachments: updater(entry.attachments ?? []) };
      });
      return { ...previous, [sessionId]: entries };
    });
  }
  return {
    messagesBySession: sessions, patchMessage, hydrateMessages, replaceSessionMessages, appendMessages, patchMessageAttachments,
  };
}
