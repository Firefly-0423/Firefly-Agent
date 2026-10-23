import { createHash } from "crypto";
import type { ChatMessage, ChatRequest, ToolSpec } from "./vendors/types";
import { toModelVisibleMessage, isTrustedInternalTranscriptMessage } from "./harness/internal-transcript";

const issuedContexts = new WeakMap<object, string>();
function trustPromptContext(message: ChatMessage): ChatMessage {
  issuedContexts.set(message, JSON.stringify(message));
  return message;
}

export function readTrustedPromptContext(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.flatMap((candidate) => {
    const frozen = issuedContexts.get(candidate);
    if (frozen === undefined) return [];
    if (frozen !== JSON.stringify(candidate)) throw new Error("MEMORY_CONTEXT_PROMPT_CHANGED");
    return [JSON.parse(frozen) as ChatMessage];
  });
}

export interface PromptLayers {
  mode?: string;
  runtimeContext?: string;
  sessionPrefix?: string;
  stablePrefix: string;
}
export interface PromptLayerMetadata {
  promptVersion: string;
  mode?: string;
  sessionPrefix?: string;
  stablePrefix: string;
}

function orderedSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(orderedSchema);
  if (!schema || typeof schema !== "object") return schema;
  const fields = Object.entries(schema as Record<string, unknown>);
  fields.sort((a, b) => a[0].localeCompare(b[0]));
  return Object.fromEntries(fields.map(([name, child]) => [name, orderedSchema(child)]));
}

export function normalizeToolSpecsForCache(tools: readonly ToolSpec[]): ToolSpec[] {
  const normalized = tools.map((definition) => ({
    name: definition.name, description: definition.description, parameters: orderedSchema(definition.parameters) as object,
  }));
  normalized.sort((a, b) => a.name.localeCompare(b.name));
  return normalized;
}

export function buildStableSystemPrefix(layers: Pick<PromptLayers, "stablePrefix" | "sessionPrefix">): string {
  const sections = [layers.stablePrefix, layers.sessionPrefix];
  return sections.filter(Boolean).join("\n\n---\n\n");
}

export function composePromptLayers(layers: PromptLayers, persistedMessages: readonly ChatMessage[]): { messages: ChatMessage[]; metadata: PromptLayerMetadata } {
  const prefix = buildStableSystemPrefix(layers);
  const prefixMessages: ChatMessage[] = prefix ? [{ role: "system", content: prefix }] : [];
  const messages: ChatMessage[] = [...prefixMessages, ...persistedMessages.map((persisted) => {
    const projected = toModelVisibleMessage(persisted);
    return isTrustedInternalTranscriptMessage(persisted) ? trustPromptContext(projected) : projected;
  })];
  if (layers.runtimeContext?.trim()) messages.push(trustPromptContext({
    role: "user", content: `<runtime_context>\n${layers.runtimeContext.trim()}\n</runtime_context>`,
  }));
  return {
    messages, metadata: {
      stablePrefix: layers.stablePrefix,
      ...(layers.sessionPrefix ? { sessionPrefix: layers.sessionPrefix } : {}),
      ...(layers.mode ? { mode: layers.mode } : {}), promptVersion: "v1",
    },
  };
}

export function buildStableCacheFingerprint(input: {
  provider: string; model: string; mode?: string; promptVersion: string;
  stablePrefix: string; sessionPrefix?: string; tools: readonly ToolSpec[];
}): string {
  const serialized = JSON.stringify({
    provider: input.provider, model: input.model, mode: input.mode ?? "", promptVersion: input.promptVersion,
    stablePrefix: input.stablePrefix, sessionPrefix: input.sessionPrefix ?? "", tools: normalizeToolSpecsForCache(input.tools),
  });
  const digest = createHash("sha256").update(serialized).digest("hex");
  return digest.slice(0, 16);
}

export interface CacheRelevantRequest { messages: ChatMessage[]; tools: ToolSpec[]; stableSystem: string }

export function projectCacheRelevantRequest(input: {
  stableSystem: string; tools: readonly ToolSpec[]; messages: readonly ChatMessage[];
}): CacheRelevantRequest {
  return { stableSystem: input.stableSystem,
    tools: normalizeToolSpecsForCache(input.tools),
    messages: input.messages.map((entry) => toModelVisibleMessage(entry)),
  };
}

export function projectCacheRelevantChatRequest(request: ChatRequest): CacheRelevantRequest {
  const prefixes = request.messages.filter((entry) => entry.role === "system");
  return projectCacheRelevantRequest({
    stableSystem: prefixes.map((entry) => String(entry.content ?? "")).join("\n\n"),
    tools: request.tools ?? [],
    messages: request.messages.filter((entry) => entry.role !== "system"),
  });
}
