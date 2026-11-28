import type { ToolCall, ChatVendorAdapter, ChatResponse } from "../types";
import { ProviderProtocolError, type UnifiedStreamDelta, type StreamDiagnostic, type StreamAccumulatorSnapshot } from "./types";

type BlockState = { name?: string; id?: string; type: string };
function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
const nonempty = (input: unknown): string | undefined => typeof input === "string" && input.length > 0 ? input : undefined;
const positionValid = (input: unknown): input is number => typeof input === "number" && Number.isInteger(input);
function counts(input: unknown): UnifiedStreamDelta[] {
  if (!record(input)) return [];
  const incoming = typeof input.input_tokens === "number" ? input.input_tokens : undefined;
  const outgoing = typeof input.output_tokens === "number" ? input.output_tokens : undefined;
  const cached = typeof input.cache_read_input_tokens === "number" ? input.cache_read_input_tokens : undefined;
  const created = typeof input.cache_creation_input_tokens === "number" ? input.cache_creation_input_tokens : undefined;
  if (incoming === undefined && outgoing === undefined && cached === undefined && created === undefined) return [];
  return [{ type: "usage", inputTokens: incoming, outputTokens: outgoing,
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(created !== undefined ? { cacheCreationTokens: created } : {}) }];
}
export class AnthropicEventNormalizer {
  private readonly blocks = new Map<number, BlockState>();
  normalize(event: unknown): UnifiedStreamDelta[] {
    if (!record(event) || typeof event.type !== "string") return [];
    const kind = event.type;
    if (kind === "message_start") return counts(record(event.message) ? event.message.usage : undefined);
    if (kind === "message_delta") {
      const events = counts(event.usage);
      const patch = record(event.delta) ? event.delta : undefined;
      const ending = patch ? nonempty(patch.stop_reason) : undefined;
      if (ending) events.push({ type: "finish", reason: ending });
      return events;
    }
    if (kind === "error") throw new ProviderProtocolError("E_UNSUPPORTED_STREAM_EVENT", "Anthropic stream returned an error event");
    if (kind === "content_block_start") return this.open(event);
    if (kind === "content_block_delta") return this.fragment(event);
    if (kind === "content_block_stop") {
      if (!positionValid(event.index)) return [];
      const state = this.blocks.get(event.index);
      this.blocks.delete(event.index);
      return state?.type !== "tool_use" ? [] : [{ type: "tool_call_end", index: event.index,
        ...(state.id ? { id: state.id } : {}) }];
    }
    return [];
  }
  private open(event: Record<string, unknown>): UnifiedStreamDelta[] {
    if (!positionValid(event.index) || !record(event.content_block)) return [];
    const source = event.content_block;
    const kind = nonempty(source.type);
    if (!kind) return [];
    const state: BlockState = { type: kind, id: nonempty(source.id), name: nonempty(source.name) };
    this.blocks.set(event.index, state);
    if (kind === "tool_use") return [{ type: "tool_call_start", index: event.index,
      ...(state.id ? { id: state.id } : {}), ...(state.name ? { nameDelta: state.name } : {}) }];
    if (kind === "thinking") {
      const content = nonempty(source.thinking);
      return content ? [{ type: "reasoning_delta", delta: content }] : [];
    }
    if (kind === "text") {
      const content = nonempty(source.text);
      return content ? [{ type: "text_delta", delta: content }] : [];
    }
    return [];
  }
  private fragment(event: Record<string, unknown>): UnifiedStreamDelta[] {
    if (!positionValid(event.index) || !record(event.delta)) return [];
    const patch = event.delta;
    const kind = nonempty(patch.type);
    if (kind === "thinking_delta") {
      const content = nonempty(patch.thinking);
      return content ? [{ type: "reasoning_delta", delta: content }] : [];
    }
    if (kind === "text_delta") {
      const content = nonempty(patch.text);
      return content ? [{ type: "text_delta", delta: content }] : [];
    }
    if (kind !== "input_json_delta") return [];
    const json = nonempty(patch.partial_json);
    if (!json) return [];
    const state = this.blocks.get(event.index);
    return [{ type: "tool_call_arguments_delta", index: event.index,
      ...(state?.id ? { id: state.id } : {}), delta: json }];
  }
}
function compactJson(source: string): string | undefined {
  try { return JSON.stringify(JSON.parse(source)); } catch { return undefined; }
}
function checkCalls(calls: ToolCall[]): void {
  for (const call of calls) {
    if (!call.id || !call.name.trim() || compactJson(call.arguments) === undefined) {
      throw new ProviderProtocolError("E_TOOL_CALL_INCOMPLETE", "Anthropic terminal message contains an incomplete tool call");
    }
  }
}
function comparableReason(source: string | undefined): string | undefined {
  if (source === "tool_use") return "tool_calls";
  if (source === "end_turn") return "stop";
  return source === "max_tokens" ? "length" : source;
}
function diagnose(live: StreamAccumulatorSnapshot, final: ChatResponse): StreamDiagnostic | undefined {
  const changed: string[] = [];
  if (live.text !== final.text) changed.push("text");
  if ((live.thinking ?? "") !== (final.thinking ?? "")) changed.push("reasoning");
  if (comparableReason(live.finishReason) !== comparableReason(final.finishReason)) changed.push("finish_reason");
  if (live.usage && !final.usage) changed.push("usage_missing_in_terminal");
  else if (live.usage && final.usage && (live.usage.input !== final.usage.input || live.usage.output !== final.usage.output)) changed.push("usage");
  const before = live.toolCalls.map((call) => ({ id: call.id ?? "", name: call.name, arguments: compactJson(call.arguments) }));
  const after = final.toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: compactJson(call.arguments) }));
  if (JSON.stringify(before) !== JSON.stringify(after)) changed.push("tool_calls");
  if (changed.length === 0) return undefined;
  return {
    code: "E_STREAM_TERMINAL_MISMATCH", transport: "anthropic", differences: changed,
    live: { text_length: live.text.length, reasoning_length: live.thinking?.length ?? 0,
      tool_call_ids: live.toolCalls.flatMap((call) => call.id ? [call.id] : []) },
    terminal: { text_length: final.text.length, reasoning_length: final.thinking?.length ?? 0,
      tool_call_ids: final.toolCalls.map((call) => call.id) },
  };
}
function mergeUsage(before: ChatResponse["usage"], after: ChatResponse["usage"]): ChatResponse["usage"] {
  if (!before && !after) return undefined;
  if (!before) return after;
  if (!after) return before;
  const cached = after.cachedInput ?? before.cachedInput;
  const created = after.cacheCreation ?? before.cacheCreation;
  return { input: after.input, output: after.output,
    ...(cached !== undefined ? { cachedInput: cached } : {}), ...(created !== undefined ? { cacheCreation: created } : {}) };
}
export function reconcileAnthropicTerminal(live: StreamAccumulatorSnapshot, finalMessage: unknown,
  adapter: ChatVendorAdapter, onDiagnostic?: (diagnostic: StreamDiagnostic) => void): ChatResponse {
  const parsed = adapter.parseResponse(finalMessage);
  checkCalls(parsed.toolCalls);
  const difference = diagnose(live, parsed);
  if (difference) onDiagnostic?.(difference);
  return { ...parsed, usage: mergeUsage(live.usage, parsed.usage) };
}
