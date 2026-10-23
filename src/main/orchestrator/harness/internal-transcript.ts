import type { ChatMessage } from "../vendors/types";
import { createHash } from "node:crypto";

const issuedMessages = new WeakMap<object, string>();
export type InternalTranscriptKind = NonNullable<ChatMessage["internal"]>["kind"];

export function isTrustedInternalTranscriptMessage(candidate: ChatMessage): boolean {
  const original = issuedMessages.get(candidate);
  if (original === undefined) return false;
  if (original === JSON.stringify(candidate)) return true;
  throw new Error("MEMORY_CONTEXT_PROMPT_CHANGED");
}

export function createInternalTranscriptMessage(fact: {
  runId: string;
  content: string;
  now?: number;
  revision: number;
  kind: InternalTranscriptKind;
}): ChatMessage {
  const normalized = fact.content.trim();
  const checksum = createHash("sha256").update(`${fact.kind}\n${normalized}`).digest("hex");
  const issued: ChatMessage = {
    role: "user", content: normalized, visibility: "internal",
    internal: {
      kind: fact.kind, revision: fact.revision, digest: checksum,
      id: `${fact.runId}:internal:${fact.revision}`,
      runId: fact.runId, createdAt: fact.now ?? Date.now(),
    },
  };
  issuedMessages.set(issued, JSON.stringify(issued));
  return issued;
}

export function appendInternalTranscriptMessage(
  history: readonly ChatMessage[],
  addition: ChatMessage,
): ChatMessage[] {
  const identity = addition.internal;
  if (identity) {
    const latestOfKind = [...history].reverse().find(entry => entry.internal?.kind === identity.kind);
    if (latestOfKind?.internal?.digest === identity.digest) return [...history];
  }
  return [...history, addition];
}

export function toModelVisibleMessage(stored: ChatMessage): ChatMessage {
  const { visibility: localVisibility, internal: localIdentity, ...wire } = stored;
  return {
    ...wire,
    ...(stored.toolCalls ? { toolCalls: stored.toolCalls.map(invocation => ({ ...invocation })) } : {}),
  };
}
