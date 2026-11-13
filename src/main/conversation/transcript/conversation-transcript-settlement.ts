import {
  assertValidTranscriptDraft, copySAssistantBinding, copySAssistantSettlementBinding,
  copySAssistantSettlementPayload, type SAssistantBinding, type SAssistantSettlementBinding,
  type TranscriptEntry, type TranscriptAppendInput,
} from "./conversation-transcript-types";
export type SAssistantSettlementClassification = "legacy" | "pending" | "unknown" | "success" | "interrupted";
function invalid(): never { throw Error("TRANSCRIPT_S_BINDING_INVALID"); }
type ActiveNode = {
  kind: "user";
  turnId: string;
  revision: number;
} | {
  kind: "assistant";
  id: string;
};
function assertOrderedEntries(entries: readonly TranscriptEntry[]): void {
  let seq = 0;
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string" || ids.has(entry.id) || !Number.isSafeInteger(entry.seq) || entry.seq <= seq)
      invalid();
    seq = entry.seq;
    ids.add(entry.id);
  }
}
/** Only the existing user/rewind/assistant topology; no message reconstruction or new authority. */
function activeNodes(entries: readonly TranscriptEntry[]): ActiveNode[] {
  const nodes: ActiveNode[] = [];
  for (const entry of entries) {
    if (entry.kind === "user") {
      if (!entry.turnId || !Number.isSafeInteger(entry.revision) || entry.revision! < 1)
        invalid();
      nodes.push({ kind: "user", turnId: entry.turnId, revision: entry.revision! });
    }
    else if (entry.kind === "assistant")
      nodes.push({ kind: "assistant", id: entry.id });
    else if (entry.kind === "turn_rewind") {
      let index = nodes.length - 1;
      while (index >= 0) {
        const node = nodes[index];
        if (node.kind === "user" && node.turnId === entry.payload.anchorUserTurnId)
          break;
        index--;
      }
      if (index < 0)
        invalid();
      if (entry.payload.disposition === "keep_user")
        nodes.length = index + 1;
      else if (entry.payload.disposition === "replace_user") {
        if (!entry.turnId || entry.turnId !== entry.payload.anchorUserTurnId || !Number.isSafeInteger(entry.revision) || entry.revision! < 1 || !entry.payload.replacementUser)
          invalid();
        nodes.length = index;
        nodes.push({ kind: "user", turnId: entry.turnId, revision: entry.revision! });
      }
      else
        invalid();
    }
  }
  return nodes;
}
function sameBinding(a: SAssistantSettlementBinding, b: SAssistantSettlementBinding): boolean {
  return a.assistantEntryId === b.assistantEntryId && a.runId === b.runId && a.assistantTurnId === b.assistantTurnId
    && a.userTurnId === b.userTurnId && a.userRevision === b.userRevision;
}
function sameUser(node: ActiveNode | undefined, binding: SAssistantBinding): boolean {
  return node?.kind === "user" && node.turnId === binding.userTurnId && node.revision === binding.userRevision;
}
function originalBinding(entries: readonly TranscriptEntry[], id: string): SAssistantSettlementBinding {
  const index = entries.findIndex(e => e.id === id), entry = entries[index];
  if (!entry || entry.kind !== "assistant" || !entry.sSettlement)
    invalid();
  assertValidTranscriptDraft(entry);
  const binding = copySAssistantSettlementBinding({
    assistantEntryId: id, runId: entry.runId, assistantTurnId: entry.turnId,
    userTurnId: entry.sSettlement.userTurnId, userRevision: entry.sSettlement.userRevision,
  });
  if (!sameUser(activeNodes(entries.slice(0, index)).at(-1), binding))
    invalid();
  return binding;
}
function associatedMarkers(entries: readonly TranscriptEntry[], binding: SAssistantSettlementBinding): TranscriptEntry[] {
  return entries.filter(entry => entry.kind === "assistant_settlement" && (entry.payload?.binding?.assistantEntryId === binding.assistantEntryId
    || entry.runId === binding.runId && entry.turnId === binding.assistantTurnId));
}
export function assertSAssistantAppend(entries: readonly TranscriptEntry[], value: SAssistantBinding): void {
  const binding = copySAssistantBinding(value);
  assertOrderedEntries(entries);
  if (!sameUser(activeNodes(entries).at(-1), binding))
    invalid();
}
export function assertSAssistantSettlement(entries: readonly TranscriptEntry[], draft: Extract<TranscriptAppendInput, {kind: "assistant_settlement"}>): void {
  assertOrderedEntries(entries);
  assertValidTranscriptDraft(draft);
  const binding = originalBinding(entries, draft.payload.binding.assistantEntryId);
  if (!sameBinding(binding, draft.payload.binding))
    invalid();
  if (associatedMarkers(entries, binding).length)
    throw Error("TRANSCRIPT_S_SETTLEMENT_CONFLICT");
  if (draft.payload.result === "success") {
    const nodes = activeNodes(entries), last = nodes.at(-1);
    if (entries.at(-1)?.id !== binding.assistantEntryId || last?.kind !== "assistant" || last.id !== binding.assistantEntryId || !sameUser(nodes.at(-2), binding))
      invalid();
  }
}
/** Raw audit classification; consumers separately apply the canonical active/rewind view. */
export function classifySAssistantSettlement(entries: readonly TranscriptEntry[], assistantEntryId: string): SAssistantSettlementClassification {
  try {
    assertOrderedEntries(entries);
    const entry = entries.find(e => e.id === assistantEntryId);
    if (!entry || entry.kind !== "assistant" || entry.payload?.role !== "assistant")
      return "unknown";
    if (!Object.hasOwn(entry, "sSettlement"))
      return entry.roundId === "s-response" ? "unknown" : "legacy";
    const binding = originalBinding(entries, assistantEntryId), markers = associatedMarkers(entries, binding);
    if (!markers.length)
      return "pending";
    if (markers.length !== 1)
      return "unknown";
    const marker = markers[0];
    if (marker.kind !== "assistant_settlement")
      return "unknown";
    const payload = copySAssistantSettlementPayload(marker.payload);
    assertValidTranscriptDraft(marker);
    if (!sameBinding(binding, payload.binding) || marker.seq <= entry.seq)
      return "unknown";
    if (payload.result === "success") {
      const prefix = entries.slice(0, entries.indexOf(marker)), nodes = activeNodes(prefix), last = nodes.at(-1);
      if (prefix.at(-1)?.id !== entry.id || last?.kind !== "assistant" || last.id !== entry.id || !sameUser(nodes.at(-2), binding))
        return "unknown";
    }
    return payload.result;
  }
  catch {
    return "unknown";
  }
}
