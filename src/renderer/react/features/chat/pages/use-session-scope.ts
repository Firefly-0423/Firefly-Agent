import { useRef } from "react";
import type { ConversationMode } from "../../../../../shared/chat-types";

/** Bridge callbacks use stable refs but always target the currently rendered scope. */
export function useSessionScope(mode: ConversationMode, ids: Partial<Record<ConversationMode, string>>) {
  const activeSessionId = ids[mode];
  const scopeKey = activeSessionId ?? `mode:${mode}`;
  const activeModeRef = useRef(mode);
  const activeSessionIdsRef = useRef(ids);
  const activeScopeRef = useRef(scopeKey);
  const sessionSelectionGeneration = useRef(0);
  activeModeRef.current = mode;
  activeSessionIdsRef.current = ids;
  activeScopeRef.current = scopeKey;
  return { activeSessionId, scopeKey, activeModeRef, activeSessionIdsRef, activeScopeRef, sessionSelectionGeneration };
}
