import { resolveTimeoutPolicy } from "../runtime-policy";
import { raceWithSignal, createAbortError } from "../utils/abort-utils";

export const MOSSLAND_BASE_URL = "https://api.mosi.cn";
const ERROR_DESCRIPTIONS: Record<string, string> = {
  timeout: "请求超时，请稍后重试",
  service: "服务暂时不可用，请稍后重试",
  upstream: "上游服务异常，请稍后重试",
  internal: "服务内部错误，请稍后重试",
  safety_guardrail_blocked: "内容被安全策略拦截，请修改后重试",
  concurrency_limit_exceeded: "并发超限，请稍后再试",
  rate_limit_exceeded: "请求过于频繁，请稍后再试",
  task_not_found: "任务不存在",
  voice_not_found: "音色不存在，请重新创建后重试",
  file_not_found: "文件不存在",
  permission_error: "无权限访问，请确认 API Key 是否正确",
  authentication_error: "API Key 无效，请检查 Authorization 头",
  insufficient_credits: "余额不足，请前往控制台充值",
  url_not_allowed: "URL 不被允许（仅 HTTPS 公网）",
  invalid_url: "URL 非法",
  unsupported_response_format: "不支持的音频格式，请使用 mp3 / wav / pcm",
  invalid_field_value: "字段值不合法，请检查后重试",
  missing_required_field: "必填字段缺失，请检查后重试",
};

interface MosslandErrorBody {
  error?: {
    error_msg?: string;
    error_code?: number | string;
    internal_error_msg?: string;
    code?: string;
    param?: string | null;
    type?: string;
    message?: string;
  };
}

function errorFields(body: string): { code: string | undefined; message: string | undefined } {
  const envelope = JSON.parse(body) as MosslandErrorBody;
  if (envelope.error?.error_msg) {
    return { code: String(envelope.error.error_code ?? ""), message: envelope.error.error_msg };
  }
  return { code: envelope.error?.code, message: envelope.error?.message };
}

export function buildMosslandError(prefix: string, status: number, rawBody: string): Error {
  if (status === 413) return new Error(`${prefix}：上传的文件太大，超过了服务端限制（HTTP 413）。请压缩或截短音频后重试。`);
  let fields: ReturnType<typeof errorFields>;
  try {
    fields = errorFields(rawBody);
  } catch {
    return new Error(`${prefix}：HTTP ${status} ${rawBody.slice(0, 200)}`);
  }
  const identifier = fields.code;
  // Keep the empty-code result of &&: it is an intentionally retained wire behavior.
  const description = (identifier && ERROR_DESCRIPTIONS[identifier]) ?? fields.message ?? `未知错误 (code: ${identifier ?? "?"})`;
  const codeSuffix = identifier ? `, code: ${identifier}` : "";
  return new Error(`${prefix}：${description} (HTTP ${status}${codeSuffix})`);
}

export async function mosslandFetch(
  url: string,
  init: RequestInit & { apiKey: string; timeoutMs?: number },
): Promise<Response> {
  const { apiKey, timeoutMs = resolveTimeoutPolicy({ stage: "external-http" }).totalMs, ...request } = init;
  const expiry = new AbortController();
  const alarm = setTimeout(() => expiry.abort(), timeoutMs);
  const cancellation = request.signal ? AbortSignal.any([expiry.signal, request.signal]) : expiry.signal;
  try {
    if (cancellation.aborted) throw createAbortError();
    const response = fetch(url, {
      ...request,
      headers: { Authorization: `Bearer ${apiKey}`, ...(request.headers ?? {}) },
      signal: cancellation,
    });
    return await raceWithSignal(response, cancellation);
  } finally {
    clearTimeout(alarm);
  }
}
