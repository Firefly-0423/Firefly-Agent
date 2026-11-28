export type RunPhase =
  | "unknown" | "soul" | "plan_replan" | "plan_verify" | "tool_execute"
  | "native_fc" | "create_plan" | "router" | "context";

export interface SuccessfulToolExecution {
  completionClaims: string[];
  actionLabel: string;
  capabilityId: string;
}
export interface CreatedArtifact {
  capabilityId: string;
  kind?: "docx" | "pdf" | "xlsx" | "markdown" | "file";
  path: string;
}
export interface RunExecutionStatus {
  taskCompletionConfirmed: boolean;
  createdArtifacts: CreatedArtifact[];
  successfulTools: SuccessfulToolExecution[];
  phase: RunPhase;
}

export function snapshotRunExecutionStatus(status: RunExecutionStatus): RunExecutionStatus {
  return {
    phase: status.phase,
    successfulTools: status.successfulTools.map((execution) => ({
      capabilityId: execution.capabilityId,
      actionLabel: execution.actionLabel,
      completionClaims: [...execution.completionClaims],
    })),
    createdArtifacts: status.createdArtifacts.map((artifact) => ({ ...artifact })),
    taskCompletionConfirmed: status.taskCompletionConfirmed,
  };
}

export class AgentExecutionError extends Error {
  constructor(message: string, readonly executionStatus: RunExecutionStatus, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentExecutionError";
  }
}
