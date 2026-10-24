import type {
  VendorConfig, ToolExecutionResult, ToolCall, TestConnectionResult, StreamEvent, StreamChunk,
  ProviderCapability, HttpRequest, ChatVendorAdapter, ChatResponse, ChatRequest, ChatMessage,
} from "./types";
import { authHeaderFor } from "./auth";
import { resolveReasoningCapability } from "../../../shared/reasoning";
import { applyReasoningPreference } from "./reasoning";
import { getTimeoutSettings } from "../../timeout-manager";
import { resolveAutomaticToolChoicePolicy, resolveToolChoicePolicy } from "./tool-choice-policy";
import { getVendorRuntimeSettings } from "./runtime-settings";
import { resolveApiEndpoint } from "../../../shared/api-endpoint";
import { buildStableCacheFingerprint } from "../prompt-layers";

type WireUsage = { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
type WireMessage = {
  role?: string; content?: string | null; reasoning_content?: string; thinking?: string; reasoning?: string; refusal?: string | null;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
};
type WireResponse = { choices?: Array<{ message?: WireMessage; finish_reason?: string }>; usage?: WireUsage };
type WireChunk = {
  error?: { message?: unknown }; usage?: WireUsage;
  choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown; thinking?: unknown; reasoning?: unknown; tool_calls?: unknown }; finish_reason?: unknown }>;
};
function usageValue(source: WireUsage): NonNullable<ChatResponse["usage"]> {
  return { input: source.prompt_tokens ?? 0, output: source.completion_tokens ?? 0,
    ...(typeof source.prompt_tokens_details?.cached_tokens === "number" ? { cachedInput: source.prompt_tokens_details.cached_tokens } : {}) };
}
function toWireMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((message) => {
    switch (message.role) {
      case "system": return { role: "system", content: message.content ?? "" };
      case "user": return { role: "user", content: message.content ?? "" };
      case "tool": {
        const serialized: Record<string, unknown> = { role: "tool", tool_call_id: message.toolCallId, content: message.content ?? "" };
        if (message.name) serialized.name = message.name;
        return serialized;
      }
      default: {
        const serialized: Record<string, unknown> = { role: "assistant", content: message.content || null };
        if (message.toolCalls && message.toolCalls.length > 0) serialized.tool_calls = message.toolCalls.map((call) => ({
          id: call.id, type: "function", function: { name: call.name, arguments: call.arguments },
        }));
        return serialized;
      }
    }
  });
}
function toWireTools(specs?: ChatRequest["tools"]): unknown[] | undefined {
  return !specs || specs.length === 0 ? undefined : specs.map((spec) => ({
    type: "function", function: { name: spec.name, description: spec.description, parameters: spec.parameters },
  }));
}
export class OpenAICompatAdapter implements ChatVendorAdapter {
  readonly transport = "openai" as const;
  constructor(public readonly id: string, public capability: ProviderCapability) {}

  buildRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest {
    const payload: Record<string, unknown> = { model: req.model, messages: toWireMessages(req.messages), stream: req.stream ?? false };
    if (req.stream) payload.stream_options = { include_usage: true };
    if (req.temperature !== undefined) payload.temperature = req.temperature;
    if (req.topP !== undefined) payload.top_p = req.topP;
    if (req.frequencyPenalty !== undefined) payload.frequency_penalty = req.frequencyPenalty;
    if (req.repetitionPenalty !== undefined) payload.repetition_penalty = req.repetitionPenalty;
    if (req.maxTokens !== undefined) payload.max_tokens = req.maxTokens;
    if (getVendorRuntimeSettings().disableMaxToken) payload.max_tokens = undefined;
    const functions = toWireTools(req.tools);
    if (functions) {
      payload.tools = functions;
      if (req.toolChoiceIntent) {
        const selection = resolveToolChoicePolicy({
          providerId: this.capability.id, model: cfg.model, transport: this.transport,
          reasoning: cfg.reasoning ?? { mode: "auto" }, reasoningLevels: cfg.reasoningLevels,
          requestedToolName: req.toolChoiceIntent.toolName, supportedModes: this.capability.toolChoiceModes,
        });
        switch (selection.kind) {
          case "named": payload.tool_choice = { type: "function", function: { name: selection.name } }; break;
          case "required": payload.tool_choice = "required"; break;
          case "auto": payload.tool_choice = "auto"; break;
        }
      } else if (resolveAutomaticToolChoicePolicy({
        providerId: this.capability.id, model: cfg.model, transport: this.transport,
        reasoning: cfg.reasoning ?? { mode: "auto" }, reasoningLevels: cfg.reasoningLevels, supportedModes: this.capability.toolChoiceModes,
      }) === "auto") payload.tool_choice = "auto";
    }
    if (req.extraBody) Object.assign(payload, req.extraBody);
    const format = req.structuredOutput;
    if (format?.mode === "json_schema") payload.response_format = {
      type: "json_schema", json_schema: { name: format.name, strict: format.strict, schema: format.schema },
    };
    else if (format?.mode === "json_object" || format?.mode === "prompt_json" && format.sendJsonObjectHint) {
      payload.response_format = { type: "json_object" };
    }
    const reasoning = resolveReasoningCapability(this.capability.id, cfg.model, cfg.reasoningLevels, "openai-effort");
    const serialized = applyReasoningPreference(payload, cfg.reasoning ?? { mode: "auto" }, reasoning,
      { hasTools: Boolean(req.tools?.length), providerId: this.capability.id, model: cfg.model });
    return {
      url: resolveApiEndpoint(cfg.baseUrl, "openai").url, method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaderFor(this.capability, cfg.apiKey, "openai") },
      body: JSON.stringify(serialized),
    };
  }
  buildStreamRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest {
    return this.buildRequest({ ...req, stream: true }, cfg);
  }
  parseStreamEvent(event: StreamEvent): StreamChunk | null {
    const source = event.data.trim();
    if (!source) return null;
    if (source === "[DONE]") return { done: true };
    let decoded: WireChunk;
    try { decoded = JSON.parse(source); } catch { return null; }
    if (decoded.error) return { error: typeof decoded.error.message === "string" ? decoded.error.message : "模型流式响应返回错误" };
    const alternative = decoded?.choices?.[0];
    const patch = alternative?.delta;
    const increment: StreamChunk = {};
    if (typeof patch?.content === "string") increment.deltaText = patch.content;
    const thought = patch?.reasoning_content ?? patch?.thinking ?? patch?.reasoning;
    if (typeof thought === "string") increment.deltaThinking = thought;
    if (typeof alternative?.finish_reason === "string") increment.finishReason = alternative.finish_reason;
    if (decoded.usage) increment.usage = usageValue(decoded.usage);
    return Object.keys(increment).length > 0 ? increment : null;
  }
  parseResponse(raw: unknown): ChatResponse {
    const response = raw as WireResponse;
    const alternative = response.choices?.[0];
    const message = alternative?.message;
    const visible = message?.content ?? "";
    const reasoningText = typeof message?.reasoning === "string" ? message.reasoning : undefined;
    const thought = message?.reasoning_content || message?.thinking || reasoningText || undefined;
    const refusal = message?.refusal || undefined;
    const calls: ToolCall[] = (message?.tool_calls ?? []).map((call) => ({
      id: call.id, name: call.function.name, arguments: call.function.arguments,
    }));
    const assistant: ChatMessage = { role: "assistant", content: visible,
      ...(calls.length > 0 ? { toolCalls: calls } : {}), ...(thought ? { thinking: thought } : {}) };
    const counts = response.usage ? usageValue(response.usage) : undefined;
    return { assistantMessage: assistant, text: visible, thinking: thought, refusal, toolCalls: calls,
      finishReason: alternative?.finish_reason ?? "stop", raw, usage: counts };
  }
  appendToolResults(messages: ChatMessage[], results: ToolExecutionResult[]): ChatMessage[] {
    const transcript = messages.slice();
    for (const completed of results) transcript.push({ role: "tool", toolCallId: completed.toolCall.id,
      name: completed.toolCall.name, content: completed.output });
    return transcript;
  }
  applyCacheHints(req: ChatRequest, _cfg: VendorConfig): ChatRequest {
    if (this.capability.cacheStrategy !== "prompt_cache_key") return req;
    const metadata = req.promptLayers;
    const identity = metadata ? buildStableCacheFingerprint({
      provider: this.id, model: req.model, mode: metadata.mode, promptVersion: metadata.promptVersion,
      stablePrefix: metadata.stablePrefix, sessionPrefix: metadata.sessionPrefix, tools: req.tools ?? [],
    }) : "legacy";
    const extension = { ...(req.extraBody ?? {}), prompt_cache_key: `firefly:${this.id}:${identity}` };
    return { ...req, extraBody: extension };
  }
  async testConnection(cfg: VendorConfig): Promise<TestConnectionResult> {
    const began = Date.now();
    const cancellation = new AbortController();
    const alarm = setTimeout(() => cancellation.abort(), getTimeoutSettings().testTimeout);
    try {
      const probe: ChatRequest = { model: cfg.model, messages: [{ role: "user", content: "ping，请只回复两个字符：ok" }], stream: false };
      const outgoing = this.buildRequest(probe, cfg);
      const response = await fetch(outgoing.url, { method: "POST", signal: cancellation.signal, headers: outgoing.headers, body: outgoing.body });
      const elapsed = Date.now() - began;
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        return { ok: false, latency: elapsed, error: `HTTP ${response.status} ${detail.slice(0, 200)}` };
      }
      const decoded = await response.json();
      const parsed = this.parseResponse(decoded);
      return { ok: true, latency: elapsed, sample: parsed.text.slice(0, 80) || "(空回复)" };
    } catch (failure) {
      return { ok: false, latency: Date.now() - began, error: failure instanceof Error ? failure.message : String(failure) };
    } finally { clearTimeout(alarm); }
  }
}
