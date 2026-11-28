import { createHash } from "node:crypto";
import type { ScheduleProposal } from "./types";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

/**
 * A stable fingerprint of what the user is asked to approve: the proposal id, its kind and its spec.
 * Derived on demand, never persisted; any change to the spec yields a different revision.
 */
export function computeProposalRevision(proposal: Pick<ScheduleProposal, "proposalId" | "kind" | "spec">): string {
  const text = JSON.stringify(canonical({ proposalId: proposal.proposalId, kind: proposal.kind, spec: proposal.spec }));
  return createHash("sha256").update(text).digest("hex");
}
