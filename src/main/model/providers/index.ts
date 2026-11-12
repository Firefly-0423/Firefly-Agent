import { OpenAICompatAdapter } from "./openai-adapter";
import { AnthropicAdapter } from "./anthropic-adapter";
import { ResponsesAdapter } from "./responses-adapter";
import { getCapability, getCapabilityOrOpenAI, PROVIDER_CAPABILITIES } from "./capabilities";
import { resolveTransport } from "./transport-detector";
import { resolveApiEndpoint } from "../../../shared/api-endpoint";
import type { ChatVendorAdapter, VendorConfig, Transport, StreamEvent } from "./types";

export type {
  Transport, VendorConfig, ToolSpec, StructuredOutputRequest, ToolExecutionResult, ToolCall,
  TestConnectionResult, StreamEvent, StreamChunk, ProviderCapability, HttpRequest,
  ChatVendorAdapter, ChatResponse, ChatRequest, ChatMessage,
} from "./types";
export { PROVIDER_CAPABILITIES, getCapabilityOrOpenAI, getCapability };
export { resolveTransport } from "./transport-detector";
export { FireflyStreamAccumulator } from "./sdk-stream/accumulator";
export { streamChatWithSdk } from "./sdk-stream/runtime";
export { ProviderProtocolError } from "./sdk-stream/types";
export type { UnifiedStreamDelta, StreamDiagnostic } from "./sdk-stream/types";

const adapters = new Map<string, ChatVendorAdapter>();
export function getAdapterForConfig(cfg: VendorConfig): ChatVendorAdapter {
  const protocol = resolveTransport({ baseUrl: cfg.baseUrl, explicitTransport: cfg.explicitTransport, provider: cfg.provider });
  const identity = `${cfg.provider}::${protocol}`;
  const cached = adapters.get(identity);
  if (cached) return cached;
  const rules = getCapabilityOrOpenAI(cfg.provider);
  let created: ChatVendorAdapter;
  switch (protocol) {
    case "anthropic": created = new AnthropicAdapter(rules.id, rules); break;
    case "responses": created = new ResponsesAdapter(rules.id, rules); break;
    default: created = new OpenAICompatAdapter(rules.id, rules);
  }
  adapters.set(identity, created);
  return created;
}
export function buildVendorUrl(baseUrl: string, transport: Transport): string {
  return resolveApiEndpoint(baseUrl, transport).url;
}

function parseSseBlock(block: string): StreamEvent | null {
  let kind = "data";
  const fragments: string[] = [];
  for (const original of block.split("\n")) {
    const normalized = original.replace(/\r$/, "");
    if (!normalized || normalized.startsWith(":")) continue;
    if (normalized.startsWith("event:")) kind = normalized.slice(6).trim();
    else if (normalized.startsWith("data:")) fragments.push(normalized.slice(5).replace(/^ /, ""));
  }
  return fragments.length === 0 ? null : { eventType: kind, data: fragments.join("\n") };
}
function findSseBoundary(buffer: string): { index: number; length: number } | null {
  const separator = /\r?\n\r?\n/.exec(buffer);
  if (separator === null) return null;
  return { index: separator.index, length: separator[0].length };
}
export function createSseReader(_adapter: ChatVendorAdapter, body: ReadableStream<Uint8Array>): AsyncIterable<StreamEvent> {
  const utf8 = new TextDecoder("utf-8");
  const input = body.getReader();
  let pending = "";
  return {
    [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
      return {
        async next(): Promise<IteratorResult<StreamEvent>> {
          for (;;) {
            const split = findSseBoundary(pending);
            if (split) {
              const frame = pending.slice(0, split.index);
              pending = pending.slice(split.index + split.length);
              const parsed = parseSseBlock(frame);
              if (parsed) return { value: parsed, done: false };
              continue;
            }
            const chunk = await input.read();
            if (!chunk.done) {
              pending += utf8.decode(chunk.value, { stream: true });
              continue;
            }
            pending += utf8.decode();
            if (pending.trim().length > 0) {
              const last = parseSseBlock(pending);
              pending = "";
              if (last) return { value: last, done: false };
            }
            return { value: undefined, done: true };
          }
        },
        async return(): Promise<IteratorResult<StreamEvent>> {
          try { await input.cancel(); } catch { /* 关闭失败不阻止迭代器结束。 */ }
          return { value: undefined, done: true };
        },
      };
    },
  };
}
