import type { ChannelCapability, ChannelId, ChannelStatus, MessageHandler, OutgoingMessage } from "../types";

export interface ChannelAdapter {
  readonly capability: ChannelCapability;
  readonly displayName: string;
  readonly id: ChannelId;
  onMessage: MessageHandler | null;
  getStatus(): ChannelStatus;
  getMemoryAccountIdentity?(): ChannelMemoryAccountIdentity | null;
  send(msg: OutgoingMessage): Promise<{ ok: boolean; error?: string }>;
  stop(): Promise<void>;
  start(): Promise<void>;
}
export type ChannelMemoryAccountIdentity = Readonly<{ revision: number; accountKey: string }>;

const cancellationByIdentity = new WeakMap<object, AbortController>();
let revisionSequence = 0;

export function setAdapterHandler(adapter: ChannelAdapter, handler: MessageHandler | null): void {
  adapter.onMessage = handler;
}
export function getChannelMemoryAccountSignal(identity: unknown): AbortSignal | null {
  return typeof identity === "object" && identity !== null
    ? cancellationByIdentity.get(identity)?.signal ?? null : null;
}
export function createChannelMemoryAccountIdentity() {
  let snapshot: ChannelMemoryAccountIdentity | null = null;
  let generation = 0;
  function invalidate(): number {
    const ticket = ++generation;
    const revoked = snapshot;
    snapshot = null;
    // 回调重入时，旧身份必须已经失效。
    if (revoked) cancellationByIdentity.get(revoked)!.abort();
    return ticket;
  }
  return {
    read: (): ChannelMemoryAccountIdentity | null => snapshot,
    revoke: (): void => { invalidate(); },
    authenticate: (accountKey: string): void => {
      if (snapshot?.accountKey === accountKey) return;
      const ticket = invalidate();
      if (ticket !== generation) return;
      snapshot = Object.freeze({ accountKey, revision: ++revisionSequence });
      cancellationByIdentity.set(snapshot, new AbortController());
    },
  };
}
