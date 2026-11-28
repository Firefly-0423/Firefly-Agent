import { ProviderCapability } from "./types";

export const PROVIDER_CAPABILITIES = [
  {
    id: "minimax", displayName: "MiniMax（稀宇科技）", transport: "anthropic",
    baseUrl: "https://api.minimaxi.com/anthropic", authStyle: "bearer", anthropicAuthStyle: "x-api-key",
    defaultModel: "MiniMax-M3", supportsTools: true, supportsThinking: true,
    thinkingField: "thinking", cacheStrategy: "cache_control", testStrategy: "text",
    visionBaseUrl: "https://api.minimaxi.com/v1", supportedTransports: ["anthropic", "openai", "responses"],
  },
  {
    id: "deepseek", displayName: "DeepSeek（深度求索）", transport: "openai",
    baseUrl: "https://api.deepseek.com", authStyle: "bearer", anthropicAuthStyle: "x-api-key",
    defaultModel: "deepseek-flash", supportsTools: true, supportsThinking: true,
    thinkingField: "reasoning_content", cacheStrategy: "auto", testStrategy: "text",
    supportedTransports: ["openai", "anthropic", "responses"],
  },
  {
    id: "glm", displayName: "GLM（智谱）", transport: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4", authStyle: "bearer",
    defaultModel: "glm-5.2", supportsTools: true, supportsThinking: true,
    thinkingField: "reasoning_content", cacheStrategy: "auto", testStrategy: "text",
    supportedTransports: ["openai", "anthropic"],
  },
  {
    id: "kimi", displayName: "Kimi（月之暗面）", transport: "openai",
    baseUrl: "https://api.moonshot.cn/v1", authStyle: "bearer", defaultModel: "kimi-k2.7-code",
    supportsTools: true, supportsThinking: true, thinkingField: "thinking",
    cacheStrategy: "prompt_cache_key", testStrategy: "text", supportedTransports: ["openai"],
  },
  {
    id: "qwen", displayName: "Qwen（通义千问）", transport: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", authStyle: "bearer", defaultModel: "qwen-max",
    supportsTools: true, supportsThinking: true, thinkingField: "reasoning_content",
    cacheStrategy: "auto", testStrategy: "text", supportedTransports: ["openai", "responses"],
  },
  {
    id: "chatgpt", displayName: "ChatGPT（OpenAI）", transport: "responses",
    baseUrl: "https://api.openai.com/v1", authStyle: "bearer", defaultModel: "",
    supportsTools: true, supportsThinking: true, thinkingField: "reasoning_content",
    cacheStrategy: "auto", testStrategy: "text", supportedTransports: ["openai", "responses"],
    responsesEncryptedReasoning: true,
  },
  {
    id: "claude", displayName: "Claude（Anthropic）", transport: "anthropic",
    baseUrl: "https://api.anthropic.com/v1", authStyle: "x-api-key", defaultModel: "claude-sonnet-4-6",
    supportsTools: true, supportsThinking: true, thinkingField: "thinking",
    cacheStrategy: "cache_control", testStrategy: "text", supportedTransports: ["anthropic"],
  },
  {
    id: "mimo", displayName: "MiMo（小米）", transport: "openai",
    baseUrl: "https://api.xiaomimimo.com/v1", authStyle: "bearer", defaultModel: "mimo-v2.5-pro",
    supportsTools: true, supportsThinking: true, thinkingField: "reasoning_content",
    cacheStrategy: "auto", testStrategy: "text", visionBaseUrl: "https://api.xiaomimimo.com/v1",
    supportedTransports: ["openai", "anthropic", "responses"],
  },
  {
    id: "openrouter", displayName: "OpenRouter", transport: "openai",
    baseUrl: "https://openrouter.ai/api/v1", authStyle: "bearer", defaultModel: "",
    supportsTools: true, supportsThinking: true, thinkingField: "reasoning_details",
    cacheStrategy: "auto", testStrategy: "text", supportedTransports: ["openai"],
  },
] satisfies readonly ProviderCapability[];

const providerNames = new Map(PROVIDER_CAPABILITIES.map((entry) => [entry.displayName, entry]));
export function getCapability(provider: string): ProviderCapability | undefined {
  return providerNames.get(provider);
}
export function getCapabilityOrOpenAI(provider: string): ProviderCapability {
  const registered = providerNames.get(provider);
  if (registered) return registered;
  return {
    id: "unknown", displayName: provider, transport: "openai", baseUrl: "", authStyle: "bearer",
    defaultModel: "", supportsTools: true, supportsThinking: false, thinkingField: null,
    cacheStrategy: "none", testStrategy: "text",
  };
}
