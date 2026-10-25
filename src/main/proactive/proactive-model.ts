import type { MainMemoryRun } from "../memory-context/main-memory-runtime";
import type { TranscriptSink } from "../orchestrator/transcript-sink";
import { recordUsage, recordRequest } from "../storage/token-usage-store";
import { getAdapterForConfig, type ChatMessage, type VendorConfig } from "../orchestrator/vendors";
import { parseProactiveDecision, type ProactiveModelDecision } from "./proactive-prompt";

export type RunProactiveModelInput = {
  messages: ChatMessage[];
  settings: VendorConfig;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  memoryRun?: MainMemoryRun;
  transcriptSink?: TranscriptSink;
};

export type ProactiveModelResult = ProactiveModelDecision | { kind: "error"; reason: string };

type ProviderAdapter = ReturnType<typeof getAdapterForConfig>;
type UsageRecord = {
  input: number;
  output: number;
  cachedInput?: number;
  cacheCreation?: number;
};

/** 主动轮禁止携带任何工具相关的消息。 */
function hasToolTraffic(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === "tool" || Boolean(m.toolCallId) || Boolean(m.toolCalls?.length));
}

function accountProactiveCall(model: string, usage: UsageRecord | undefined): void {
  recordRequest(model, "proactive");
  if (!usage) return;
  recordUsage(usage.input, usage.output, 1, usage.cachedInput, model, usage.cacheCreation, "proactive");
}

/** 经 Main 记忆运行时发起调用：先落 transcript，再记账，最后解析。 */
async function callThroughMemory(
  input: RunProactiveModelInput,
  adapter: ProviderAdapter,
  request: { model: string; messages: ChatMessage[]; stream: false; maxTokens: number },
  signal: AbortSignal,
): Promise<ProactiveModelDecision> {
  const memoryRun = input.memoryRun as MainMemoryRun;
  if (!input.transcriptSink) throw Error("MEMORY_CONTEXT_STREAM_SINK_DENIED");
  const reply = await memoryRun.call({
    adapter,
    request,
    config: input.settings,
    timeoutMs: input.timeoutMs,
    signal,
  });
  if (signal.aborted) throw Error("MEMORY_CONTEXT_CANCELLED");
  const sink = memoryRun.bindSink(input.transcriptSink);
  await sink.appendAssistant({
    message: reply.assistantMessage ?? { role: "assistant", content: reply.text ?? "" },
  });
  await sink.checkpoint();
  accountProactiveCall(input.settings.model, reply.usage);
  return parseProactiveDecision(reply.text ?? "");
}

/** 直接走 fetch：非 2xx 返回 http_状态码；响应体无法被适配器解析时视为 invalid。 */
async function callDirect(
  input: RunProactiveModelInput,
  adapter: ProviderAdapter,
  request: { model: string; messages: ChatMessage[]; stream: false; maxTokens: number },
  signal: AbortSignal,
): Promise<ProactiveModelDecision | { kind: "error"; reason: string }> {
  const built = adapter.buildRequest(request, input.settings);
  const httpResponse = await (input.fetchFn ?? fetch)(built.url, {
    method: "POST",
    headers: built.headers,
    body: built.body,
    signal,
  });
  if (!httpResponse.ok) return { kind: "error", reason: `http_${httpResponse.status}` };

  const payload = await httpResponse.json();
  let decoded;
  try {
    decoded = adapter.parseResponse(payload);
  } catch {
    return { kind: "invalid", reason: "invalid_provider_response" };
  }
  accountProactiveCall(input.settings.model, decoded.usage);
  return parseProactiveDecision(decoded.text ?? "");
}

/** 把底层异常映射为稳定的 reason 字符串。 */
function reasonFromError(error: unknown): { kind: "error"; reason: string } {
  if (error instanceof Error && /^MEMORY_[A-Z0-9_]+$/.test(error.message)) {
    return { kind: "error", reason: error.message };
  }
  const name = error instanceof Error ? error.name : "";
  return { kind: "error", reason: name === "AbortError" ? "timeout" : "network_error" };
}

export async function runProactiveModel(input: RunProactiveModelInput): Promise<ProactiveModelResult> {
  if (hasToolTraffic(input.messages)) return { kind: "error", reason: "tool_content_forbidden" };

  const adapter = getAdapterForConfig(input.settings);
  const request = {
    model: input.settings.model,
    messages: input.messages,
    stream: false as const,
    maxTokens: 600,
  };

  const deadline = new AbortController();
  const timeoutHandle = setTimeout(() => deadline.abort(), Math.max(1, input.timeoutMs));
  const combined = input.signal
    ? AbortSignal.any([input.signal, deadline.signal])
    : deadline.signal;
  try {
    if (combined.aborted) throw Error("MEMORY_CONTEXT_CANCELLED");
    if (input.memoryRun) {
      return await callThroughMemory(input, adapter, request, combined);
    }
    return await callDirect(input, adapter, request, combined);
  } catch (error) {
    return reasonFromError(error);
  } finally {
    clearTimeout(timeoutHandle);
  }
}
