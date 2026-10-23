import { assertModelSettingsReadable, loadModelSettings, resolveModelSettingsProfile } from "../settings/model-settings";

export type MemoryModelConfigSource = "inherited-main";

export type MemoryModelConfig = {
  explicitTransport?: "openai" | "anthropic" | "responses";
  apiKey: string;
  model: string;
  baseUrl: string;
  provider: string;
  source: MemoryModelConfigSource;
};

export function loadMemoryModelConfig(): MemoryModelConfig {
  assertModelSettingsReadable();
  const settings = resolveModelSettingsProfile(loadModelSettings());
  return {
    source: "inherited-main",
    provider: settings.provider.trim(),
    baseUrl: settings.baseUrl.trim(),
    model: settings.model.trim(),
    apiKey: settings.apiKey.trim(),
    explicitTransport: settings.explicitTransport,
  };
}

// 先删成对的 think 段，再删掉没有闭合的尾部段
const CLOSED_THINK = /<think>[\s\S]*?<\/think>/gi;
const UNCLOSED_THINK_TAIL = /<think>[\s\S]*$/gi;

export function stripThinkBlocks(text: string): string {
  const withoutClosed = text.replace(CLOSED_THINK, "");
  return withoutClosed.replace(UNCLOSED_THINK_TAIL, "").trim();
}
