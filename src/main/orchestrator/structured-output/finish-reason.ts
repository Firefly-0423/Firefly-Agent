export type NormalizedFinishReason =
  | "unknown" | "refused" | "content_filtered" | "tool_call" | "truncated" | "complete";

export function normalizeFinishReason(reason: string | undefined): NormalizedFinishReason {
  if (reason === "stop" || reason === "end_turn" || reason === "stop_sequence") return "complete";
  if (reason === "length" || reason === "max_tokens") return "truncated";
  if (reason === "tool_calls" || reason === "tool_use") return "tool_call";
  if (reason === "content_filter") return "content_filtered";
  return reason === "refusal" ? "refused" : "unknown";
}
