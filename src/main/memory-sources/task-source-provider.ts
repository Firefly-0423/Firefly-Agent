import { createHash, randomUUID } from "node:crypto";
import { requireBackgroundMemoryIngress, type BackgroundMemoryIngress, type BackgroundMemoryIngressContext } from "../memory-context/background-memory-ingress";
import { parseInternalId } from "../memory-core/command-validation";
import { canonicalJson } from "../memory-core/repository-types";
import type { SourceIdentity, SourceRole, SourceTrust } from "../memory-core/source-contracts";
import type { ConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import { createMainSourceProvider, type SourceSnapshot } from "./main-source-provider";

interface Options { providerId: string; store: ConversationTranscriptStore; clock?: () => number; signal?: AbortSignal }
const denied = (): never => { throw Error("MEMORY_TASK_SOURCE_DENIED"); };
const fingerprint = (text: string, role: SourceRole, trust: SourceTrust) => createHash("sha256").update(canonicalJson({ text, state: "live", role, trust })).digest("hex");
/** Explicit Main system/model provenance. A canonical user role is only wire turn framing. */
export function createTaskSourceProvider(options: Options) {
  const providerId = parseInternalId(options.providerId), clock = options.clock ?? Date.now, ownerSignal = options.signal;
  const sessions = new Map<string, { ingress: BackgroundMemoryIngress; context: Readonly<BackgroundMemoryIngressContext>; scopeKey: string }>();
  const receipts = new Map<string, SourceSnapshot>(), used = new WeakSet<object>();
  let closed = false, tail: Promise<unknown> = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => { const result = tail.then(operation); tail = result.catch(() => undefined); return result; };
  const key = (identity: SourceIdentity) => canonicalJson(identity);
  const assertOpen = () => { if (closed || ownerSignal?.aborted) return denied(); };
  function current(sessionId: string) {
    assertOpen();
    const session = sessions.get(sessionId); if (!session) return denied();
    requireBackgroundMemoryIngress(session.ingress); return session;
  }
  function attach(ingress: BackgroundMemoryIngress, scope: string) {
    assertOpen();
    const context = requireBackgroundMemoryIngress(ingress), scopeKey = parseInternalId(scope), old = sessions.get(context.sessionId);
    if (old && (old.scopeKey !== scopeKey || old.context.sourceKey !== context.sourceKey || old.context.entry !== context.entry)) return denied();
    sessions.set(context.sessionId, { ingress, context, scopeKey }); return context;
  }
  const token = createMainSourceProvider({ providerId,
    authorize: (scope, identity) => { try { return identity.providerId === providerId && current(identity.sessionId).scopeKey === scope; } catch { return false; } },
    withLease: (identity, operation, previous) => serialized(() => options.store.withReadLease(identity.sessionId, async read => {
      const binding = current(identity.sessionId), context = binding.context;
      const assertCurrent = () => { assertOpen(); context.assertCurrent(); };
      const result = await operation(async () => {
        assertCurrent(); const snapshot = await read(); assertCurrent();
        const entries = snapshot.entries.filter(entry => entry.kind === "user" && entry.turnId === identity.messageId);
        const entry = entries.length === 1 ? entries[0] : undefined;
        const text = entry?.kind === "user" && entry.revision === 1 && !entry.payload.attachments?.length
          && !snapshot.entries.some(item => item.kind === "turn_rewind" && item.payload.anchorUserTurnId === identity.messageId) ? entry.payload.text : null;
        const receipt = receipts.get(key(identity));
        if (receipt) return text === receipt.text ? structuredClone(receipt) : { ...receipt, state: "deleted", text: "", contentRevision: receipt.contentRevision + 1 };
        const role = context.entry === "child" ? "assistant" : "system", trust = context.sourceTrust;
        if (!previous || previous.state !== "live" || previous.role !== role || previous.trust !== trust) return denied();
        const unchanged = text !== null && fingerprint(text, role, trust) === previous.fingerprint;
        return { ...identity, generation: previous.generation, contentRevision: previous.contentRevision + (unchanged ? 0 : 1),
          role, trust, state: unchanged ? "live" : "deleted", text: unchanged ? text! : "",
          ...(previous.occurredAt === undefined ? {} : { occurredAt: previous.occurredAt }) };
      });
      assertCurrent(); return result;
    })),
  });
  return Object.freeze({ token, attach,
    commitInstruction(ingress: BackgroundMemoryIngress, input: { messageId: string; instructionText: string; scopeKey: string }): Promise<SourceIdentity> {
      const { messageId: requestedId, instructionText: text, scopeKey } = input;
      return serialized(async () => {
        const context = attach(ingress, scopeKey), messageId = parseInternalId(requestedId);
        const assertCurrent = () => { assertOpen(); context.assertCurrent(); };
        if (used.has(ingress) || text !== context.instructionText || Buffer.byteLength(text) > 65536) return denied();
        const identity = Object.freeze({ providerId, sessionId: context.sessionId, messageId });
        const snapshot = await options.store.read(context.sessionId); assertCurrent();
        if (snapshot.entries.some(entry => entry.turnId === messageId)) return denied();
        const occurredAt = clock(); if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) return denied();
        used.add(ingress);
        await options.store.append(context.sessionId, { id: `task-instruction:v1:${messageId}:r1`, kind: "user", turnId: messageId, revision: 1, at: occurredAt, payload: { text } }, {
          throughSeq: snapshot.throughSeq, validate: async () => { assertCurrent(); }, commit: write => { assertCurrent(); return write(); },
        });
        assertCurrent();
        receipts.set(key(identity), Object.freeze({ ...identity, text, role: context.entry === "child" ? "assistant" : "system",
          trust: context.sourceTrust, state: "live", contentRevision: 1, generation: randomUUID(), occurredAt }));
        assertCurrent();
        return identity;
      });
    },
    close(): Promise<void> { closed = true; return tail.then(() => undefined); },
  });
}
