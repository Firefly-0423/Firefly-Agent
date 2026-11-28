import { randomUUID } from "crypto";

interface ContextRefEntry<T = unknown> {
  value: T;
  expiresAt: number;
  kind: string;
  domain: string;
  conversationId: string;
  contextRef: string;
}
interface ContextRefRegistryOptions {
  createId?: () => string;
  maxRefsPerConversation?: number;
  now?: () => number;
}

export class ContextRefRegistry {
  private readonly records = new Map<string, ContextRefEntry>();
  private readonly clock: () => number;
  private readonly limit: number;
  private readonly nextId: () => string;

  constructor(options: ContextRefRegistryOptions = {}) {
    this.clock = options.now ?? Date.now;
    this.limit = Math.max(1, options.maxRefsPerConversation ?? 600);
    this.nextId = options.createId ?? (() => `ctx_${randomUUID()}`);
  }

  issue<T>(input: { conversationId: string; domain: string; kind: string; expiresAt: number; value: T }): string {
    const timestamp = this.clock();
    for (const [id, record] of this.records) {
      if (record.conversationId === input.conversationId && timestamp >= record.expiresAt) this.records.delete(id);
    }
    const owned = [...this.records.values()].filter((record) => record.conversationId === input.conversationId);
    while (owned.length >= this.limit) {
      const removed = owned.shift();
      if (removed) this.records.delete(removed.contextRef);
    }
    let issued: string;
    do { issued = this.nextId(); } while (this.records.has(issued));
    this.records.set(issued, {
      contextRef: issued,
      conversationId: input.conversationId, domain: input.domain,
      kind: input.kind, expiresAt: input.expiresAt,
      value: structuredClone(input.value),
    });
    return issued;
  }

  resolve<T>(contextRef: string, conversationId: string, expectedKind?: string): T {
    const record = this.records.get(contextRef);
    if (!record) throw new Error("E_CONTEXT_REF_NOT_FOUND");
    if (record.conversationId !== conversationId) throw new Error("E_CONTEXT_REF_CONVERSATION_MISMATCH");
    if (this.clock() >= record.expiresAt) {
      this.records.delete(contextRef);
      throw new Error("E_CONTEXT_REF_EXPIRED");
    }
    if (expectedKind && record.kind !== expectedKind) throw new Error("E_CONTEXT_REF_KIND_MISMATCH");
    return structuredClone(record.value) as T;
  }

  clear(conversationId?: string): void {
    if (conversationId !== undefined) {
      for (const [id, record] of this.records) {
        if (record.conversationId === conversationId) this.records.delete(id);
      }
    } else this.records.clear();
  }
}
