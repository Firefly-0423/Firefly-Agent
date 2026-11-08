import type { RefObject } from "react";
import type { ChatMessageItem } from "../components/ChatMessageList";
import { useComposerAttachments } from "../hooks/useComposerAttachments";
import { sessionInteraction, sessionInteractionPending, type SessionInteractionState } from "./session-runtime-state";

type Input = {
  sessionId?: string; scopeKey: string; activeScope: RefObject<string>;
  drafts: Record<string, string>; messages: Record<string, ChatMessageItem[]>;
  interactions: SessionInteractionState;
  patchAttachments: Parameters<typeof useComposerAttachments>[0]["patchMessageAttachments"];
};

/** Project the selected conversation into the composer and its attachment scope. */
export function useComposerScope(input: Input) {
  const attachments = useComposerAttachments({
    scopeKey: input.scopeKey,
    getActiveScope: () => input.activeScope.current,
    patchMessageAttachments: input.patchAttachments,
  });
  const messages = input.sessionId ? input.messages[input.sessionId] ?? [] : [];
  const card = sessionInteraction(input.interactions, input.sessionId);
  return {
    ...attachments,
    draft: input.drafts[input.scopeKey] ?? "", messages, hasMessages: messages.length > 0,
    composerInteraction: card?.interaction, interactionBusy: card?.busy ?? false,
    interactionPending: sessionInteractionPending(card),
  };
}
