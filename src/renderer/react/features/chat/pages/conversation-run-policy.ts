import type { ConversationMode } from "../../../../../shared/chat-types";

export function shouldListenForDeferredPlanEvents(mode: ConversationMode): boolean {
  const supportsPlans = mode === "code" || mode === "chat";
  return supportsPlans;
}
