import type { ConversationMode } from "../../../../../shared/chat-types";

type BusyModes = Partial<Record<ConversationMode, boolean>>;

/** The absence of a key represents an idle mode. */
export function updateModeBusy(current: BusyModes, mode: ConversationMode, busy: boolean): BusyModes {
  const next = { ...current };
  if (busy) next[mode] = true;
  else delete next[mode];
  return next;
}
