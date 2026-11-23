export type ToolRiskLevel = "safe" | "fs-read" | "fs-write" | "shell" | "network" | "input-control";
export type ApprovalOrigin = { agentId?: string; agentName?: string; childRunId?: string; toolCallId?: string };
export type ApprovalRequest = ApprovalOrigin & {
  runId?: string;
  risk: ToolRiskLevel;
  risks?: ToolRiskLevel[];
  declaredBy?: string;
  approvalTarget?: string;
  args: Record<string, unknown>;
  toolDescription: string;
  toolName: string;
  toolId: string;
  id: string;
};
export type ApprovalSettleReason = "answered" | "cancelled" | "unavailable";
export type ApprovalSettledPayload = { reason: ApprovalSettleReason; runId?: string; id: string };
