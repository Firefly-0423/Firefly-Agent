import type {
  VendorConfig, ToolExecutionResult, ToolCall, TestConnectionResult, StreamEvent, StreamChunk,
  ProviderCapability, HttpRequest, ChatMessageContent, ChatVendorAdapter, ChatResponse, ChatRequest, ChatMessage,
} from "./types";
import { authHeaderFor } from "./auth";
import { resolveReasoningCapability } from "../../../shared/reasoning";
import { applyReasoningPreference } from "./reasoning";
import { getTimeoutSettings } from "../../timeout-manager";
import { resolveAutomaticToolChoicePolicy, resolveToolChoicePolicy } from "./tool-choice-policy";
import { getVendorRuntimeSettings } from "./runtime-settings";
import { resolveApiEndpoint } from "../../../shared/api-endpoint";

type ContentBlock = { [key: string]: unknown; type: string };
type TokenCounts = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
type StreamPayload = {
  type?: string; error?: { message?: unknown }; message?: { usage?: TokenCounts };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
  usage?: TokenCounts;
};
const imageFormats = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
function supportsMessageCacheBreakpoint(adapterId: string, model: string): boolean {
  return adapterId === "claude" || adapterId === "minimax" && /^minimax-m2(?:$|[.-])/i.test(model.trim());
}
function markMessageCacheBreakpoint(message: Record<string, unknown>): boolean {
  if (typeof message.content === "string" && message.content.length > 0) {
    message.content = [{ type: "text", text: message.content, cache_control: { type: "ephemeral" } }];
    return true;
  }
  if (!Array.isArray(message.content) || message.content.length === 0) return false;
  const cloned = (message.content as ContentBlock[]).map((entry) => ({ ...entry }));
  cloned[cloned.length - 1].cache_control = { type: "ephemeral" };
  message.content = cloned;
  return true;
}
function toAnthropicContent(content: ChatMessageContent): string | ContentBlock[] {
  if (typeof content === "string") return content;
  const converted: ContentBlock[] = [];
  let embedded = 0, remote = 0, skipped = 0;
  for (const entry of content) {
    if (entry.type === "text") {
      converted.push({ type: "text", text: entry.text });
      continue;
    }
    if (entry.type !== "image_url") continue;
    const parts = /^data:([^;]+);base64,(.+)$/.exec(entry.image_url.url);
    if (!parts) {
      remote++;
      converted.push({ type: "image", source: { type: "url", url: entry.image_url.url } });
    } else if (imageFormats.has(parts[1])) {
      embedded++;
      converted.push({ type: "image", source: { type: "base64", media_type: parts[1], data: parts[2] } });
    } else {
      skipped++;
      converted.push({ type: "text", text: `[图片格式 ${parts[1]} 暂不支持直发，已跳过]` });
    }
  }
  if (embedded + remote + skipped > 0) console.log(
    `[image-send] anthropic wire: image 块 ${embedded} base64 / ${remote} url`
    + (skipped > 0 ? ` / ${skipped} 个 MIME 不在白名单已降级文本` : ""));
  return converted.length > 0 ? converted : "";
}
function assistantBlocks(message: ChatMessage): ContentBlock[] {
  const converted: ContentBlock[] = [];
  if (message.thinking) converted.push({ type: "thinking", thinking: message.thinking });
  if (message.content) converted.push({ type: "text", text: message.content });
  if (message.toolCalls) {
    for (const call of message.toolCalls) {
      let decoded: unknown = {};
      try { decoded = JSON.parse(call.arguments || "{}"); } catch { decoded = {}; }
      converted.push({ type: "tool_use", id: call.id, name: call.name, input: decoded });
    }
  }
  return converted;
}
function toWireMessages(messages: ChatMessage[], options?: { cacheBreakpoints?: boolean }): {
  system: string | undefined; messages: Array<Record<string, unknown>>;
} {
  const combined = messages.filter((entry) => entry.role === "system").map((entry) => entry.content ?? "").join("\n\n").trim();
  const system = combined || undefined;
  const serialized: Array<Record<string, unknown>> = [];
  for (const message of messages.filter((entry) => entry.role !== "system")) {
    if (message.role === "user") serialized.push({ role: "user", content: toAnthropicContent(message.content ?? "") });
    else if (message.role === "assistant") {
      if (message.rawAssistant !== undefined) serialized.push({ role: "assistant", content: message.rawAssistant });
      else {
        const blocks = assistantBlocks(message);
        serialized.push({ role: "assistant", content: blocks.length > 0 ? blocks : "" });
      }
    } else if (message.role === "tool") {
      const result: ContentBlock = { type: "tool_result", tool_use_id: message.toolCallId, content: message.content ?? "" };
      const previous = serialized[serialized.length - 1];
      if (previous && previous.role === "user" && Array.isArray(previous.content)) (previous.content as ContentBlock[]).push(result);
      else serialized.push({ role: "user", content: [result] });
    }
  }
  if (options?.cacheBreakpoints) {
    let marked = 0;
    for (let cursor = serialized.length - 1; cursor >= 0 && marked < 2; cursor--) {
      if (markMessageCacheBreakpoint(serialized[cursor])) marked++;
    }
  }
  return { system, messages: serialized };
}
function usageValue(source: TokenCounts): NonNullable<ChatResponse["usage"]> {
  return { input: source.input_tokens ?? 0, output: source.output_tokens ?? 0,
    ...(typeof source.cache_read_input_tokens === "number" ? { cachedInput: source.cache_read_input_tokens } : {}),
    ...(typeof source.cache_creation_input_tokens === "number" ? { cacheCreation: source.cache_creation_input_tokens } : {}) };
}
export class AnthropicAdapter implements ChatVendorAdapter {
  readonly transport = "anthropic" as const;
  constructor(public readonly id: string, public capability: ProviderCapability) {}

  buildRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest {
    const cacheMessages = this.capability.cacheStrategy === "cache_control" && supportsMessageCacheBreakpoint(this.id, req.model);
    const converted = toWireMessages(req.messages, { cacheBreakpoints: cacheMessages });
    const payload: Record<string, unknown> = {
      model: req.model, max_tokens: getVendorRuntimeSettings().disableMaxToken ? undefined : req.maxTokens ?? 4096,
      messages: converted.messages, stream: req.stream ?? false,
    };
    if (req.temperature !== undefined) payload.temperature = req.temperature;
    if (req.topP !== undefined) payload.top_p = req.topP;
    if (converted.system) payload.system = this.capability.cacheStrategy === "cache_control"
      ? [{ type: "text", text: converted.system, cache_control: { type: "ephemeral" } }] : converted.system;
    if (req.tools && req.tools.length > 0) {
      payload.tools = req.tools.map((spec) => ({ name: spec.name, description: spec.description, input_schema: spec.parameters }));
      if (req.toolChoiceIntent) {
        const selection = resolveToolChoicePolicy({
          providerId: this.capability.id, model: cfg.model, transport: this.transport,
          reasoning: cfg.reasoning ?? { mode: "auto" }, reasoningLevels: cfg.reasoningLevels,
          requestedToolName: req.toolChoiceIntent.toolName, supportedModes: this.capability.toolChoiceModes,
        });
        switch (selection.kind) {
          case "named": payload.tool_choice = { type: "tool", name: selection.name }; break;
          case "required": payload.tool_choice = { type: "any" }; break;
          case "auto": payload.tool_choice = { type: "auto" }; break;
        }
      } else if (resolveAutomaticToolChoicePolicy({
        providerId: this.capability.id, model: cfg.model, transport: this.transport,
        reasoning: cfg.reasoning ?? { mode: "auto" }, reasoningLevels: cfg.reasoningLevels, supportedModes: this.capability.toolChoiceModes,
      }) === "auto") payload.tool_choice = { type: "auto" };
    }
    if (req.extraBody) Object.assign(payload, req.extraBody);
    if (req.structuredOutput?.mode === "json_schema") {
      const previous = payload.output_config && typeof payload.output_config === "object" && !Array.isArray(payload.output_config)
        ? payload.output_config as Record<string, unknown> : {};
      payload.output_config = { ...previous, format: { type: "json_schema", schema: req.structuredOutput.schema } };
    }
    const rules = resolveReasoningCapability(this.capability.id, cfg.model, cfg.reasoningLevels, "anthropic-adaptive");
    const serialized = applyReasoningPreference(payload, cfg.reasoning ?? { mode: "auto" }, rules,
      { hasTools: Boolean(req.tools?.length), providerId: this.capability.id, model: cfg.model });
    return { url: resolveApiEndpoint(cfg.baseUrl, "anthropic").url, method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaderFor(this.capability, cfg.apiKey, "anthropic"), "anthropic-version": "2023-06-01" },
      body: JSON.stringify(serialized) };
  }
  parseResponse(raw: unknown): ChatResponse {
    const response = raw as { content?: ContentBlock[]; stop_reason?: string; usage?: TokenCounts };
    const content = response.content ?? [];
    let visible = "";
    let thought: string | undefined;
    const calls: ToolCall[] = [];
    for (const entry of content) {
      if (entry.type === "text" && typeof entry.text === "string") visible += entry.text;
      else if ((entry.type === "thinking" || entry.type === "reasoning" || entry.type === "reasoning_details")
        && typeof (entry.thinking ?? entry.reasoning) === "string") thought = (thought ?? "") + String(entry.thinking ?? entry.reasoning);
      else if (entry.type === "tool_use") calls.push({ id: String(entry.id ?? ""), name: String(entry.name ?? ""), arguments: JSON.stringify(entry.input ?? {}) });
    }
    const ending = response.stop_reason ?? "end_turn";
    const normalized = ending === "tool_use" ? "tool_calls" : ending === "end_turn" ? "stop" : ending === "max_tokens" ? "length" : ending;
    const assistant: ChatMessage = { role: "assistant", ...(visible ? { content: visible } : {}),
      ...(thought ? { thinking: thought } : {}), ...(calls.length > 0 ? { toolCalls: calls } : {}), rawAssistant: content };
    const counts = response.usage ? usageValue(response.usage) : undefined;
    return { assistantMessage: assistant, text: visible, thinking: thought, toolCalls: calls, finishReason: normalized, raw, usage: counts };
  }
  buildStreamRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest {
    return this.buildRequest({ ...req, stream: true }, cfg);
  }
  parseStreamEvent(event: StreamEvent): StreamChunk | null {
    let decoded: StreamPayload;
    try { decoded = JSON.parse(event.data); } catch { return null; }
    const kind = event.eventType === "data" && typeof decoded.type === "string" ? decoded.type : event.eventType;
    if (kind === "error") return { error: typeof decoded.error?.message === "string" ? decoded.error.message : "模型流式响应返回错误" };
    if (kind === "message_start") {
      const initial = decoded.message?.usage;
      return initial ? { usage: usageValue(initial) } : null;
    }
    if (kind === "content_block_delta") {
      const patch = decoded.delta;
      if (!patch) return null;
      const increment: StreamChunk = {};
      if (patch.type === "text_delta" && typeof patch.text === "string") increment.deltaText = patch.text;
      if (patch.type === "thinking_delta" && typeof patch.thinking === "string") increment.deltaThinking = patch.thinking;
      return Object.keys(increment).length > 0 ? increment : null;
    }
    if (kind === "message_delta") {
      const increment: StreamChunk = {};
      if (typeof decoded.delta?.stop_reason === "string") increment.finishReason = decoded.delta.stop_reason;
      if (decoded.usage) increment.usage = usageValue(decoded.usage);
      return Object.keys(increment).length > 0 ? increment : null;
    }
    return kind === "message_stop" ? { done: true } : null;
  }
  appendToolResults(messages: ChatMessage[], results: ToolExecutionResult[]): ChatMessage[] {
    const transcript = messages.slice();
    for (const completed of results) transcript.push({ role: "tool", toolCallId: completed.toolCall.id,
      name: completed.toolCall.name, content: completed.output });
    return transcript;
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
