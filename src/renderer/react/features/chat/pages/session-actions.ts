import type { ConversationMode } from "../../../../../shared/chat-types";
import type { ChatStoreApi } from "./chat-page-bridge";

type Refresh = (mode: ConversationMode, selectCurrent: boolean) => Promise<void> | void;

/** Mutations retain their own refresh policy so callers do not reselect after every edit. */
export function sessionActions(getStore: () => ChatStoreApi | undefined, refresh: Refresh) {
  return {
    async rename(mode: ConversationMode, id: string, input: string) {
      const store = getStore();
      if (!store?.rename) return;
      const title = input.trim();
      if (!title) return;
      await store.rename(id, title);
      await refresh(mode, false);
    },
    async remove(mode: ConversationMode, id: string) {
      const store = getStore();
      if (store && await store.delete(id)) await refresh(mode, true);
    },
    async pin(mode: ConversationMode, id: string, value: boolean) {
      const store = getStore();
      if (!store?.setPinned) return;
      await store.setPinned(id, value);
      await refresh(mode, false);
    },
  };
}
