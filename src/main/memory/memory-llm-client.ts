/**
 * Memory 子系统的统一 LLM 调用层，提供两条路径：
 *   - invokeMemoryLlm：直接调用，返回原始文本（尚未迁移的调用方仍在用）
 *   - invokeMemoryStructuredOutput：走 A/B/D/M 结构化输出流水线，业务侧直接拿到校验后的对象
 *
 * 新代码优先用后者：厂商请求格式、JSON Schema / JSON Object / Prompt JSON 的选择、
 * <think> 清理、JSON 提取、Repair、关闭 reasoning、temperature 兼容都由流水线处理。
 */

import { getCapability } from "../orchestrator/vendors/capabilities";
import { runStructuredOutput } from "../orchestrator/structured-output/runner";
import type { StructuredRepairContext, BusinessValidationResult } from "../orchestrator/structured-output/runner";
import { resolveMaxOutputTokens, resolveTimeoutPolicy } from "../runtime-policy";
import type { RuntimeStage } from "../runtime-policy";
import { recordRequest, recordUsage } from "../token-usage-store";
import { getAdapterForConfig } from "../orchestrator/vendors";
import type { ChatRequest, ChatMessage, VendorConfig } from "../orchestrator/vendors";
import type { StructuredOutputProfile, StructuredOutputStage } from "../orchestrator/structured-output/types";
import { resolveStructuredOutputProfile, classifyStructuredOutputEndpoint } from "../orchestrator/structured-output/profiles";
import { loadMemoryModelConfig, stripThinkBlocks } from "./memory-llm-shared";
import type { MemoryModelConfig, MemoryModelConfigSource } from "./memory-llm-shared";
import * as llmErrors from "./memory-llm-errors";
import { MEMORY_RESOLVE_JSON_SCHEMA, MEMORY_REFLECTION_JSON_SCHEMA, MEMORY_JUDGE_JSON_SCHEMA } from "./memory-schemas";

const { MemoryLlmTimeoutError, MemoryLlmHttpError, MemoryLlmProtocolError, MemoryLlmConfigurationError } = llmErrors;

export type MemoryLlmOperation = "judge" | "compress" | "reflect" | "resolve";

export type MemoryLlmRequest = {
  config?: MemoryModelConfig;
  signal?: AbortSignal;
  maxOutputTokens: number;
  messages: Array<{ role: "system" | "user"; content: string }>;
  operation: MemoryLlmOperation;
};

export type MemoryLlmResponse = {
  model: string;
  provider: string;
  text: string;
};

export type InvokeMemoryStructuredOutputOptions<T> = {
  config?: MemoryModelConfig;
  signal?: AbortSignal;
  validateBusiness: (value: T) => BusinessValidationResult<T>;
  parseSchema: (value: unknown) => T;
  maxOutputTokens: number;
  userPrompt: string;
  systemPrompt: string;
  operation: MemoryLlmOperation;
};

/** 每种操作对应的运行时策略阶段、结构化输出阶段与 repair 提示 */
const OPERATION_TABLE: Record<
  MemoryLlmOperation,
  { tokenStage: RuntimeStage; soStage: StructuredOutputStage; repairFormat: string }
> = {
  judge: {
    tokenStage: "memory-judge",
    soStage: "memory_judge",
    repairFormat: '顶层必须是 JSON 对象，格式为 {"candidates":[...],"entities":[...]}；没有候选时返回 {"candidates":[],"entities":[]}。',
  },
  compress: {
    tokenStage: "memory-compressor",
    soStage: "memory_compress",
    repairFormat: '顶层必须是 JSON 对象，格式为 {"groups":[...]}。',
  },
  reflect: {
    tokenStage: "memory-reflect",
    soStage: "memory_reflect",
    repairFormat: '顶层必须是 JSON 对象，格式为 {"updates":[...]}；没有更新时返回 {"updates":[]}。',
  },
  resolve: {
    tokenStage: "memory-resolver",
    soStage: "memory_resolve",
    repairFormat: "顶层必须是一个符合原始字段要求的 JSON 对象。",
  },
};

function buildRepairMessage(operation: MemoryLlmOperation, repair: StructuredRepairContext): ChatMessage | undefined {
  if (repair.attempt === 0) return undefined;
  const codes = repair.errors.map((e) => e.code).join(", ") || "UNKNOWN_VALIDATION_ERROR";
  const content =
    `上一次输出未通过结构化校验，错误代码：${codes}。\n` +
    `${OPERATION_TABLE[operation].repairFormat}\n` +
    "请重新生成完整结果，只输出 JSON，不要附加 Markdown 代码围栏或解释文字。";
  return { role: "user", content };
}

export function getDefaultMaxOutputTokens(operation: MemoryLlmOperation): number {
  return resolveMaxOutputTokens({ stage: OPERATION_TABLE[operation].tokenStage });
}

function resolveMemoryProfile(config: MemoryModelConfig): StructuredOutputProfile {
  const { provider, model, baseUrl } = config;
  const cap = getCapability(provider);
  let endpointKind: ReturnType<typeof classifyStructuredOutputEndpoint> | "custom" = "custom";
  if (cap) {
    endpointKind = classifyStructuredOutputEndpoint({
      providerId: cap.id,
      configuredBaseUrl: baseUrl,
      officialBaseUrl: cap.baseUrl,
    });
  }
  const transport = cap?.transport ?? "openai";
  return resolveStructuredOutputProfile({ provider: cap?.id ?? provider, model, transport, endpointKind });
}

function buildVendorConfig(config: MemoryModelConfig): VendorConfig {
  const { provider, baseUrl, model, apiKey, explicitTransport } = config;
  return { provider, baseUrl, model, apiKey, explicitTransport };
}

function requireApiKey(config: MemoryModelConfig): void {
  if (!config.apiKey) {
    throw new MemoryLlmConfigurationError(`missing API key for Memory LLM (source: ${config.source})`);
  }
}

type VendorAdapter = ReturnType<typeof getAdapterForConfig>;
type ParsedVendorResponse = ReturnType<VendorAdapter["parseResponse"]>;

const ERROR_BODY_LIMIT = 1500;

/** 错误响应里尽量取出 error.message，过长则截断；读不出就返回 undefined */
async function readErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const payload = (await response.json()) as { error?: { message?: string } };
    const message = payload.error?.message;
    return message && message.length > ERROR_BODY_LIMIT ? message.slice(0, ERROR_BODY_LIMIT) + "…(truncated)" : message;
  } catch {
    return undefined;
  }
}

/**
 * 发出一次厂商请求并解析响应；超时、外部取消、HTTP 失败、响应无法解析都在这里翻译成对应错误。
 * 解析成功后顺带记录用量（记录失败不影响结果）。
 */
async function postToVendor(
  operation: MemoryLlmOperation,
  adapter: VendorAdapter,
  request: ChatRequest,
  cfg: VendorConfig,
  externalSignal: AbortSignal | undefined,
): Promise<ParsedVendorResponse> {
  const wire = adapter.buildRequest(request, cfg);

  const timeoutMs = resolveTimeoutPolicy({ stage: "memory-llm" }).totalMs;
  const abortCtl = new AbortController();
  const killTimer = setTimeout(() => abortCtl.abort(), timeoutMs);

  if (externalSignal?.aborted) abortCtl.abort();
  const forwardAbort = () => abortCtl.abort();
  externalSignal?.addEventListener("abort", forwardAbort);

  let response: Response;
  try {
    response = await fetch(wire.url, {
      body: wire.body,
      headers: wire.headers,
      signal: abortCtl.signal,
      method: "POST",
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    if (!aborted) throw err;
    if (externalSignal?.aborted) throw new Error(`Memory LLM [${operation}] cancelled by external signal`);
    throw new MemoryLlmTimeoutError(timeoutMs, operation);
  } finally {
    clearTimeout(killTimer);
    externalSignal?.removeEventListener("abort", forwardAbort);
  }

  if (!response.ok) {
    throw new MemoryLlmHttpError(response.status, operation, await readErrorMessage(response));
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new MemoryLlmProtocolError(operation, "failed to parse response JSON");
  }

  const parsed = adapter.parseResponse(body);

  recordRequest(cfg.model, "memory");
  const usage = parsed.usage;
  if (usage) {
    try {
      recordUsage(usage.input, usage.output, 1, usage.cachedInput, cfg.model, usage.cacheCreation, "memory");
    } catch { /* 用量统计失败不影响主流程 */ }
  }

  return parsed;
}

type SchemaOperation = Exclude<MemoryLlmOperation, "compress">;
const SCHEMA_BY_OPERATION: Record<SchemaOperation, Record<string, unknown>> = {
  resolve: MEMORY_RESOLVE_JSON_SCHEMA,
  reflect: MEMORY_REFLECTION_JSON_SCHEMA,
  judge: MEMORY_JUDGE_JSON_SCHEMA,
};

function buildStructuredOutputRequest(profile: StructuredOutputProfile, operation: MemoryLlmOperation): ChatRequest["structuredOutput"] {
  const name = `memory_${operation}`;
  switch (profile.mode) {
    case "provider_json_schema":
      return {
        mode: "json_schema",
        name,
        schema: operation === "compress" ? {} : SCHEMA_BY_OPERATION[operation],
        strict: true,
      };
    case "provider_json_object":
      return { mode: "json_object", name };
    default:
      return { mode: "prompt_json", sendJsonObjectHint: profile.requestHints.sendJsonObject };
  }
}

/** 走结构化输出流水线调用 Memory LLM，返回通过校验的对象，失败统一抛 MemoryLlmProtocolError */
export async function invokeMemoryStructuredOutput<T>(options: InvokeMemoryStructuredOutputOptions<T>): Promise<T> {
  const { operation, systemPrompt, userPrompt, maxOutputTokens, parseSchema, validateBusiness, signal } = options;
  const config = options.config ?? loadMemoryModelConfig();
  requireApiKey(config);

  const profile = resolveMemoryProfile(config);
  const cfg = buildVendorConfig(config);
  const adapter = getAdapterForConfig(cfg);

  const outcome = await runStructuredOutput<T, ChatRequest>({
    validateBusiness,
    parseSchema,
    generate: async (request, generateSignal) => {
      const parsed = await postToVendor(operation, adapter, request, cfg, generateSignal);
      const { finishReason, refusal, structuredValue } = parsed;
      return { text: parsed.text ?? "", finishReason, refusal, structuredValue };
    },
    buildRequest: (repair) => {
      const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];
      messages.push({ role: "user", content: userPrompt });
      const request: ChatRequest = {
        model: cfg.model,
        messages: [],
        stream: false,
        maxTokens: maxOutputTokens,
        structuredOutput: buildStructuredOutputRequest(profile, operation),
      };
      const fixUp = buildRepairMessage(operation, repair);
      if (fixUp) messages.push(fixUp);
      request.messages = messages;
      if (profile.requestHints.reasoningSplit) request.extraBody = { reasoning_split: true };
      return request;
    },
    signal,
    profile,
    stage: OPERATION_TABLE[operation].soStage,
  });

  if (outcome.outcome === "failure") {
    const { code, stage } = outcome.failure;
    throw new MemoryLlmProtocolError(operation, `structured output failed: ${code} (stage: ${stage})`);
  }

  return outcome.value;
}

/** 旧链路：直接发消息，返回去掉 <think> 的原始文本 */
export async function invokeMemoryLlm(request: MemoryLlmRequest): Promise<MemoryLlmResponse> {
  const { operation, messages, maxOutputTokens, signal } = request;
  const config = request.config ?? loadMemoryModelConfig();
  requireApiKey(config);

  const cfg = buildVendorConfig(config);
  const plain: ChatRequest = {
    model: cfg.model,
    messages: messages as ChatMessage[],
    maxTokens: maxOutputTokens,
    stream: false,
  };
  const reply = await postToVendor(operation, getAdapterForConfig(cfg), plain, cfg, signal);
  const { provider, model } = config;
  return { text: stripThinkBlocks(reply.text ?? ""), provider, model };
}
