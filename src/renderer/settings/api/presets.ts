import type { ModelPreset } from "../shared/types";
import { CUSTOM_ENDPOINT_PROVIDERS } from "../custom-endpoint-state";

export function sortPresetsForDisplay(presets: readonly ModelPreset[]): ModelPreset[] {
  const ordered = Array.from(presets);
  ordered.sort((left, right) => left.shortName.localeCompare(right.shortName, "en", { sensitivity: "base" }));
  return ordered;
}

// 可选协议地址先于 transport 写入，保持预设字段顺序。
function vendor(
  providerName: string, shortName: string, baseUrl: string,
  transport: ModelPreset["transport"], mainModels: string[],
  iconName: string, websiteUrl: string, anthropicEndpoint?: { anthropicBaseUrl: string },
): ModelPreset {
  const identity = { providerName, shortName, baseUrl };
  return {
    ...identity, ...(anthropicEndpoint ?? {}),
    transport, mainModels, iconUrl: `../icons/providers/${iconName}.svg`, websiteUrl,
  };
}

function customPreset(mode: "cloud" | "local"): ModelPreset {
  const local = mode === "local";
  return {
    providerName: CUSTOM_ENDPOINT_PROVIDERS[mode], shortName: local ? "本地模型" : "自定义",
    baseUrl: "", transport: "openai", mainModels: [],
    iconUrl: "../icons/providers/custom-endpoint.svg", customEndpointMode: mode,
    ...(local ? { hiddenInPresetList: true } : {}),
  };
}

// 新建档案仍默认选择第一家常规厂商。
export const MODEL_PRESETS: ModelPreset[] = [
  vendor("MiniMax（稀宇科技）", "MiniMax", "https://api.minimaxi.com/v1", "anthropic",
    ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.5"], "minimax", "https://platform.minimaxi.com/", { anthropicBaseUrl: "https://api.minimaxi.com/anthropic" }),
  vendor("DeepSeek（深度求索）", "DeepSeek", "https://api.deepseek.com", "openai",
    ["deepseek-flash", "deepseek-v4-pro"], "deepseek", "https://platform.deepseek.com/", { anthropicBaseUrl: "https://api.deepseek.com/anthropic" }),
  vendor("GLM（智谱）", "GLM", "https://open.bigmodel.cn/api/paas/v4", "openai",
    ["glm-5.3", "glm-5.2", "glm-5.1", "glm-5-turbo", "glm-4.7"], "glm", "https://open.bigmodel.cn/", { anthropicBaseUrl: "https://open.bigmodel.cn/api/anthropic" }),
  vendor("Kimi（月之暗面）", "Kimi", "https://api.moonshot.cn/v1", "openai",
    ["kimi-k2.6", "kimi-k2.5", "kimi-k2-thinking"], "kimi", "https://platform.moonshot.cn/"),
  vendor("Qwen（通义千问）", "Qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1", "openai",
    ["qwen-max", "qwen-plus", "qwen-turbo"], "qwen", "https://bailian.console.aliyun.com/"),
  vendor("ChatGPT（OpenAI）", "ChatGPT", "https://api.openai.com/v1", "responses",
    ["gpt-6-astra", "gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"], "openai", "https://platform.openai.com/"),
  vendor("Claude（Anthropic）", "Claude", "https://api.anthropic.com/v1", "anthropic",
    ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6"], "claude", "https://console.anthropic.com/"),
  vendor("MiMo（小米）", "MiMo", "https://api.xiaomimimo.com/v1", "openai",
    ["mimo-v2.5-pro"], "xiaomimimo", "https://mimo.mi.com/", { anthropicBaseUrl: "https://api.xiaomimimo.com/anthropic" }),
  vendor("OpenRouter", "OpenRouter", "https://openrouter.ai/api/v1", "openai",
    [], "openrouter", "https://openrouter.ai/"),
  customPreset("cloud"), customPreset("local"),
];
