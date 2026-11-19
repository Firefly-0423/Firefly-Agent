import type { ConversationMode } from "../../../../../shared/chat-types";

export function shouldListenForDeferredPlanEvents(mode: ConversationMode): boolean {
  return mode === "code";
}
