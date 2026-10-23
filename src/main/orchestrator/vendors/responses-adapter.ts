import type {
  VendorConfig, ToolExecutionResult, ToolCall, TestConnectionResult, StreamEvent, StreamChunk,
  ProviderCapability, HttpRequest, ChatVendorAdapter, ChatResponse, ChatRequest, ChatMessage,
} from "./types";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import { authHeaderFor } from "./auth";
import { resolveReasoningCapability } from "../../../shared/reasoning";
import { applyReasoningPreference } from "./reasoning";
import { getTimeoutSettings } from "../../timeout-manager";
import { resolveAutomaticToolChoicePolicy, resolveToolChoicePolicy } from "./tool-choice-policy";
import { getVendorRuntimeSettings } from "./runtime-settings";
import { resolveApiEndpoint } from "../../../shared/api-endpoint";

type MessageItem = { content: Array<{ type: "output_text"; text: string } | { type: "refusal"; refusal: string }>; role: "assistant"; id: string; status?: string; type: "message" };
type CallItem = { arguments: string; name: string; call_id: string; id: string; type: "function_call" };
type ReasonItem = { encrypted_content?: string | null; content?: Array<{ type: string; text?: string }>;
  summary?: Array<{ type: string; text?: string }>; id: string; type: "reasoning" };
type OutputItem = MessageItem | CallItem | ReasonItem | { type: string; [key: string]: unknown };
type WireResponse = {
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  status?: string;
  output?: OutputItem[];
};
export function isOfficialOpenAIEndpoint(baseUrl: string): boolean {
  try { return new URL(baseUrl.trim()).hostname.toLowerCase() === "api.openai.com"; }
  catch { return false; }
}
export function shouldIncludeEncryptedReasoning(cfg: VendorConfig, cap: ProviderCapability): boolean {
  return cap.responsesEncryptedReasoning === true && isOfficialOpenAIEndpoint(cfg.baseUrl);
}
function toUserContentBlocks(content: NonNullable<ChatMessage["content"]>): Array<{ type: string; text?: string; image_url?: string }> {
  return typeof content === "string" ? [{ type: "input_text", text: content }]
    : content.map((entry) => entry.type === "text" ? { type: "input_text", text: entry.text } : { type: "input_image", image_url: entry.image_url.url });
}
function convertItems(items: OutputItem[]): Array<Record<string, unknown>> {
  return toResponseInputItems(items as unknown as Parameters<typeof toResponseInputItems>[0]) as unknown as Array<Record<string, unknown>>;
}
function replayRawAssistant(rawAssistant: unknown, includeEncryptedReasoning: boolean): Array<Record<string, unknown>> {
  if (!Array.isArray(rawAssistant)) return [];
  const allowed = rawAssistant.filter((entry): entry is OutputItem => {
    if (!entry || typeof entry !== "object") return false;
    const kind = (entry as { type?: unknown }).type;
    if (kind === "message" || kind === "function_call") return true;
    return kind === "reasoning" ? includeEncryptedReasoning && typeof (entry as ReasonItem).encrypted_content === "string" : false;
  });
  try { return convertItems(allowed); }
  catch {
    const partial: Array<Record<string, unknown>> = [];
    for (const entry of allowed) {
      try { partial.push(...convertItems([entry])); } catch { /* 单条损坏时继续回放其余内容。 */ }
    }
    return partial;
  }
}
function toWireInput(messages: ChatMessage[], includeEncryptedReasoning: boolean): {
  instructions: string | undefined; input: Array<Record<string, unknown>>;
} {
  const rules: string[] = [];
  const items: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const plain = () => typeof message.content === "string" ? message.content : "";
    switch (message.role) {
      case "system": {
        const text = plain();
        if (text) rules.push(text);
        break;
      }
      case "user": items.push({ role: "user", content: toUserContentBlocks(message.content ?? "") }); break;
      case "tool": items.push({ type: "function_call_output", call_id: message.toolCallId, output: plain() }); break;
      default: {
        if (message.rawAssistant !== undefined) {
          items.push(...replayRawAssistant(message.rawAssistant, includeEncryptedReasoning));
          break;
        }
        const text = plain();
        if (text) items.push({ role: "assistant", content: [{ type: "input_text", text }] });
        for (const call of message.toolCalls ?? []) items.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments });
      }
    }
  }
  return { instructions: rules.length > 0 ? rules.join("\n\n") : undefined, input: items };
}
function toWireTools(specs?: ChatRequest["tools"]): Array<Record<string, unknown>> | undefined {
  return !specs || specs.length === 0 ? undefined : specs.map((spec) => ({
    type: "function", name: spec.name, description: spec.description, parameters: spec.parameters, strict: false,
  }));
}
function wireUsageToUnified(counts: NonNullable<WireResponse["usage"]>): NonNullable<StreamChunk["usage"]> {
  return { input: counts.input_tokens ?? 0, output: counts.output_tokens ?? 0,
    ...(typeof counts.input_tokens_details?.cached_tokens === "number" ? { cachedInput: counts.input_tokens_details.cached_tokens } : {}) };
}
export class ResponsesAdapter implements ChatVendorAdapter {
  readonly transport = "responses" as const;
  constructor(public readonly id: string, public capability: ProviderCapability) {}
  buildRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest {
    const encrypted = shouldIncludeEncryptedReasoning(cfg, this.capability);
    const converted = toWireInput(req.messages, encrypted);
    const payload: Record<string, unknown> = { model: req.model, input: converted.input, store: false, stream: req.stream ?? false };
    if (converted.instructions !== undefined) payload.instructions = converted.instructions;
    if (req.temperature !== undefined) payload.temperature = req.temperature;
    if (req.topP !== undefined) payload.top_p = req.topP;
    if (req.maxTokens !== undefined) payload.max_output_tokens = req.maxTokens;
    if (getVendorRuntimeSettings().disableMaxToken) payload.max_output_tokens = undefined;
    if (encrypted) payload.include = ["reasoning.encrypted_content"];
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
          case "named": payload.tool_choice = { type: "function", name: selection.name }; break;
          case "required": payload.tool_choice = "required"; break;
          case "auto": payload.tool_choice = "auto"; break;
        }
      } else if (resolveAutomaticToolChoicePolicy({
        providerId: this.capability.id, model: cfg.model, transport: this.transport,
        reasoning: cfg.reasoning ?? { mode: "auto" }, reasoningLevels: cfg.reasoningLevels, supportedModes: this.capability.toolChoiceModes,
      }) === "auto") payload.tool_choice = "auto";
    }
    const rules = resolveReasoningCapability(this.capability.id, cfg.model, cfg.reasoningLevels, "openai-effort");
    const adjusted = applyReasoningPreference({ ...payload }, cfg.reasoning ?? { mode: "auto" }, rules,
      { hasTools: Boolean(req.tools?.length), providerId: this.capability.id, model: cfg.model });
    const effort = adjusted.reasoning_effort;
    const thinking = adjusted.thinking as { type?: unknown } | undefined;
    const enabled = thinking?.type === "adaptive" || thinking?.type === "enabled";
    delete adjusted.reasoning_effort;
    delete adjusted.thinking;
    delete adjusted.enable_thinking;
    delete adjusted.output_config;
    const level = typeof effort === "string" ? effort : enabled ? "minimal" : undefined;
    if (level !== undefined) adjusted.reasoning = { effort: level };
    Object.assign(payload, adjusted);
    const format = req.structuredOutput;
    if (format?.mode === "json_schema") payload.text = {
      format: { type: "json_schema", name: format.name, strict: format.strict, schema: format.schema },
    };
    else if (format?.mode === "json_object" || format?.mode === "prompt_json" && format.sendJsonObjectHint) payload.text = { format: { type: "json_object" } };
    if (req.extraBody) Object.assign(payload, req.extraBody);
    return { url: resolveApiEndpoint(cfg.baseUrl, "responses").url, method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaderFor(this.capability, cfg.apiKey, "responses") }, body: JSON.stringify(payload) };
  }
  buildStreamRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest {
    return this.buildRequest({ ...req, stream: true }, cfg);
  }
  parseResponse(raw: unknown): ChatResponse {
    const response = (raw ?? {}) as WireResponse;
    const outputs = Array.isArray(response.output) ? response.output : [];
    let visible = "";
    let refused: string | undefined;
    const thoughts: string[] = [];
    const calls: ToolCall[] = [];
    for (const entry of outputs) {
      if (entry.type === "message") {
        for (const fragment of (entry as MessageItem).content ?? []) {
          if (fragment.type === "output_text") visible += fragment.text;
          else if (fragment.type === "refusal") refused = (refused ?? "") + fragment.refusal;
        }
      } else if (entry.type === "function_call") {
        const call = entry as CallItem;
        calls.push({ id: call.call_id, name: call.name, arguments: call.arguments });
      } else if (entry.type === "reasoning") {
        const thought = entry as ReasonItem;
        for (const fragment of thought.summary ?? []) if (typeof fragment.text === "string") thoughts.push(fragment.text);
        for (const fragment of thought.content ?? []) if (typeof fragment.text === "string") thoughts.push(fragment.text);
      }
    }
    const reasoning = thoughts.length > 0 ? thoughts.join("\n") : undefined;
    const assistant: ChatMessage = { role: "assistant", content: visible, ...(calls.length > 0 ? { toolCalls: calls } : {}),
      ...(reasoning ? { thinking: reasoning } : {}), rawAssistant: outputs };
    const ending = response.status === "incomplete" ? (response.incomplete_details?.reason === "max_output_tokens" ? "length" : "stop") : "stop";
    const counts = response.usage ? wireUsageToUnified(response.usage) : undefined;
    return { assistantMessage: assistant, text: visible, thinking: reasoning, refusal: refused, toolCalls: calls, finishReason: ending, raw, usage: counts };
  }
  parseStreamEvent(event: StreamEvent): StreamChunk | null {
    const source = event.data.trim();
    if (!source) return null;
    let decoded: { type?: string; delta?: string; response?: WireResponse; error?: { message?: string } };
    try { decoded = JSON.parse(source); } catch { return null; }
    const kind = decoded.type ?? event.eventType;
    if (kind === "response.output_text.delta") return typeof decoded.delta === "string" ? { deltaText: decoded.delta } : null;
    if (kind === "response.reasoning_summary_text.delta" || kind === "response.reasoning_text.delta") return typeof decoded.delta === "string" ? { deltaThinking: decoded.delta } : null;
    if (kind === "response.completed" || kind === "response.incomplete") return {
      done: true, finishReason: kind === "response.completed" ? "stop" : decoded.response?.incomplete_details?.reason === "max_output_tokens" ? "length" : "stop",
      ...(decoded.response?.usage ? { usage: wireUsageToUnified(decoded.response.usage) } : {}),
    };
    if (kind === "response.failed") return { error: decoded.response?.error?.message ?? "模型流式响应失败" };
    return kind === "error" ? { error: decoded.error?.message ?? "模型流式响应返回错误" } : null;
  }
  appendToolResults(messages: ChatMessage[], results: ToolExecutionResult[]): ChatMessage[] {
    const transcript = messages.slice();
    for (const completed of results) transcript.push({ role: "tool", toolCallId: completed.toolCall.id, name: completed.toolCall.name, content: completed.output });
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
