// 从用户接入的厂商 API 拉取模型清单，供设置页的"模型名"联想使用。
// 型号由厂商决定，不再只靠预设里写死的几个名字；拉不到时设置页仍回退到预设建议。
import type { ApiTransport } from "../../shared/api-endpoint";
import { authHeaderFor } from "../orchestrator/vendors/auth";
import { getCapabilityOrOpenAI } from "../orchestrator/vendors/capabilities";
import type { InputModality } from "../../shared/input-modalities";

export interface FetchModelsInput {
  provider: string;
  baseUrl: string;
  apiKey: string;
  explicitTransport?: ApiTransport;
}

export interface VendorModel {
  id: string;
  /** 厂商给出的展示名（如 Anthropic 的 display_name），没有就缺省。 */
  name?: string;
  /** 厂商声明的输入模态。缺省 = 厂商没说（未知），不等于“仅文本”。 */
  inputModalities?: InputModality[];
}

export type FetchModelsResult =
  | { ok: true; models: VendorModel[] }
  | { ok: false; error: "MISSING_BASE_URL" | "MISSING_API_KEY" | "NETWORK" | "TIMEOUT" | "BAD_RESPONSE" | `HTTP_${number}` };

const ANTHROPIC_VERSION = "2023-06-01";
/** Anthropic 单页上限；只读第一页，不跟随 has_more。 */
const ANTHROPIC_PAGE_LIMIT = 1000;
const MAX_MODELS = 1000;
/** 端点是用户填的任意地址，超过这个字节数的回包直接拒收（截断的清单无法解析）。 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** 各协议的"模型列表"地址：去掉用户可能填成完整调用地址的后缀，再补 /models。 */
export function resolveModelsUrl(baseUrl: string, transport: ApiTransport): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "").replace(/\/(chat\/completions|responses|messages)$/, "");
  if (transport === "anthropic") return `${trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`}/models?limit=${ANTHROPIC_PAGE_LIMIT}`;
  return `${trimmed}/models`;
}

const textOf = (...candidates: unknown[]): string => {
  for (const candidate of candidates) if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  return "";
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** 把厂商给的模态标记收敛成 text / image（容忍大小写与首尾空白）；一个都不认得返回 undefined。 */
function modalitiesFromTokens(tokens: unknown): InputModality[] | undefined {
  if (!Array.isArray(tokens)) return undefined;
  const wanted = new Set(tokens.map((token) => (typeof token === "string" ? token.trim().toLowerCase() : "")));
  const found = (["text", "image"] as const).filter((modality) => wanted.has(modality));
  return found.length > 0 ? [...found] : undefined;
}

/**
 * 读单个模型条目的输入模态，按可信度从高到低：显式列表 > OpenRouter 旧式 modality 字符串 > 布尔能力位。
 * 形状（都有单测夹具）：OpenRouter architecture.input_modalities / architecture.modality；
 * Anthropic capabilities.image_input.supported；通用 input_modalities / modalities（数组或 {input:[...]}）；
 * capabilities.vision（Mistral 等）、supports_vision、vision。认不出任何模态信息返回 undefined（= 未知）。
 */
function parseInputModalities(entry: Record<string, unknown>): InputModality[] | undefined {
  const architecture = asRecord(entry.architecture);
  const capabilities = asRecord(entry.capabilities);
  const { modalities } = entry;
  const lists = [
    architecture?.input_modalities,
    entry.input_modalities,
    Array.isArray(modalities) ? modalities : asRecord(modalities)?.input,
  ];
  for (const list of lists) {
    const found = modalitiesFromTokens(list);
    if (found) return found;
  }
  if (typeof architecture?.modality === "string") {
    const found = modalitiesFromTokens(architecture.modality.split("->")[0].split("+"));
    if (found) return found;
  }
  const flags = [asRecord(capabilities?.image_input)?.supported, capabilities?.vision, entry.supports_vision, entry.vision];
  for (const flag of flags) {
    if (typeof flag === "boolean") return flag ? ["text", "image"] : ["text"];
  }
  return undefined;
}

/**
 * 读一份模型清单。标准的 { data: [...] }（OpenAI / Anthropic）优先；
 * 其次是部分网关的 { models: [...] } 数组，或以型号为键的 { models: { id: {...} } } 映射——
 * 映射里用属性名当请求 id（内层 id 可能是规范名而不是网关接受的别名），
 * 且只认对象值，避免把计数、状态之类的元数据当成型号。纯数组也接受。
 */
export function parseModelList(body: unknown): VendorModel[] {
  const record = body && typeof body === "object" && !Array.isArray(body) ? body as { data?: unknown; models?: unknown } : undefined;
  let rows: Array<{ key?: string; raw: unknown }> = [];
  if (Array.isArray(body)) rows = body.map((raw) => ({ raw }));
  else if (Array.isArray(record?.data)) rows = record.data.map((raw) => ({ raw }));
  else if (Array.isArray(record?.models)) rows = record.models.map((raw) => ({ raw }));
  else if (record?.models && typeof record.models === "object") {
    rows = Object.entries(record.models as Record<string, unknown>)
      .filter(([, raw]) => raw !== null && typeof raw === "object" && !Array.isArray(raw))
      .map(([key, raw]) => ({ key, raw }));
  }
  const seen = new Set<string>();
  const models: VendorModel[] = [];
  for (const { key, raw } of rows) {
    const entry = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
    const id = textOf(key, typeof raw === "string" ? raw : undefined, entry?.id, entry?.name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const display = textOf(entry?.display_name, entry?.displayName, entry?.name);
    const inputModalities = entry ? parseInputModalities(entry) : undefined;
    models.push({
      id,
      ...(display && display !== id ? { name: display } : {}),
      ...(inputModalities ? { inputModalities } : {}),
    });
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

/** 读回包，字节数以实际读到的为准（不信服务器声明的长度）；超限返回 undefined。 */
async function readBoundedText(response: Response): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) { await response.body?.cancel().catch(() => undefined); return undefined; }
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) return undefined;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

export async function fetchVendorModels(
  input: FetchModelsInput,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<FetchModelsResult> {
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (!baseUrl) return { ok: false, error: "MISSING_BASE_URL" };
  if (!apiKey) return { ok: false, error: "MISSING_API_KEY" };

  const capability = getCapabilityOrOpenAI(input.provider);
  const transport: ApiTransport = input.explicitTransport ?? capability.transport;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...authHeaderFor(capability, apiKey, transport === "anthropic" ? "anthropic" : "openai"),
    ...(transport === "anthropic" ? { "anthropic-version": ANTHROPIC_VERSION } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(resolveModelsUrl(baseUrl, transport), { method: "GET", headers, signal: controller.signal });
    if (!response.ok) return { ok: false, error: `HTTP_${response.status}` };
    let body: unknown;
    try {
      const text = await readBoundedText(response);
      if (text === undefined) return { ok: false, error: "BAD_RESPONSE" };
      body = JSON.parse(text);
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") throw error;
      return { ok: false, error: "BAD_RESPONSE" };
    }
    const models = parseModelList(body);
    return models.length > 0 ? { ok: true, models } : { ok: false, error: "BAD_RESPONSE" };
  } catch (error) {
    return { ok: false, error: (error as { name?: string })?.name === "AbortError" ? "TIMEOUT" : "NETWORK" };
  } finally {
    clearTimeout(timer);
  }
}
