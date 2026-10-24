import type { ToolTaskResult } from "../../../shared/chat-types";
import { normalizeToolTaskResult } from "../../../shared/task-result-evidence";

/** Presentation evidence comes only from the runtime's delegate result, never its short preview. */
export function extractTaskResult(toolName: string, output: string | undefined, parentRunId?: string): ToolTaskResult | undefined {
  if (toolName !== "delegate_agent" || typeof output !== "string") return undefined;
  try {
    return normalizeToolTaskResult(JSON.parse(output), parentRunId);
  } catch {
    return undefined;
  }
}
