export type ProviderProtocolErrorCode =
  | "E_UNSUPPORTED_STREAM_EVENT" | "E_STREAM_TERMINAL_MISMATCH"
  | "E_TOOL_CALL_INCOMPLETE" | "E_TOOL_CALL_ID_CHANGED";

export class ProviderProtocolError extends Error {
  constructor(readonly code: ProviderProtocolErrorCode, message: string) {
    super(message);
    this.name = "ProviderProtocolError";
  }
}
export type UnifiedStreamDelta =
  | { reason?: string; type: "refusal" }
  | { reason: string; type: "finish" }
  | { cacheCreationTokens?: number; cachedInputTokens?: number; outputTokens?: number; inputTokens?: number; type: "usage" }
  | { id?: string; index: number; type: "tool_call_end" }
  | { delta: string; id?: string; index: number; type: "tool_call_arguments_delta" }
  | { nameDelta?: string; id?: string; index: number; type: "tool_call_start" }
  | { delta: string; type: "text_delta" }
  | { delta: string; type: "reasoning_delta" };
export type StreamAccumulatorSnapshot = {
  usage?: { cacheCreation?: number; cachedInput?: number; output: number; input: number };
  refusal?: string;
  finishReason?: string;
  toolCalls: ReadonlyArray<{ ended: boolean; arguments: string; name: string; id?: string; index: number }>;
  thinking?: string;
  text: string;
};
export type StreamDiagnostic = {
  terminal: { tool_call_ids: string[]; reasoning_length: number; text_length: number };
  live: { tool_call_ids: string[]; reasoning_length: number; text_length: number };
  differences: string[];
  transport: "anthropic";
  code: "E_STREAM_TERMINAL_MISMATCH";
};
