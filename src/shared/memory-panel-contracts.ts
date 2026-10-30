import type { FactView, SourceRef } from "./memory-contracts";

/** Renderer DTOs only. No actor tokens, provider handles, keys or filesystem paths. */
/** Counts only, for the chat window's memory card: no memory text, ids or titles leave the settings window. */
export interface MemoryGraphSummary {
  available: boolean;
  categories: { key: string; facts: number; pending: number }[];
  sources: number;
}
export interface MemoryPanelAction {
  kind: "confirm" | "reject" | "correct" | "forget";
  id: string;
  expectedRevision: number;
  text?: string;
  contentHash?: string;
}
export interface MemoryPanelOutcome {
  status: "candidate" | "active" | "rejected" | "suppressed" | "forgotten" | "pending-review";
  reason?: string;
  candidateId?: string;
  candidateRevision?: number;
  factId?: string;
  factRevision?: number;
}
export interface MemoryPanelCandidate {
  /** Content readiness only; source, scope, suppression and conflict checks still run on confirmation. */
  reviewState: "ready" | "reference-only";
  time?: import("./memory-contracts").FactTime;
  candidateId: string;
  revision: number;
  attribute: string;
  value: string | null;
  assertion: string;
  reason: string;
  sourceRef: SourceRef;
  occurredAt?: number | null;
  /** Where the candidate would apply once confirmed. */
  scope?: "global" | "project";
  projectName?: string;
  /** Title of the conversation the candidate came from, when Main still has it. Decoration, never authority. */
  sourceTitle?: string;
  /** Main-internal; removed before the renderer sees it. */
  projectKey?: string;
  contentHash?: string;
}
/** Structural mirror of the metadata-only native PresenceCoverage, without a Main import. */
export interface MemoryPanelCoverage {
  status: "measured" | "not-measured";
  reason?: string;
  population: number | null;
  present: number | null;
  missing: number | null;
  unknownDenied: number | null;
  exactRatio: number | null;
  lowerRatio: number | null;
  upperRatio: number | null;
  reasons: Readonly<Record<string, number>>;
  evidence: { status: "not-evaluated"; eligible: null; ineligible: null; unknown: number | null; ratio: null };
}
export interface MemoryPanelState {
  facts: FactView[];
  candidates: MemoryPanelCandidate[];
  coverage: MemoryPanelCoverage;
  backendStatus: { available: boolean; reason?: string };
}
export interface MemoryPanelSourceAudit {
  factId: string;
  revision: number | null;
  status: "eligible" | "pending-review" | "forgotten";
  reason: string;
  sources: Array<{
    sourceId: string;
    revision: number;
    kind: "automatic" | "explicitUserConfirmed" | "review";
    validity: string;
    occurredAt: number | null;
  }>;
}
export interface MemoryPolicyPanelApi {
  getState(): Promise<MemoryPanelState>;
  applyAction(action: MemoryPanelAction): Promise<MemoryPanelOutcome>;
  auditSource(factId: string): Promise<MemoryPanelSourceAudit>;
}

/** Shadow extraction (experimental) settings page DTOs. Counts and switches only; no message content. */
export interface ShadowPanelState {
  /** False when this build's memory backend has no shadow storage. */
  available: boolean;
  enabled: boolean;
  dailyCap: number;
  /** Optimistic-concurrency token for the next configure call. */
  revision: number;
  /** Local date the usage below belongs to (YYYY-MM-DD). */
  day: string;
  used: number;
  stopped: "quota" | "rate-limit" | null;
  /** Stored records whose source message still exists. */
  records: number;
  counters: Record<string, number>;
}
export type ShadowPanelError = "SHADOW_UNAVAILABLE" | "SHADOW_FORBIDDEN" | "SHADOW_INPUT_INVALID" | "SHADOW_REVISION_CONFLICT" | "SHADOW_FAILED";
export type ShadowPanelOutcome = { ok: true; state: ShadowPanelState } | { ok: false; error: ShadowPanelError };
export type ShadowExportOutcome = { ok: true; canceled: false; count: number } | { ok: true; canceled: true } | { ok: false; error: ShadowPanelError };
export interface ShadowPanelApi {
  shadowState(): Promise<ShadowPanelOutcome>;
  shadowConfigure(input: { enabled: boolean; dailyCap: number; expectedRevision: number }): Promise<ShadowPanelOutcome>;
  shadowExport(): Promise<ShadowExportOutcome>;
  shadowClear(): Promise<ShadowPanelOutcome>;
}
