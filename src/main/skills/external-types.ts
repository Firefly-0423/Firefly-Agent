import type { ExternalSkill, ExternalSkillSourceId, LicenseEvidence } from "../../shared/external-skills";
import type { StorageContext } from "../storage/storage-context";

/** Construct only from the real trusted IPC event; never accept from Renderer. */
export interface ExternalOwner {
  webContentsId: number;
  frameProcessId: number;
  frameRoutingId: number;
  generation: number;
}

/** Application-reviewed static data, bound to one source, commit and complete content digest. */
export interface ExternalSkillReview {
  policyVersion: string;
  sourceId: ExternalSkillSourceId;
  commit: string;
  path: string;
  contentSha256: string;
  licenses: LicenseEvidence[];
  compatibility: "instruction-only";
  reviewedAt: string;
  reviewer: string;
}

export interface ExternalSkillRecord {
  schema: 1;
  id: string;
  transactionId: string;
  status: "prepared" | "committed";
  enabled: boolean;
  skill: ExternalSkill;
  contentSha256: string;
  /** Absent only on installations created before explicit policy binding. */
  reviewPolicyVersion?: string;
}

/** One Main-created instance per application run, shared by every external state store. */
export interface ExternalHostSession {
  runId: string;
  isPrimaryProcess: () => boolean;
}

export interface ExternalServiceDeps {
  storage: StorageContext;
  host: ExternalHostSession;
  fetch: typeof globalThis.fetch;
  diagnose?: (diagnostic: import("./external-fetch").ExternalRequestDiagnostic) => void;
  now: () => number;
  randomToken: () => string;
  reviews: readonly ExternalSkillReview[];
  rescan: () => number;
}
