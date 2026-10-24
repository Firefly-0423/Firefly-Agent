import { getAdapterForConfig, streamChatWithSdk, resolveTransport } from "../vendors";
import { recordUsage, recordRequest, recordModelCall } from "../../storage/token-usage-store";
import type { VendorConfig, ToolSpec, ChatResponse, ChatRequest, ChatMessage } from "../vendors/types";
import type { HarnessConfig } from "./types";
import type { MainMemoryRun } from "../../memory-context/main-memory-runtime";
import { AGENT_COMPACTION_PROMPT } from "./compaction";
import { isExplicitStreamUnsupported } from "../vendors/stream-support";
import { composePromptLayers, normalizeToolSpecsForCache, type PromptLayers } from "../prompt-layers";

function resolveRequestMaxTokens(vendorConfig: VendorConfig): number | undefined {
  if (resolveTransport(vendorConfig) === "anthropic") return 32_768;
  return undefined;
}
export async function callLLM(vendorConfig: VendorConfig, promptLayers: PromptLayers,
  messages: ChatMessage[], tools: ToolSpec[], config: HarnessConfig, signal?: AbortSignal,
  onReasoningDelta?: (delta: string) => void, onTextDelta?: (delta: string) => void,
  memoryRun?: MainMemoryRun): Promise<ChatResponse> {
  const adapter = getAdapterForConfig(vendorConfig);
  const composed = composePromptLayers(promptLayers, messages);
  const maximum = resolveRequestMaxTokens(vendorConfig);
  const initial: ChatRequest = { model: vendorConfig.model, messages: composed.messages,
    tools: normalizeToolSpecsForCache(tools), stream: true,
    ...(maximum !== undefined ? { maxTokens: maximum } : {}), promptLayers: composed.metadata };
  const outgoing = adapter.applyCacheHints?.(initial, vendorConfig) ?? initial;
  let streamed = false;
  let began = performance.now();
  let firstToken: number | undefined;
  const account = (response: ChatResponse): ChatResponse => {
    const ended = performance.now();
    recordModelCall({ durationMs: ended - began,
      ...(firstToken !== undefined ? { ttftMs: firstToken - began, generationMs: ended - firstToken } : {}),
      outputTokens: response.usage?.output });
    recordRequest(vendorConfig.model);
    if (response.usage) recordUsage(response.usage.input, response.usage.output, 1,
      response.usage.cachedInput, vendorConfig.model, response.usage.cacheCreation);
    return response;
  };
  try {
    const dispatch = memoryRun ? (input: Parameters<MainMemoryRun["call"]>[0]) => memoryRun.call(input) : streamChatWithSdk;
    return account(await dispatch({ adapter, request: outgoing, config: vendorConfig, timeoutMs: config.modelRequestTimeoutMs, signal,
      onDelta: (patch) => {
        if (patch.type !== "usage" && (!("delta" in patch) || patch.delta.length > 0)) {
          streamed = true;
          firstToken ??= performance.now();
        }
        if (patch.type === "reasoning_delta" && patch.delta) onReasoningDelta?.(patch.delta);
        if (patch.type === "text_delta" && patch.delta) onTextDelta?.(patch.delta);
      },
    }));
  } catch (cause) {
    const unsupported = () => isExplicitStreamUnsupported(cause)
      || memoryRun && cause instanceof Error && cause.message === "MEMORY_CONTEXT_STREAM_UNSUPPORTED";
    if (streamed || !unsupported()) throw cause;
  }
  began = performance.now();
  firstToken = undefined;
  const retry: ChatRequest = { ...outgoing, stream: false };
  if (memoryRun) return account(await memoryRun.call({ adapter, request: retry, config: vendorConfig, timeoutMs: config.modelRequestTimeoutMs, signal }));
  const serialized = adapter.buildRequest(retry, vendorConfig);
  const response = await fetch(serialized.url, { method: "POST", headers: serialized.headers, body: serialized.body,
    signal: config.modelRequestTimeoutMs > 0
      ? AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(config.modelRequestTimeoutMs)]) : signal });
  if (response.ok) return account(adapter.parseResponse(await response.json()));
  const detail = await response.text().catch(() => "");
  console.error("[image-send] LLM 请求被拒:", `\n  model id: ${vendorConfig.model}`, `\n  baseUrl: ${serialized.url}`,
    `\n  error: HTTP ${response.status} ${detail.slice(0, 500) || "(无响应体)"}`);
  let failure = `模型请求失败：HTTP ${response.status}`;
  try {
    const decoded = JSON.parse(detail || "{}") as { error?: { message?: unknown } } | null;
    if (typeof decoded?.error?.message === "string" && decoded.error.message.trim()) failure = decoded.error.message;
  } catch {
    // 网关可能返回 HTML 或残缺 JSON，此时保留 HTTP 状态说明。
  }
  throw new Error(failure);
}
export async function summarizeHistory(vendorConfig: VendorConfig, systemPrompt: string, history: ChatMessage[],
  tools: ToolSpec[], signal?: AbortSignal): Promise<string> {
  const adapter = getAdapterForConfig(vendorConfig);
  const request: ChatRequest = { model: vendorConfig.model,
    messages: [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: AGENT_COMPACTION_PROMPT }],
    tools: normalizeToolSpecsForCache(tools), stream: false,
    ...(resolveRequestMaxTokens(vendorConfig) !== undefined ? { maxTokens: resolveRequestMaxTokens(vendorConfig) } : {}) };
  const serialized = adapter.buildRequest(request, vendorConfig);
  const response = await fetch(serialized.url, { method: "POST", headers: serialized.headers, body: serialized.body, signal });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("[image-send] 摘要请求被拒:", `\n  model id: ${vendorConfig.model}`, `\n  baseUrl: ${serialized.url}`,
      `\n  error: HTTP ${response.status} ${detail.slice(0, 500) || "(无响应体)"}`);
    throw new Error(`摘要请求失败：HTTP ${response.status}`);
  }
  const parsed = adapter.parseResponse(await response.json());
  return parsed.text;
}
