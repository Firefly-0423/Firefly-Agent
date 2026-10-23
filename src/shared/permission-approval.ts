export type ToolRiskLevel = "safe" | "fs-read" | "fs-write" | "shell" | "network" | "input-control";
export type ApprovalOrigin = { agentId?: string; childRunId?: string; toolCallId?: string };
export type ApprovalRequest = ApprovalOrigin & {
  runId?: string;
  risk: ToolRiskLevel;
  args: Record<string, unknown>;
  toolDescription: string;
  toolName: string;
  toolId: string;
  id: string;
};
export type ApprovalSettleReason = "answered" | "cancelled" | "unavailable";
export type ApprovalSettledPayload = { reason: ApprovalSettleReason; runId?: string; id: string };
