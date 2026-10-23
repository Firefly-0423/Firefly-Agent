import type { PromptLayerMetadata } from "../prompt-layers";
import type { ReasoningPreference, ReasoningLevelsConfig } from "../../../shared/reasoning";

export type TestStrategy = "text+tool" | "text";
export type CacheStrategy = "none" | "auto" | "cache_control" | "prompt_cache_key";
export type ThinkingField = null | "reasoning_details" | "thinking" | "reasoning_content";
export type AuthStyle = "x-api-key" | "bearer";
export type Transport = "responses" | "anthropic" | "openai";

export type VendorConfig = {
  reasoningLevels?: ReasoningLevelsConfig;
  reasoning?: ReasoningPreference;
  explicitTransport?: Transport;
  apiKey: string;
  model: string;
  baseUrl: string;
  provider: string;
};
export type OpenAIContentBlock =
  | { image_url: { url: string }; type: "image_url" }
  | { text: string; type: "text" };
export type ChatMessageContent = OpenAIContentBlock[] | string;
export type ToolCall = { arguments: string; name: string; id: string };
export type ChatMessage = {
  internal?: {
    createdAt: number;
    runId: string;
    id: string;
    digest: string;
    revision: number;
    kind: "run_start" | "state_delta" | "recovery";
  };
  visibility?: "user" | "internal";
  rawAssistant?: unknown;
  thinking?: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  content?: ChatMessageContent;
  role: "system" | "user" | "assistant" | "tool";
};
export type ToolSpec = { parameters: object; description: string; name: string };
export type StructuredOutputRequest =
  | { strict: boolean; schema: object; name: string; mode: "json_schema" }
  | { schema?: object; name?: string; mode: "json_object" }
  | { schema?: object; name?: string; sendJsonObjectHint: boolean; mode: "prompt_json" };
export type ChatRequest = {
  promptLayers?: PromptLayerMetadata;
  extraBody?: Record<string, unknown>;
  maxTokens?: number;
  structuredOutput?: StructuredOutputRequest;
  stream?: boolean;
  repetitionPenalty?: number;
  frequencyPenalty?: number;
  topP?: number;
  temperature?: number;
  toolChoiceIntent?: { toolName: string; mode: "must_call" };
  tools?: ToolSpec[];
  messages: ChatMessage[];
  model: string;
};
export type StreamEvent = { data: string; eventType: string };
export type StreamChunk = {
  usage?: { cacheCreation?: number; cachedInput?: number; output: number; input: number };
  done?: boolean;
  deltaToolCalls?: ToolCall[];
  error?: string;
  finishReason?: string;
  deltaThinking?: string;
  deltaText?: string;
};
export type ChatResponse = {
  usage?: { cacheCreation?: number; cachedInput?: number; output: number; input: number };
  structuredValue?: unknown;
  raw: unknown;
  finishReason: string;
  toolCalls: ToolCall[];
  refusal?: string;
  thinking?: string;
  text: string;
  assistantMessage: ChatMessage;
};
export type HttpRequest = { body: string; headers: Record<string, string>; method: "POST"; url: string };
export type ToolExecutionResult = { output: string; toolCall: ToolCall };
export type TestConnectionResult = { error?: string; sample?: string; latency: number; ok: boolean };
export type ProviderCapability = {
  disabled?: boolean;
  visionBaseUrl?: string;
  responsesEncryptedReasoning?: boolean;
  supportedTransports?: readonly Transport[];
  toolChoiceModes?: ReadonlyArray<"named" | "required" | "auto" | "omit">;
  testStrategy: TestStrategy;
  cacheStrategy: CacheStrategy;
  thinkingField: ThinkingField;
  supportsThinking: boolean;
  supportsTools: boolean;
  defaultModel: string;
  anthropicAuthStyle?: AuthStyle;
  authStyle: AuthStyle;
  baseUrl: string;
  transport: Transport;
  displayName: string;
  id: string;
};
export type ChatVendorAdapter = {
  testConnection(cfg: VendorConfig): Promise<TestConnectionResult>;
  parseStreamEvent(event: StreamEvent): StreamChunk | null;
  buildStreamRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest;
  applyCacheHints?(req: ChatRequest, cfg: VendorConfig): ChatRequest;
  appendToolResults(messages: ChatMessage[], results: ToolExecutionResult[]): ChatMessage[];
  parseResponse(raw: unknown): ChatResponse;
  buildRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest;
  capability: ProviderCapability;
  readonly transport: Transport;
  readonly id: string;
};
