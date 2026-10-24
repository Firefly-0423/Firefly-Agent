import { useCallback, useState } from "react";
import type { ConversationMode } from "../../../../../shared/chat-types";

const storageKey = (mode: ConversationMode) => `ff.sidebar.closedTiers.${mode}`;
function readClosed(mode: ConversationMode): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey(mode)) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

/** Which of 置顶 / 项目 / 最近 are folded in this mode: all open until closed once, then remembered on this device. */
export function useClosedTiers(mode: ConversationMode): [ReadonlySet<string>, (tierId: string) => void] {
  const [byMode, setByMode] = useState<Partial<Record<ConversationMode, string[]>>>({});
  const closed = byMode[mode] ?? readClosed(mode);
  const toggle = useCallback((tierId: string) => {
    const base = byMode[mode] ?? readClosed(mode);
    const next = base.includes(tierId) ? base.filter(id => id !== tierId) : [...base, tierId];
    setByMode(current => ({ ...current, [mode]: next }));
    try { window.localStorage.setItem(storageKey(mode), JSON.stringify(next)); } catch { /* lasts for this window only */ }
  }, [byMode, mode]);
  return [new Set(closed), toggle];
}
