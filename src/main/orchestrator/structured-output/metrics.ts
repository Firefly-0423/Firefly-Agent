import type { StructuredOutputStage, StructuredOutputMode } from "./types";

export type RecordStructuredOutputMetric = (metric: StructuredOutputMetric) => void;

export type StructuredOutputMetric = {
  totalDurationMs: number;
  validationFailureCode?: string;
  finalOutcome: "success" | "failure";
  validCandidateCount: number;
  candidateCount: number;
  finishReason: string;
  repairCount: number;
  attempts: number;
  mode: StructuredOutputMode;
  stage: StructuredOutputStage;
};
