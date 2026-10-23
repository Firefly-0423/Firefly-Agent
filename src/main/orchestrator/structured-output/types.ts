import type { Transport } from "../vendors/types";

export type StructuredOutputTier = "M" | "D" | "B" | "A";
export type StructuredOutputVerification = "contract_required" | "contract_verified" | "official";
export type StructuredOutputMode = "prompt_json" | "provider_json_object" | "provider_json_schema";
export type StructuredOutputStage =
  | "memory_resolve" | "memory_reflect" | "memory_compress" | "memory_judge"
  | "memory" | "native_fc" | "planner" | "task_router";

export type StructuredOutputRepairPolicy = {
  minimumRemainingBudgetMs: number;
  perAttemptTimeoutMs: number;
  totalBudgetMs: number;
  maxAttempts: number;
};
export type StructuredOutputProfileContext = {
  endpointKind: "official" | "custom" | "local";
  transport: Transport;
  model: string;
  provider: string;
};
export type StructuredOutputProfile = {
  repair: Record<StructuredOutputStage, StructuredOutputRepairPolicy>;
  reasoning: "disabled" | "preserve";
  requestHints: { reasoningSplit: boolean; sendJsonObject: boolean };
  allowCapabilityPromotion: false;
  verification: StructuredOutputVerification;
  mode: StructuredOutputMode;
  tier: StructuredOutputTier;
  transport?: Transport;
  model: string;
  provider: string;
  id: string;
};
