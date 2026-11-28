import { ProviderProtocolError, type UnifiedStreamDelta } from "./types";

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
const stringValue = (input: unknown): string | undefined => typeof input === "string" && input.length > 0 ? input : undefined;
const integerValue = (input: unknown): number | undefined => typeof input === "number" && Number.isInteger(input) ? input : undefined;
function usageEvents(payload: unknown): UnifiedStreamDelta[] {
  if (!record(payload) || !record(payload.usage)) return [];
  const counts = payload.usage;
  const incoming = typeof counts.input_tokens === "number" ? counts.input_tokens : undefined;
  const outgoing = typeof counts.output_tokens === "number" ? counts.output_tokens : undefined;
  const detail = record(counts.input_tokens_details) ? counts.input_tokens_details : undefined;
  const cached = detail && typeof detail.cached_tokens === "number" ? detail.cached_tokens : undefined;
  if (incoming === undefined && outgoing === undefined && cached === undefined) return [];
  return [{ type: "usage", inputTokens: incoming, outputTokens: outgoing,
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}) }];
}
export function normalizeResponsesEvent(event: unknown): UnifiedStreamDelta[] {
  if (!record(event) || typeof event.type !== "string") return [];
  const kind = event.type;
  if (kind === "response.output_text.delta" || kind === "response.reasoning_summary_text.delta" || kind === "response.reasoning_text.delta") {
    const fragment = stringValue(event.delta);
    return fragment ? [{ type: kind === "response.output_text.delta" ? "text_delta" : "reasoning_delta", delta: fragment }] : [];
  }
  if (kind === "response.refusal.delta" || kind === "response.refusal.done") {
    const denial = stringValue(kind === "response.refusal.delta" ? event.delta : event.refusal);
    return denial ? [{ type: "refusal", reason: denial }] : [];
  }
  if (kind === "response.output_item.added" || kind === "response.output_item.done") {
    const item = record(event.item) ? event.item : undefined;
    const position = integerValue(event.output_index);
    if (!item || position === undefined || item.type !== "function_call") return [];
    const identity = stringValue(item.call_id);
    if (kind === "response.output_item.done") return [{ type: "tool_call_end", index: position, ...(identity ? { id: identity } : {}) }];
    const name = stringValue(item.name);
    return [{ type: "tool_call_start", index: position, ...(identity ? { id: identity } : {}), ...(name ? { nameDelta: name } : {}) }];
  }
  if (kind === "response.function_call_arguments.delta") {
    const position = integerValue(event.output_index);
    const fragment = stringValue(event.delta);
    return position === undefined || !fragment ? [] : [{ type: "tool_call_arguments_delta", index: position, delta: fragment }];
  }
  if (kind === "response.function_call_arguments.done") {
    const position = integerValue(event.output_index);
    return position === undefined ? [] : [{ type: "tool_call_end", index: position }];
  }
  if (kind === "response.completed") return [...usageEvents(event.response), { type: "finish", reason: "stop" }];
  if (kind === "response.incomplete") {
    const payload = record(event.response) ? event.response : undefined;
    const ending = payload && record(payload.incomplete_details) ? stringValue(payload.incomplete_details.reason) : undefined;
    return [...usageEvents(payload), { type: "finish", reason: ending === "max_output_tokens" ? "length" : ending ?? "incomplete" }];
  }
  if (kind === "response.failed") {
    const payload = record(event.response) ? event.response : undefined;
    const detail = payload && record(payload.error) ? stringValue(payload.error.message) : undefined;
    throw new ProviderProtocolError("E_UNSUPPORTED_STREAM_EVENT", detail ?? "Responses stream returned response.failed");
  }
  if (kind === "error") throw new ProviderProtocolError("E_UNSUPPORTED_STREAM_EVENT",
    stringValue(event.message) ?? "Responses stream returned an error event");
  return [];
}
