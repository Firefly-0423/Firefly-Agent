import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createThinkFilter } from "../../../chat/think-filter";
import { AgentRuntimeError } from "../../agent-runtime-error";
import { connectionLost } from "../connection-lost";
import type { VendorConfig, ChatVendorAdapter, ChatResponse, ChatRequest } from "../types";
import { FireflyStreamAccumulator } from "./accumulator";
import { AnthropicEventNormalizer, reconcileAnthropicTerminal } from "./anthropic-normalizer";
import { dumpRequest, dumpResponse } from "../prompt-dump";
import { deriveAnthropicClientConfig, deriveOpenAIClientConfig, deriveResponsesClientConfig,
  type AnthropicClientConfig, type OpenAIClientConfig } from "./client-config";
import { normalizeOpenAIChunk } from "./openai-normalizer";
import { normalizeResponsesEvent } from "./responses-normalizer";
import { ProviderProtocolError, type UnifiedStreamDelta, type StreamDiagnostic } from "./types";

export type OpenAIStreamFactoryInput = {
  signal: AbortSignal;
  body: Record<string, unknown>;
  client: OpenAIClientConfig & { fetch?: typeof fetch; logLevel?: "off" };
};
export type AnthropicStreamFactoryInput = {
  signal: AbortSignal;
  body: Record<string, unknown>;
  client: AnthropicClientConfig & { logLevel?: "off" };
};
export type SdkStreamRuntimeDeps = {
  anthropic: (input: AnthropicStreamFactoryInput) => Promise<{ events: AsyncIterable<unknown>; finalMessage: () => Promise<unknown> }>;
  responses: (input: OpenAIStreamFactoryInput) => Promise<AsyncIterable<unknown>>;
  openAI: (input: OpenAIStreamFactoryInput) => Promise<AsyncIterable<unknown>>;
};
export type SdkStreamRunInput = {
  onDiagnostic?: (diagnostic: StreamDiagnostic) => void;
  onDelta?: (delta: UnifiedStreamDelta) => void;
  persistDiagnostics?: boolean;
  signal?: AbortSignal;
  timeoutMs: number;
  config: VendorConfig;
  request: ChatRequest;
  adapter: ChatVendorAdapter;
};
export type SdkPreparedStreamRunInput = Omit<SdkStreamRunInput, "request"> & {
  fetch: typeof fetch;
  prepared: { endpoint: string; body: Record<string, unknown> };
  model: string;
};

const sdkFactories: SdkStreamRuntimeDeps = {
  openAI: async ({ client, body, signal }) => {
    const api = new OpenAI(client);
    const source = await api.chat.completions.create(body as never, { signal });
    return source as unknown as AsyncIterable<unknown>;
  },
  responses: async ({ client, body, signal }) => {
    const api = new OpenAI(client);
    const source = await api.responses.create({ ...body, stream: true } as never, { signal });
    return source as unknown as AsyncIterable<unknown>;
  },
  anthropic: async ({ client, body, signal }) => {
    const api = new Anthropic(client);
    const source = api.messages.stream(body as never, { signal });
    return { events: source as unknown as AsyncIterable<unknown>, finalMessage: () => source.finalMessage() };
  },
};
function serialize(adapter: ChatVendorAdapter, request: ChatRequest, config: VendorConfig): {
  endpoint: string; body: Record<string, unknown>;
} {
  const outgoing = adapter.buildStreamRequest({ ...request, stream: true }, config);
  const decoded = JSON.parse(outgoing.body) as unknown;
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new AgentRuntimeError("E_MODEL_RESPONSE_PARSE_FAILED", "模型请求体不是 JSON 对象");
  }
  return { endpoint: outgoing.url, body: decoded as Record<string, unknown> };
}
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}
/**
 * Class names, HTTP statuses and system error codes along an error's cause chain.
 * A provider error's `code` comes from the response body, so it is never logged; only
 * Node-style socket codes (ECONNRESET, UND_ERR_SOCKET) are.
 */
export function causeCodes(error: unknown): string {
  const parts: string[] = [];
  for (let cause = error, depth = 0; cause && typeof cause === "object" && depth < 6; cause = (cause as { cause?: unknown }).cause, depth++) {
    const { name, code, status } = cause as { name?: unknown; code?: unknown; status?: unknown };
    const label = [
      typeof name === "string" && /^[A-Z][A-Za-z]{0,40}$/.test(name) ? name : undefined,
      typeof status === "number" ? status : typeof code === "string" && /^(E[A-Z0-9_]{2,30}|UND_ERR_[A-Z_]{2,40})$/.test(code) ? code : undefined,
    ].filter(value => value !== undefined).join(":");
    if (label) parts.push(label);
  }
  return parts.join(" <- ");
}
function describeModelError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const metadata = error as Error & { status?: unknown; code?: unknown; type?: unknown };
  const attributes: string[] = [];
  if (metadata.status !== undefined && metadata.status !== null) attributes.push(`status=${String(metadata.status)}`);
  if (metadata.code) attributes.push(`code=${String(metadata.code)}`);
  if (metadata.type) attributes.push(`type=${String(metadata.type)}`);
  return `${error.name}: ${error.message}${attributes.length > 0 ? ` (${attributes.join(", ")})` : ""}`;
}
function responsesTerminalResponse(event: unknown): Record<string, unknown> | undefined {
  if (typeof event !== "object" || event === null || Array.isArray(event)) return undefined;
  const frame = event as Record<string, unknown>;
  if (frame.type !== "response.completed" && frame.type !== "response.incomplete") return undefined;
  const payload = frame.response;
  return typeof payload !== "object" || payload === null || Array.isArray(payload) ? undefined : payload as Record<string, unknown>;
}
export function streamChatWithSdk(input: SdkStreamRunInput, deps: SdkStreamRuntimeDeps = sdkFactories): Promise<ChatResponse> {
  return runSdkStream({ ...input, model: input.request.model }, () => serialize(input.adapter, input.request, input.config), deps);
}
export function streamPreparedChatWithSdk(input: SdkPreparedStreamRunInput, deps: SdkStreamRuntimeDeps = sdkFactories): Promise<ChatResponse> {
  return runSdkStream(input, () => input.prepared, deps, input.fetch);
}
async function runSdkStream(input: Omit<SdkStreamRunInput, "request"> & { model: string },
  prepare: () => { endpoint: string; body: Record<string, unknown> },
  deps: SdkStreamRuntimeDeps, preparedFetch?: typeof fetch): Promise<ChatResponse> {
  const cancellation = new AbortController();
  let deadlineExpired = false;
  const relay = () => cancellation.abort(input.signal?.reason);
  if (input.signal?.aborted) relay();
  else input.signal?.addEventListener("abort", relay, { once: true });
  const alarm = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? setTimeout(() => {
    deadlineExpired = true;
    cancellation.abort(new DOMException("Model request timed out", "TimeoutError"));
  }, input.timeoutMs) : undefined;
  const collected = new FireflyStreamAccumulator();
  const tags = createThinkFilter("leading-only");
  let trace: string | null = null;
  let endpoint = "";
  const active = () => { if (cancellation.signal.aborted) throw abortReason(cancellation.signal); };
  const publish = (patch: UnifiedStreamDelta) => {
    active();
    if (patch.type === "finish" && (input.adapter.transport === "openai" || input.adapter.transport === "responses")) {
      for (const call of collected.snapshot().toolCalls) {
        active();
        if (call.ended) continue;
        const closure: UnifiedStreamDelta = { type: "tool_call_end", index: call.index, ...(call.id ? { id: call.id } : {}) };
        collected.apply(closure);
        input.onDelta?.(closure);
      }
    }
    active();
    collected.apply(patch);
    input.onDelta?.(patch);
  };
  const flush = () => {
    const visible = tags.flush();
    const thought = tags.takeThinking();
    if (thought) publish({ type: "reasoning_delta", delta: thought });
    if (visible) publish({ type: "text_delta", delta: visible });
  };
  const dispatch = (patch: UnifiedStreamDelta) => {
    if (patch.type !== "text_delta") {
      if (patch.type !== "reasoning_delta") flush();
      publish(patch);
      return;
    }
    const visible = tags.push(patch.delta);
    const thought = tags.takeThinking();
    if (thought) publish({ type: "reasoning_delta", delta: thought });
    if (visible) publish({ type: "text_delta", delta: visible });
  };
  const success = (protocol: "openai" | "responses" | "anthropic", response: ChatResponse): ChatResponse => {
    dumpResponse(trace, { transport: protocol, ok: true, text: response.text, thinking: response.thinking,
      toolCalls: response.toolCalls, usage: response.usage, raw: response.raw });
    return response;
  };
  try {
    if (cancellation.signal.aborted) throw abortReason(cancellation.signal);
    const payload = prepare();
    endpoint = payload.endpoint;
    trace = dumpRequest({ transport: input.adapter.transport, endpoint: payload.endpoint, body: payload.body }, input.persistDiagnostics !== false);
    if (input.adapter.transport === "openai" || input.adapter.transport === "responses") {
      const isResponses = input.adapter.transport === "responses";
      const factory = isResponses ? deps.responses : deps.openAI;
      const events = await factory.call(deps, {
        client: { ...(isResponses ? deriveResponsesClientConfig : deriveOpenAIClientConfig)(payload.endpoint, input.config.apiKey),
          ...(preparedFetch ? { fetch: preparedFetch, logLevel: "off" as const } : {}) },
        body: payload.body, signal: cancellation.signal,
      });
      let lastChunk: unknown = null;
      let terminal: Record<string, unknown> | undefined;
      for await (const frame of events) {
        if (isResponses) {
          const completed = responsesTerminalResponse(frame);
          if (completed) terminal = completed;
        } else lastChunk = frame;
        for (const patch of (isResponses ? normalizeResponsesEvent : normalizeOpenAIChunk)(frame)) dispatch(patch);
      }
      active();
      flush();
      const response = collected.finalize(isResponses ? terminal : lastChunk);
      if (!isResponses) return success("openai", response);
      const outputs = terminal !== undefined && Array.isArray(terminal.output) ? terminal.output : undefined;
      const replayable = outputs !== undefined ? {
        ...response, assistantMessage: { ...response.assistantMessage, rawAssistant: outputs },
      } : response;
      return success("responses", replayable);
    }
    const style = input.adapter.capability.anthropicAuthStyle ?? input.adapter.capability.authStyle;
    const options = deriveAnthropicClientConfig(payload.endpoint, input.config.apiKey, style, preparedFetch);
    const source = await deps.anthropic({
      client: { ...options, ...(preparedFetch ? { fetch: options.fetch ?? preparedFetch, logLevel: "off" as const } : {}) },
      body: payload.body, signal: cancellation.signal,
    });
    const parser = new AnthropicEventNormalizer();
    try {
      for await (const frame of source.events) {
        for (const patch of parser.normalize(frame)) dispatch(patch);
      }
      flush();
    } catch (cause) {
      // 等待 SDK 后台读取收尾，再交还本次执行的资源。
      try { await source.finalMessage(); } catch { /* 继续抛出最初的异常。 */ }
      throw cause;
    }
    const terminal = await source.finalMessage();
    active();
    const response = reconcileAnthropicTerminal(collected.snapshot(), terminal, input.adapter, input.onDiagnostic);
    return success("anthropic", response);
  } catch (cause) {
    const code = deadlineExpired ? "E_MODEL_REQUEST_TIMEOUT" : input.signal?.aborted ? "MEMORY_CONTEXT_CANCELLED"
      : cause instanceof ProviderProtocolError || cause instanceof AgentRuntimeError ? cause.code
      : connectionLost(cause) ? "E_MODEL_CONNECTION_LOST" : "E_MODEL_REQUEST_FAILED";
    const description = preparedFetch ? code : describeModelError(cause);
    // Only error names and codes along the cause chain (e.g. APIConnectionError <- TypeError <- ECONNRESET), never messages.
    if (preparedFetch) console.error("[model-request] 流式请求失败:", code, causeCodes(cause));
    else console.error("[image-send] 流式请求失败:", `\n  model id: ${input.model}`,
      `\n  baseUrl: ${endpoint || "请求未发出"}`, `\n  error: ${description}`);
    if (trace) dumpResponse(trace, { transport: input.adapter.transport, ok: false, raw: null, error: description });
    if (deadlineExpired) throw new AgentRuntimeError("E_MODEL_REQUEST_TIMEOUT", "模型响应超时，请稍后重试。", { cause });
    if (input.signal?.aborted) throw abortReason(input.signal);
    if (cause instanceof ProviderProtocolError || cause instanceof AgentRuntimeError) throw cause;
    if (code === "E_MODEL_CONNECTION_LOST") throw new AgentRuntimeError(code, "模型服务连接中断。", { cause });
    throw new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "模型服务请求失败。", { cause });
  } finally {
    if (alarm !== undefined) clearTimeout(alarm);
    input.signal?.removeEventListener("abort", relay);
  }
}
