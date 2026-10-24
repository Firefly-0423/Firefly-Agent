/** Serializable execution facts only. Main constructs identities; model text is not evidence. */
export type TaskWriteState = "applied" | "partially_applied" | "unknown" | "not_applied";

/** Omit values that cannot be observed. A missing file may use version: "absent". */
export interface FileVersionEvidence {
  sha256?: string;
  version?: string;
}

export interface TaskWriteEvidence {
  path: string;
  canonicalPath: string;
  agentId: string;
  childRunId: string;
  toolCallId: string;
  state: TaskWriteState;
  before?: FileVersionEvidence;
  after?: FileVersionEvidence;
  eventIds: string[];
}

export interface ModelExecutionEvent {
  id: string;
  seq: number;
  monotonicMs: number;
  clockDomainId: string;
  agentId: string;
  parentRunId: string;
  childRunId: string;
  executionId: string;
  phase: "start" | "end" | "terminal";
  terminal?: "completed" | "failed" | "cancelled";
}
