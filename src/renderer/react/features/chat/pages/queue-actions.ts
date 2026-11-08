import type { ConversationMode } from "../../../../../shared/chat-types";
import type { ChatStoreApi } from "./chat-page-bridge";
import type { PendingQueueFlow } from "./pending-queue-flow";

type Ports = {
  getStore(): ChatStoreApi | undefined;
  sync(sessionId: string): Promise<void> | void;
  error(reason?: string): void;
  edit: PendingQueueFlow["editMessage"];
  parse(mode: ConversationMode, text: string): { rawContent: string; visibleContent: string; userSticker?: string };
};

export function queueActions(ports: Ports) {
  return {
    async remove(sessionId: string, messageId: string) {
      const store = ports.getStore();
      if (!store) return;
      const result = await store.pendingRemove(sessionId, messageId);
      if (!result.ok) { ports.error(result.error); return; }
      await ports.sync(sessionId);
    },
    async edit(sessionId: string, mode: ConversationMode, id: string, content: string) {
      const parsed = ports.parse(mode, content);
      if (!parsed.rawContent) return false;
      return ports.edit(sessionId, id, parsed);
    },
  };
}
