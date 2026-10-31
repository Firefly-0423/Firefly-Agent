import { stripLeakedChatTimeContext } from "../chat/chat-time-context";
import { ChatTimeStreamPrefixFilter } from "../chat/chat-time-stream-filter";
import { recordUsage, recordRequest, recordModelCall } from "../storage/token-usage-store";
import { AgentRuntimeError } from "./agent-runtime-error";
import type { AgentLoopSettings, AgentLoopEvent, AgentLoopResult } from "./firefly-agent";
import type { ChatMessage, ChatRequest, ChatVendorAdapter, ChatResponse, VendorConfig } from "./vendors/types";
import { streamChatWithSdk } from "./vendors/sdk-stream/runtime";
import type { UnifiedStreamDelta } from "./vendors/sdk-stream/types";
import { getTimeoutSettings } from "../settings/timeout-manager";
import { compressConversation } from "./context-manager";
import { buildContextUsageSnapshot, promptTokensOf } from "./context-usage";
import { isExplicitStreamUnsupported } from "./vendors/stream-support";
import { composePromptLayers } from "./prompt-layers";
import type { TranscriptSink } from "./transcript-sink";
import type { MainMemoryRun } from "../memory-context/main-memory-runtime";

export interface ChatLoopOptions {
  transcriptSink?: TranscriptSink;
  mode?: string;
  streamChat?: typeof streamChatWithSdk;
  fallbackRevealIntervalMs?: number;
  signal?: AbortSignal;
  recordUsage?: (input: number, output: number, calls: number, cachedInput?: number, cacheCreation?: number) => void;
  onEvent?: (event: AgentLoopEvent) => void;
  imageCaptionFallback?: () => Promise<ChatMessage[]>;
  timeoutMs: number;
  runtimeContext?: string;
  soulSystemBaseContent: string;
  messages: ChatMessage[];
  adapter: ChatVendorAdapter;
  settings: AgentLoopSettings;
  memoryRun?: MainMemoryRun;
}
class StreamUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "StreamUnavailableError"; }
}
function waitForReveal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new Error("E_SOUL_ONLY_CANCELLED"));
  return new Promise((complete, fail) => {
    const deadline = setTimeout(() => { signal?.removeEventListener("abort", cancel); complete(); }, ms);
    const cancel = () => { clearTimeout(deadline); fail(new Error("E_SOUL_ONLY_CANCELLED")); };
    signal?.addEventListener("abort", cancel, { once: true });
  });
}
async function emitFallbackText(onEvent: ChatLoopOptions["onEvent"], messageId: string, text: string, intervalMs: number, signal?: AbortSignal): Promise<void> {
  const characters = Array.from(text);
  const frames = Math.max(1, Math.min(60, Math.ceil(characters.length / 2)));
  const stride = Math.max(1, Math.ceil(characters.length / frames));
  for (let offset = 0; offset < characters.length; offset += stride) {
    onEvent?.({ type: "text_message_content", messageId, delta: characters.slice(offset, offset + stride).join("") });
    if (offset + stride < characters.length) await waitForReveal(intervalMs, signal);
  }
}
function stripToolProtocol(text: string): string {
  const withoutSentinel = text.split("]<]minimax[>[").join("");
  return withoutSentinel.replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/\[tool_call\][\s\S]*?\[\/tool_call\]/gi, "").replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "").trim();
}

export async function runChatLoop(options: ChatLoopOptions): Promise<AgentLoopResult> {
  if (options.memoryRun && options.transcriptSink) options = { ...options, transcriptSink: options.memoryRun.bindSink(options.transcriptSink) };
  const began = Date.now();
  const account = options.recordUsage ?? ((input, output, calls, cachedInput, cacheCreation) => recordUsage(input, output, calls, cachedInput, options.settings.model, cacheCreation));
  let captionAttempted = false;
  const measuredMessages = options.memoryRun ? options.messages : await compressConversation({
    messages: options.messages, adapter: options.adapter, settings: options.settings, systemContent: options.soulSystemBaseContent,
    mode: options.mode, onEvent: options.onEvent, signal: options.signal,
  });
  const publishUsage = (phase: "preRequest" | "terminal", reply?: string, usage?: { input: number; output: number; cachedInput?: number; cacheCreation?: number }): void => {
    options.onEvent?.({ type: "context_usage", contextUsage: buildContextUsageSnapshot({
      phase, contextWindowTokens: options.settings.contextWindowTokens, personaContent: options.soulSystemBaseContent,
      // The request also carried what the memory run added (facts, retrieved history): only the provider's count sees it.
      ...(usage ? { measured: { inputTokens: promptTokensOf(usage), outputTokens: usage.output, messageCount: measuredMessages.length } } : {}),
      ...(options.runtimeContext ? { runtimeContext: options.runtimeContext } : {}),
      ...(reply !== undefined ? { messages: [...measuredMessages, { role: "assistant" as const, content: reply }] } : { messages: measuredMessages }),
    }) });
  };
  publishUsage("preRequest");
  const perRequest = getTimeoutSettings().chatRequestTimeout;
  const remainingBudget = (): number => {
    if (options.signal?.aborted) throw new Error(options.memoryRun ? "MEMORY_CONTEXT_CANCELLED" : "E_SOUL_ONLY_CANCELLED");
    if (options.timeoutMs <= 0 || !Number.isFinite(options.timeoutMs)) return perRequest;
    const left = options.timeoutMs - (Date.now() - began);
    if (left <= 0) throw new Error("E_SOUL_ONLY_TIMEOUT");
    return Math.max(1, Math.min(perRequest, left));
  };
  const vendor: VendorConfig = {
    provider: options.settings.provider, baseUrl: options.settings.baseUrl, model: options.settings.model, apiKey: options.settings.apiKey,
    explicitTransport: options.settings.explicitTransport, reasoning: options.settings.reasoning, reasoningLevels: options.settings.reasoningLevels,
  };
  const makeRequest = (history: ChatMessage[], stream: boolean): ChatRequest => ({
    model: options.settings.model,
    ...composePromptLayers({ stablePrefix: options.soulSystemBaseContent, runtimeContext: options.runtimeContext, mode: options.mode }, history),
    stream,
  });
  const nonStreaming = async (history: ChatMessage[]): Promise<ChatResponse> => {
    const request: ChatRequest = { ...makeRequest(history, false) };
    const hinted = options.adapter.applyCacheHints?.(request, vendor) ?? request;
    if (options.memoryRun) return options.memoryRun.call({ adapter: options.adapter, request: hinted, config: vendor, timeoutMs: remainingBudget(), signal: options.signal });
    const transport = options.adapter.buildRequest(hinted, options.settings);
    const cancellation = new AbortController();
    const cancel = () => cancellation.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    const deadline = setTimeout(cancel, remainingBudget());
    try {
      const response = await fetch(transport.url, { method: "POST", headers: transport.headers, body: transport.body, signal: cancellation.signal });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        console.error(`[image-send] ChatLoop 请求被拒 HTTP ${response.status}:`, detail.slice(0, 500) || "(无响应体)");
        throw new AgentRuntimeError("E_MODEL_REQUEST_FAILED", `模型请求失败：HTTP ${response.status}${detail ? ` - ${detail.slice(0, 200)}` : ""}`);
      }
      return options.adapter.parseResponse(await response.json());
    } finally { clearTimeout(deadline); options.signal?.removeEventListener("abort", cancel); }
  };
  const textId = `msg-${Date.now()}`;
  const thoughtId = `${textId}-reasoning`;
  let partial = false;
  const display = { thoughtOpen: false, thoughtClosed: false, textOpen: false, textClosed: false };
  const beginThought = () => {
    if (display.thoughtOpen) return;
    display.thoughtOpen = true;
    options.onEvent?.({ type: "reasoning_message_start", messageId: thoughtId, role: "reasoning" });
  };
  const finishThought = () => {
    if (!display.thoughtOpen || display.thoughtClosed) return;
    display.thoughtClosed = true;
    options.onEvent?.({ type: "reasoning_message_end", messageId: thoughtId });
  };
  const beginText = () => {
    if (display.textOpen) return;
    finishThought();
    display.textOpen = true;
    options.onEvent?.({ type: "text_message_start", messageId: textId, role: "assistant" });
  };
  const finishText = () => {
    if (!display.textOpen || display.textClosed) return;
    display.textClosed = true;
    options.onEvent?.({ type: "text_message_end", messageId: textId });
  };
  let attemptBegan = performance.now();
  let firstContentAt: number | undefined;
  const streaming = async (history: ChatMessage[]): Promise<{ response: ChatResponse; needsReveal: boolean }> => {
    const request = makeRequest(history, true);
    const hinted = options.adapter.applyCacheHints?.(request, vendor) ?? request;
    const timeFilter = new ChatTimeStreamPrefixFilter();
    let visible = "";
    const publishText = (delta: string) => {
      if (!delta) return;
      visible += delta;
      beginText();
      options.onEvent?.({ type: "text_message_content", messageId: textId, delta });
    };
    const handleDelta = (delta: UnifiedStreamDelta) => {
      if (delta.type !== "usage" && (!("delta" in delta) || delta.delta.length > 0)) { partial = true; firstContentAt ??= performance.now(); }
      if (delta.type === "reasoning_delta" && delta.delta) {
        beginThought();
        options.onEvent?.({ type: "reasoning_message_content", messageId: thoughtId, delta: delta.delta });
      } else if (delta.type === "text_delta" && delta.delta) publishText(timeFilter.push(delta.delta));
    };
    try {
      const response = await (options.memoryRun
        ? (input: Parameters<MainMemoryRun["call"]>[0]) => options.memoryRun!.call(input)
        : options.streamChat ?? streamChatWithSdk)({
        adapter: options.adapter, request: hinted, config: vendor, timeoutMs: remainingBudget(), signal: options.signal, onDelta: handleDelta,
      });
      publishText(timeFilter.finish());
      if (!visible.trim()) {
        if (response.text.trim()) return { response, needsReveal: true };
        throw new AgentRuntimeError("E_MODEL_RESPONSE_PARSE_FAILED", "模型流式响应没有返回可见文本");
      }
      return { response: { ...response, text: visible, assistantMessage: { ...response.assistantMessage, content: visible } }, needsReveal: false };
    } catch (failure) {
      if (!partial && (isExplicitStreamUnsupported(failure) || options.memoryRun && failure instanceof Error && failure.message === "MEMORY_CONTEXT_STREAM_UNSUPPORTED")) {
        throw new StreamUnavailableError("流式请求不受支持", { cause: failure });
      }
      throw failure;
    }
  };
  const requestWithFallback = async (history: ChatMessage[]) => {
    attemptBegan = performance.now();
    firstContentAt = undefined;
    try { return await streaming(history); }
    catch (failure) {
      if (!(failure instanceof StreamUnavailableError) || partial) throw failure;
      return { response: await nonStreaming(history), needsReveal: true };
    }
  };
  options.onEvent?.({ type: "step_started", stepName: "chat" });
  try {
    let completed;
    try { completed = await requestWithFallback(options.messages); }
    catch (failure) {
      const memoryRefusal = options.memoryRun && !(failure instanceof Error && failure.message === "MEMORY_CONTEXT_IMAGE_UNSUPPORTED");
      if (memoryRefusal || partial || options.signal?.aborted || !options.imageCaptionFallback || captionAttempted) throw failure;
      captionAttempted = true;
      completed = await requestWithFallback(await options.imageCaptionFallback());
    }
    const response = completed.response;
    if (completed.needsReveal && response.thinking) {
      beginThought();
      options.onEvent?.({ type: "reasoning_message_content", messageId: thoughtId, delta: response.thinking });
      finishThought();
    }
    const ended = performance.now();
    recordModelCall({ durationMs: ended - attemptBegan,
      ...(firstContentAt !== undefined ? { ttftMs: firstContentAt - attemptBegan, generationMs: ended - firstContentAt } : {}), outputTokens: response.usage?.output });
    recordRequest(options.settings.model);
    if (response.usage) account(response.usage.input, response.usage.output, 1, response.usage.cachedInput, response.usage.cacheCreation);
    const reply = stripLeakedChatTimeContext(stripToolProtocol(response.text)) || "刚才没有生成正常回复，请再试一次。";
    const canonical: ChatMessage = { ...response.assistantMessage, role: "assistant", content: reply };
    await options.transcriptSink?.appendAssistant({ message: canonical });
    publishUsage("terminal", reply, response.usage);
    if (completed.needsReveal) { beginText(); await emitFallbackText(options.onEvent, textId, reply, options.fallbackRevealIntervalMs ?? 20, options.signal); }
    finishText();
    return { reply, toolResults: [], totalUsage: response.usage, completionReason: "no_tool" };
  } finally { finishThought(); finishText(); options.onEvent?.({ type: "step_finished", stepName: "chat" }); }
}
