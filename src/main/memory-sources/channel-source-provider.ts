import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { PendingChatAttachment } from "../../shared/chat-types";
import { formatChannelUserText } from "../channels/channel-context";
import type { IncomingMessage } from "../channels/types";
import { requireChannelMemoryIngress, type ChannelMemoryIngress, type ChannelMemoryIngressContext } from "../memory-context/channel-memory-ingress";
import { parseInternalId } from "../memory-core/command-validation";
import { canonicalJson } from "../memory-core/repository-types";
import type { SourceIdentity, SourceTrust } from "../memory-core/source-contracts";
import type { ConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import type { TranscriptSnapshot } from "../orchestrator/conversation-transcript-types";
import { createMainSourceProvider, type SourceSnapshot } from "./main-source-provider";

interface Options {
  providerId: string;
  store: ConversationTranscriptStore;
  clock?: () => number;
  /** Factory-owner lifetime; captured once so replacement cannot revive old work. */
  signal?: AbortSignal;
}
const denied = (): never => { throw Error("MEMORY_CHANNEL_SOURCE_DENIED"); };
const fingerprint = (text: string, trust: SourceTrust) => createHash("sha256").update(canonicalJson({ text, state: "live", role: "user", trust })).digest("hex");
/** Pure reference projection. It does no IO and conveys no attachment authority. */
export function channelMemoryAttachments(message: IncomingMessage): PendingChatAttachment[] {
  return (message.attachments ?? []).map(item => {
    if (!["image", "file"].includes(item.kind) || typeof item.filePath !== "string" || !item.filePath.trim()
      || /[\u0000-\u001f\u007f]/.test(item.filePath) || !(path.isAbsolute(item.filePath) || path.win32.isAbsolute(item.filePath))) {
      throw Error("MEMORY_CHANNEL_ATTACHMENT_SOURCE_DENIED");
    }
    const name = path.win32.basename(path.basename(item.filePath));
    if (!name || name === "." || name === "..") throw Error("MEMORY_CHANNEL_ATTACHMENT_SOURCE_DENIED");
    return item.kind === "image" ? { kind: "image", name, filePath: item.filePath,
      ...(item.mime ? { mime: item.mime } : {}), ...(item.caption ? { caption: item.caption } : {}) }
      : { kind: "document", name, filePath: item.filePath };
  });
}
function canonicalUser(snapshot: TranscriptSnapshot, messageId: string, attachmentDigest?: string): string | null {
  const entries = snapshot.entries.filter(entry => entry.kind === "user" && entry.turnId === messageId);
  if (entries.length !== 1 || snapshot.entries.some(entry => entry.kind === "turn_rewind" && entry.payload.anchorUserTurnId === messageId)) return null;
  const entry = entries[0];
  if (entry.kind !== "user" || entry.revision !== 1 || typeof entry.payload.text !== "string") return null;
  if (attachmentDigest === undefined ? !!entry.payload.attachments?.length : canonicalJson(entry.payload.attachments ?? []) !== attachmentDigest) return null;
  return entry.payload.text;
}

/** Main's canonical commit owns provenance. Channel history rows, payload account
 * labels, model/tool text, and copied ingress JSON can never mint a direct event. */
export function createChannelSourceProvider(options: Options) {
  const providerId = parseInternalId(options.providerId), clock = options.clock ?? Date.now, signal = options.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) return denied();
  const sessions = new Map<string, { ingress: ChannelMemoryIngress; context: Readonly<ChannelMemoryIngressContext> }>();
  const receiptAttachments = new Map<string, string>();
  const receipts = new Map<string, SourceSnapshot>(), admitted = new Set<string>(), usedIngress = new WeakSet<object>();
  const key = (id: SourceIdentity) => canonicalJson(id);
  let closed = false, tail: Promise<unknown> = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => { const result = tail.then(operation); tail = result.catch(() => undefined); return result; };
  function assertOpen(): void { if (closed || signal?.aborted) return denied(); }
  function requireIngress(ingress: ChannelMemoryIngress, message?: IncomingMessage): Readonly<ChannelMemoryIngressContext> {
    assertOpen(); const context = requireChannelMemoryIngress(ingress, message); assertOpen(); return context;
  }
  function current(sessionId: string): Readonly<ChannelMemoryIngressContext> {
    assertOpen(); const session = sessions.get(sessionId); if (!session) return denied();
    return requireIngress(session.ingress);
  }
  function attach(ingress: ChannelMemoryIngress, message: IncomingMessage): Readonly<ChannelMemoryIngressContext> {
    const context = requireIngress(ingress, message), previous = sessions.get(context.sessionId);
    if (previous && (previous.context.scopeKey !== context.scopeKey || previous.context.actorKey !== context.actorKey)) return denied();
    sessions.set(context.sessionId, { ingress, context }); return context;
  }
  const token = createMainSourceProvider({ providerId,
    authorize: (scope, id) => { try { return id.providerId === providerId && current(id.sessionId).scopeKey === scope; } catch { return false; } },
    withLease: (id, operation, previous) => serialized(() => options.store.withReadLease(id.sessionId, async read => {
      const binding = current(id.sessionId);
      const assertCurrent = () => { assertOpen(); binding.assertCurrent(); assertOpen(); };
      const result = await operation(async () => {
        assertCurrent(); const snapshot = await read(); assertCurrent();
        const text = canonicalUser(snapshot, id.messageId, receiptAttachments.get(key(id))), receipt = receipts.get(key(id));
        if (receipt) return text === receipt.text ? structuredClone(receipt) : { ...receipt, state: "deleted", text: "", contentRevision: receipt.contentRevision + 1 };
        // Only a previously published encrypted source head restores provenance.
        if (!previous || previous.state !== "live" || previous.role !== "user" || !["direct-user-event", "history", "imported"].includes(previous.trust)) return denied();
        const unchanged = text !== null && fingerprint(text, previous.trust) === previous.fingerprint;
        return { ...id, generation: previous.generation, contentRevision: previous.contentRevision + (unchanged ? 0 : 1),
          role: "user", trust: previous.trust, state: unchanged ? "live" : "deleted", text: unchanged ? text! : "",
          ...(previous.occurredAt === undefined ? {} : { occurredAt: previous.occurredAt }) };
      });
      assertCurrent(); return result;
    })),
  });
  return Object.freeze({ token, attach,
    commitUserEvent(ingress: ChannelMemoryIngress, input: { message: IncomingMessage; messageId: string; text: string }): Promise<SourceIdentity> {
      const message = input.message, requestedId = input.messageId, text = input.text;
      return serialized(async () => {
        const context = attach(ingress, message), messageId = parseInternalId(requestedId);
        const assertCurrent = () => { assertOpen(); context.assertCurrent(); assertOpen(); };
        const attachments = channelMemoryAttachments(message);
        if (context.provenance === "source-less" || typeof text !== "string" || !text.trim() && !attachments.length
          || Buffer.byteLength(text) > 65536 || text !== formatChannelUserText(message) || usedIngress.has(ingress)) return denied();
        const identity = Object.freeze({ providerId, sessionId: context.sessionId, messageId }), identityKey = key(identity);
        if (admitted.has(identityKey) || receipts.has(identityKey)) return denied();
        const snapshot = await options.store.read(context.sessionId); assertCurrent();
        if (snapshot.entries.some(entry => entry.turnId === messageId)) return denied();
        const occurredAt = clock(); assertCurrent(); if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) return denied();
        const trust: SourceTrust = context.provenance === "direct-text" ? "direct-user-event" : context.provenance === "asr" ? "imported" : "history";
        admitted.add(identityKey); usedIngress.add(ingress);
        try {
          await options.store.append(context.sessionId, { id: `channel-user:v1:${messageId}:r1`, kind: "user", turnId: messageId, revision: 1, at: occurredAt, payload: { text, ...(attachments.length ? { attachments } : {}) } }, {
            throughSeq: snapshot.throughSeq,
            validate: async () => { assertCurrent(); },
            commit: write => { assertCurrent(); return write(); },
          });
          assertCurrent();
          if (attachments.length) receiptAttachments.set(identityKey, canonicalJson(attachments));
          receipts.set(identityKey, Object.freeze({ ...identity, text, role: "user", trust, state: "live", contentRevision: 1, generation: randomUUID(), occurredAt }));
          assertCurrent(); return identity;
        } catch (error) {
          // An uncertain or persisted append cannot be retried as a fresh event.
          const state = await options.store.read(context.sessionId).catch(() => undefined);
          if (state && !state.entries.some(entry => entry.turnId === messageId)) { admitted.delete(identityKey); usedIngress.delete(ingress); }
          throw error;
        }
      });
    },
    close(): Promise<void> { closed = true; return tail.then(() => undefined); },
  });
}
