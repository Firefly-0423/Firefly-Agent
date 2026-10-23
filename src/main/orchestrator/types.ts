import type { TaskWriteEvidence } from "../../shared/agent-execution-evidence";
import type { ToolEffectState, ToolErrorCategory } from "./tools/registry/tool-execution-error";

export interface ToolCallResult {
  stepAttemptId?: string;
  stepExecutionId?: string;
  stepId?: string;
  planId?: string;
  capabilityId?: string;
  toolExecuted?: false;
  deduplicated?: boolean;
  retryable?: boolean;
  terminal?: boolean;
  writes?: TaskWriteEvidence[];
  effectState?: ToolEffectState;
  category?: ToolErrorCategory;
  errorCode?: string;
  status: "succeeded" | "failed";
  output: string;
  args: Record<string, unknown>;
  toolId: string;
}

export interface ToolExecutionOutcome {
  retryable?: boolean;
  terminal?: boolean;
  writes?: TaskWriteEvidence[];
  effectState?: ToolEffectState;
  category?: ToolErrorCategory;
  errorCode?: string;
  status: "succeeded" | "failed";
  output: string;
}
