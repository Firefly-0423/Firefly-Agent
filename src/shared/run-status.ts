import type { ChatMessage } from "./chat-types";

export interface RunStatusRequest {
  sessionId: string;
  candidates: { assistantTurnId: string; runId?: string }[];
}
export interface RunPresentationIdentity {
  profileId: string;
  sessionId: string;
  assistantTurnId: string;
  runId: string;
}
export interface RunPresentationRecord extends RunPresentationIdentity {
  version: 1;
  seq: number;
  phase: "running" | "settling" | "finished" | "interrupted";
}
export type RunStatusItem =
  | { assistantTurnId: string; phase: "unavailable" }
  | { sessionId: string; assistantTurnId: string; runId: string; seq: number; phase: "running" | "settling" | "interrupted" }
  | { sessionId: string; assistantTurnId: string; runId: string; seq: number; phase: "finished"; message: ChatMessage };
