import type { PluginLlmGenerateOptions, PluginLlmMessage } from "../../plugins/api";
import type { LlmClient } from "../services/llm/llm-client";
import type { ModelSettings } from "../settings/model-settings";
import { runWithUsageAttribution } from "../usage-attribution";

export type EnqueuePluginLlmTask = <T>(label: string, task: () => Promise<T>,
  options?: { log?: boolean; retryRateLimit?: boolean }) => Promise<T>;

// Undefined selects the caller's default; invalid explicit limits must fail.
function requestLimit(candidate: number | undefined, defaultValue: number, lower: number, upper: number, name: string): number {
  if (candidate === undefined) return defaultValue;
  if (!Number.isInteger(candidate) || candidate < lower || candidate > upper) {
    throw new Error(`${name} 必须是 ${lower}-${upper} 的整数`);
  }
  return candidate;
}

function taskPurpose(purpose: string | undefined): string {
  const safe = purpose?.trim().replace(/[^a-zA-Z0-9._:-]+/g, "-");
  return safe?.slice(0, 80) || "unknown";
}

export async function pluginGenerateText(
  messages: PluginLlmMessage[], settings: ModelSettings, llmClient: LlmClient,
  enqueueTask: EnqueuePluginLlmTask, options: PluginLlmGenerateOptions = {},
): Promise<string> {
  if (!settings.apiKey.trim()) throw new Error("未配置 API Key，请先在设置页配置主聊天模型");
  if (!settings.model.trim()) throw new Error("未配置主聊天模型名称");
  if (!Array.isArray(messages) || messages.length === 0) throw new Error("插件模型请求至少需要一条消息");
  const outputBudget = requestLimit(options.maxTokens, 1024, 1, 8192, "maxTokens");
  const defaultWait = Math.min(Math.max(settings.chatRequestTimeoutSec * 1000, 1000), 120_000);
  const waitBudget = requestLimit(options.timeoutMs, defaultWait, 1000, 300_000, "timeoutMs");
  const taskLabel = `plugin:${taskPurpose(options.purpose)}`;
  const generate = async (): Promise<string> => {
    const response = await runWithUsageAttribution({ feature: "plugin" }, () => llmClient.chatNonStream(
      settings, messages, undefined, waitBudget, taskLabel, undefined,
      { maxTokens: outputBudget }, options.signal,
    ));
    const answer = response.text?.trim();
    if (!answer) throw new Error("主聊天模型没有返回文本");
    return answer;
  };
  return enqueueTask(taskLabel, generate, { retryRateLimit: true });
}