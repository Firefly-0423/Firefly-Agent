export type ApiTransport = "openai" | "anthropic" | "responses";

export interface ResolvedApiEndpoint {
  url: string;
  /** 为 null 时说明地址已写全，不再补路径。 */
  appendedSuffix: string | null;
}

// 以该后缀结尾即视为完整地址
const COMPLETE_TAIL: Record<ApiTransport, string> = {
  anthropic: "/messages",
  responses: "/responses",
  openai: "/chat/completions",
};

// 未写全时需要补上的后缀
const DEFAULT_TAIL: Record<ApiTransport, string> = {
  anthropic: "/v1/messages",
  responses: "/responses",
  openai: "/chat/completions",
};

/** 设置页与主进程共用：由 Base URL 算出真正发请求的地址。 */
export function resolveApiEndpoint(baseUrl: string, transport: ApiTransport): ResolvedApiEndpoint {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (base.endsWith(COMPLETE_TAIL[transport])) {
    return { url: base, appendedSuffix: null };
  }
  // Anthropic 的地址若已带 /v1，只需补 /messages
  const suffix = transport === "anthropic" && base.endsWith("/v1") ? "/messages" : DEFAULT_TAIL[transport];
  return { url: base + suffix, appendedSuffix: suffix };
}
