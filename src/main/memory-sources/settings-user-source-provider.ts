import { createHash, randomUUID } from "node:crypto";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { parseInternalId } from "../memory-core/command-validation";
import { canonicalJson } from "../memory-core/repository-types";
import type { SourceIdentity } from "../memory-core/source-contracts";
import type { ConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import type { TranscriptSnapshot } from "../orchestrator/conversation-transcript-types";
import { createMainSourceProvider, type SourceSnapshot } from "./main-source-provider";

type Event = Pick<IpcMainInvokeEvent, "sender" | "senderFrame">;
interface Options {
  scopeKey: string;
  providerId: string;
  sessionId: string;
  store: ConversationTranscriptStore;
  clock?: () => number;
  signal?: AbortSignal;
  getSettingsWindow(): Pick<BrowserWindow, "webContents" | "isDestroyed"> | null;
}
const denied = (): never => { throw Error("MEMORY_USER_SOURCE_DENIED"); };
const forbidden = (): never => { throw Error("MEMORY_SETTINGS_FORBIDDEN"); };
const fingerprint = (text: string) => createHash("sha256").update(canonicalJson({ text, state: "live", role: "user", trust: "direct-user-event" })).digest("hex");

/** Settings clicks are separate Main-authenticated user events. Persisted role labels
 * never mint provenance; restart restoration requires an existing encrypted head. */
export function createSettingsUserSourceProvider(options: Options) {
  const scopeKey = parseInternalId(options.scopeKey), providerId = parseInternalId(options.providerId), sessionId = parseInternalId(options.sessionId);
  const clock = options.clock ?? Date.now, lifetime = options.signal;
  const grants = new WeakMap<object, { event: Event; window: NonNullable<ReturnType<Options["getSettingsWindow"]>> }>();
  const admissions = new WeakMap<object, { grant: object; identity: SourceIdentity; text: string; throughSeq: number; at: number }>();
  const admitted = new Set<string>(), receipts = new Map<string, SourceSnapshot>();
  let closed = false, tail: Promise<unknown> = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => { const result = tail.then(operation); tail = result.catch(() => undefined); return result; };
  function requireGrant(grant: object): void {
    const state = grant && typeof grant === "object" ? grants.get(grant) : undefined;
    if (closed || lifetime?.aborted || !state) return forbidden();
    const window = options.getSettingsWindow(), { sender, senderFrame } = state.event;
    if (!window || window !== state.window || window.isDestroyed() || sender.isDestroyed()
      || window.webContents !== sender || !senderFrame || senderFrame !== sender.mainFrame) { grants.delete(grant); return forbidden(); }
  }
  function user(snapshot: TranscriptSnapshot, messageId: string): string | null {
    const entries = snapshot.entries.filter(entry => entry.kind === "user" && entry.turnId === messageId);
    if (entries.length !== 1 || snapshot.entries.some(entry => entry.kind === "turn_rewind" && entry.payload.anchorUserTurnId === messageId)) return null;
    const entry = entries[0];
    if (entry.kind !== "user" || entry.revision !== 1 || entry.payload.attachments?.length || typeof entry.payload.text !== "string") return null;
    return entry.payload.text;
  }
  const token = createMainSourceProvider({ providerId,
    authorize: (scope, identity) => !closed && !lifetime?.aborted && scope === scopeKey && identity.providerId === providerId && identity.sessionId === sessionId,
    withLease: (identity, operation, previous) => serialized(() => options.store.withReadLease(sessionId, async read => {
      if (closed || lifetime?.aborted) return denied();
      const result = await operation(async () => {
        if (closed || lifetime?.aborted || identity.providerId !== providerId || identity.sessionId !== sessionId) return denied();
        const snapshot = await read(); if (closed || lifetime?.aborted) return denied();
        const text = user(snapshot, identity.messageId), receipt = receipts.get(identity.messageId);
        if (receipt) return text === receipt.text ? structuredClone(receipt) : { ...receipt, state: "deleted", text: "", contentRevision: receipt.contentRevision + 1 };
        if (!previous || previous.state !== "live" || previous.role !== "user" || previous.trust !== "direct-user-event") return denied();
        const unchanged = text !== null && fingerprint(text) === previous.fingerprint;
        return { ...identity, generation: previous.generation, contentRevision: previous.contentRevision + (unchanged ? 0 : 1),
          role: "user", trust: "direct-user-event", state: unchanged ? "live" : "deleted", text: unchanged ? text! : "",
          ...(previous.occurredAt === undefined ? {} : { occurredAt: previous.occurredAt }) };
      });
      if (closed || lifetime?.aborted) return denied();
      return result;
    })),
  });
  return Object.freeze({ token, sessionId,
    authorize(event: Event): object {
      const window = options.getSettingsWindow();
      if (closed || lifetime?.aborted || !window || window.isDestroyed() || !event || event.sender !== window.webContents
        || event.sender.isDestroyed() || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) return forbidden();
      const grant = Object.freeze({}); grants.set(grant, { window, event: { sender: event.sender, senderFrame: event.senderFrame } }); return grant;
    },
    require: requireGrant,
    release(grant: object) { grants.delete(grant); },
    commitUserEvent(grant: object, input: { messageId: string; text: string }): Promise<SourceIdentity> {
      return serialized(async () => {
        requireGrant(grant);
        const messageId = parseInternalId(input.messageId), text = input.text;
        if (typeof text !== "string" || !text.trim() || text.length > 65536 || admitted.has(messageId) || receipts.has(messageId)) return denied();
        const snapshot = await options.store.read(sessionId); requireGrant(grant);
        if (snapshot.entries.some(entry => entry.turnId === messageId)) return denied();
        const at = clock(); if (!Number.isSafeInteger(at) || at < 0) return denied();
        const identity = Object.freeze({ providerId, sessionId, messageId }), ticket = Object.freeze({});
        admitted.add(messageId); admissions.set(ticket, { grant, identity, text, throughSeq: snapshot.throughSeq, at });
        try {
          await options.store.append(sessionId, { id: `settings-user:v1:${messageId}:r1`, kind: "user", turnId: messageId, revision: 1, at, payload: { text } }, {
            throughSeq: snapshot.throughSeq,
            validate: async () => { requireGrant(grant); if (!admissions.has(ticket)) return denied(); },
            commit: write => { requireGrant(grant); if (!admissions.has(ticket)) return denied(); return write(); },
          });
          requireGrant(grant);
          const admission = admissions.get(ticket); if (!admission) return denied();
          admissions.delete(ticket);
          receipts.set(messageId, Object.freeze({ ...identity, role: "user", trust: "direct-user-event", state: "live", text,
            generation: randomUUID(), contentRevision: 1, occurredAt: at }));
          return identity;
        } catch (error) {
          // Keep uncertain/already-written identities reserved. Never remove source files.
          const current = await options.store.read(sessionId).catch(() => undefined);
          if (current && !current.entries.some(entry => entry.turnId === messageId)) { admissions.delete(ticket); admitted.delete(messageId); }
          throw error;
        }
      });
    },
    close(): Promise<void> { closed = true; return tail.then(() => undefined); },
  });
}
