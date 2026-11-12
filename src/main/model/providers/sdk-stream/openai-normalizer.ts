import type { UnifiedStreamDelta } from "./types";

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
const textValue = (input: unknown): string | undefined => typeof input === "string" && input.length > 0 ? input : undefined;
function thoughts(part: Record<string, unknown>): string[] {
  const fragments: string[] = [];
  for (const field of ["reasoning_content", "reasoning", "thinking"] as const) {
    const fragment = textValue(part[field]);
    if (fragment) fragments.push(fragment);
  }
  if (Array.isArray(part.reasoning_details)) {
    for (const entry of part.reasoning_details) {
      if (!record(entry)) continue;
      const fragment = textValue(entry.text) ?? textValue(entry.content);
      if (fragment) fragments.push(fragment);
    }
  }
  return fragments;
}
function calls(parts: unknown): UnifiedStreamDelta[] {
  const events: UnifiedStreamDelta[] = [];
  if (!Array.isArray(parts)) return events;
  for (const part of parts) {
    if (!record(part) || typeof part.index !== "number" || !Number.isInteger(part.index)) continue;
    const identity = textValue(part.id);
    const fn = record(part.function) ? part.function : undefined;
    const name = fn ? textValue(fn.name) : undefined;
    const json = fn ? textValue(fn.arguments) : undefined;
    if (identity || name) events.push({
      type: "tool_call_start", index: part.index,
      ...(identity ? { id: identity } : {}), ...(name ? { nameDelta: name } : {}),
    });
    if (json) events.push({
      type: "tool_call_arguments_delta", index: part.index, ...(identity ? { id: identity } : {}), delta: json,
    });
  }
  return events;
}
export function normalizeOpenAIChunk(chunk: unknown): UnifiedStreamDelta[] {
  if (!record(chunk)) return [];
  const events: UnifiedStreamDelta[] = [];
  const endings: string[] = [];
  for (const alternative of Array.isArray(chunk.choices) ? chunk.choices : []) {
    if (!record(alternative)) continue;
    const part = record(alternative.delta) ? alternative.delta : undefined;
    if (part) {
      thoughts(part).forEach((fragment) => events.push({ type: "reasoning_delta", delta: fragment }));
      const visible = textValue(part.content);
      if (visible) events.push({ type: "text_delta", delta: visible });
      events.push(...calls(part.tool_calls));
      const denied = textValue(part.refusal);
      if (denied) events.push({ type: "refusal", reason: denied });
    }
    const end = textValue(alternative.finish_reason);
    if (end) endings.push(end);
  }
  if (record(chunk.usage)) {
    const countedIn = typeof chunk.usage.prompt_tokens === "number" ? chunk.usage.prompt_tokens : undefined;
    const countedOut = typeof chunk.usage.completion_tokens === "number" ? chunk.usage.completion_tokens : undefined;
    const details = record(chunk.usage.prompt_tokens_details) ? chunk.usage.prompt_tokens_details : undefined;
    const cached = details && typeof details.cached_tokens === "number" ? details.cached_tokens : undefined;
    if (countedIn !== undefined || countedOut !== undefined) events.push({
      type: "usage", inputTokens: countedIn, outputTokens: countedOut,
      ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    });
  }
  endings.forEach((reason) => events.push({ type: "finish", reason }));
  return events;
}
