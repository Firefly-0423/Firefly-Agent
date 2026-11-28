/**
 * Process-local registry of temporary (zero-persistence) conversations.
 *
 * A conversation is registered when its temporary session is created, before anything
 * is written for it. The conversation stores consult it so that a registered
 * conversation lives only in this process's memory: nothing for it is written to disk,
 * and it is gone when the process exits. The registry itself is never persisted.
 */
const ephemeral = new Set<string>();

export const ephemeralConversations = Object.freeze({
  /**
   * Register before the first write. Production never releases an id: a late write from a
   * run that was still unwinding when its conversation was deleted must not reach disk.
   * Ids are random UUIDs, so the registry only grows by a short string per temporary chat.
   */
  mark(conversationId: string): void {
    if (typeof conversationId !== "string" || !conversationId) throw new Error("EPHEMERAL_CONVERSATION_ID_INVALID");
    ephemeral.add(conversationId);
  },
  has(conversationId: string): boolean { return ephemeral.has(conversationId); },
  /** True once any temporary conversation exists in this process, for diagnostics that cannot tell whose content they handle. */
  any(): boolean { return ephemeral.size > 0; },
  /** Test support only. */
  release(conversationId: string): void { ephemeral.delete(conversationId); },
});
