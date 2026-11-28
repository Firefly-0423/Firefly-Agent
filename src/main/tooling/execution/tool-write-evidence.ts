import type { TaskWriteEvidence } from "../../../shared/agent-execution-evidence";
import type { ToolContext } from "../registry/tool-context";

/** Independent trusted channel. Never consume model/legacy JSON for write facts. */
export function getToolWriteEvidence(context?: ToolContext): TaskWriteEvidence[] {
  const execution = context?.execution;
  return execution ? execution.coordinator.getWriteEvidence({
    childRunId: execution.scope.childRunId, toolCallId: execution.scope.toolCallId,
  }) : [];
}
