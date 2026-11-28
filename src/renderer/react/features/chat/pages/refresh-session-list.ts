import type { ConversationMode } from "../../../../../shared/chat-types";

type Ports<T> = {
  list(mode: ConversationMode): Promise<T[]>;
  generation(): number;
  active(mode: ConversationMode): string | undefined;
  apply(mode: ConversationMode, entries: T[]): void;
  select(id: string, mode: ConversationMode, generation?: number): Promise<unknown> | void;
  clear(mode: ConversationMode): void;
};

/** Discard obsolete list responses before they can change the visible selection. */
export async function refreshSessionList<T extends { id: string }>(mode: ConversationMode, selectCurrent: boolean, generation: number | undefined, ports: Ports<T>): Promise<void> {
  const entries = await ports.list(mode);
  if (generation !== undefined && generation !== ports.generation()) return;
  ports.apply(mode, entries);
  if (!selectCurrent) return;
  const active = ports.active(mode);
  const selected = entries.some(entry => entry.id === active) ? active : entries[0]?.id;
  if (selected) await ports.select(selected, mode, generation);
  else ports.clear(mode);
}
