import type { ChatVendorAdapter, ChatMessage, ChatRequest, OpenAIContentBlock } from "./vendors/types";
import type { AgentLoopSettings, AgentLoopEvent } from "./firefly-agent";
import { recordRequest, recordUsage } from "../storage/token-usage-store";
import { DEFAULT_CONTEXT_WINDOW_TOKENS, autoCompactTriggerTokens } from "../../shared/context-window";

const summaryInstruction = [
  "你正在帮\"流萤\"整理对话记忆。请把下面这段较早的对话历史总结成一段简洁的摘要，供后续回复参考。",
  "",
  "要求：",
  "1. 保留用户的核心目标、当前任务、未完成的待办事项。",
  "2. 保留用户明确表达过的偏好、禁忌、格式要求。",
  "3. 保留已确认的事实和数据（如路径、文件名、参数值）。",
  "4. 删除具体的寒暄、重复确认、过渡性语句。",
  "5. 如果对话中包含代码/命令，只保留最终生效的版本和用途说明，不保留中间试错。",
  "6. 摘要控制在 400~600 字以内，用中文输出。",
  "",
  "对话历史：",
  "{history}",
  "",
  "请直接输出摘要内容，不要加任何前缀说明。",
].join("\n");
export const DEFAULT_IMAGE_TOKEN_ESTIMATE = 4096;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const counts = { wide: 0, narrow: 0 };
  for (const character of text) {
    if (character.charCodeAt(0) > 127) counts.wide += 1;
    else counts.narrow += 1;
  }
  return Math.ceil(counts.wide / 1.5 + counts.narrow / 4);
}

export function estimateMessageContentTokens(content: string | OpenAIContentBlock[]): number {
  if (typeof content === "string") return estimateTokens(content);
  let tokens = 0;
  for (const piece of content) tokens += piece.type === "text" ? estimateTokens(piece.text) : DEFAULT_IMAGE_TOKEN_ESTIMATE;
  return tokens;
}

export function estimateMessageTokens(messages: ChatMessage[]): number {
  return messages.reduce((tokens, message) => tokens + estimateMessageContentTokens(message.content ?? "") + 4, 0);
}

function renderHistory(history: ChatMessage[]): string {
  return history.map((message) => {
    let speaker: string = message.role;
    if (message.role === "user") speaker = "用户";
    else if (message.role === "assistant") speaker = "流萤";
    const body = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    return `--- ${speaker} ---\n${body}`;
  }).join("\n\n");
}

export interface CompressOptions {
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
  mode?: string;
  systemContent: string;
  settings: AgentLoopSettings;
  adapter: ChatVendorAdapter;
  messages: ChatMessage[];
}

export async function compressConversation(options: CompressOptions): Promise<ChatMessage[]> {
  const { messages: history, adapter: vendor, settings: config, systemContent: prefix, mode = "work", onEvent: notify, signal: cancellation } = options;
  const windowSize = config.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  const trigger = autoCompactTriggerTokens(windowSize);
  const systemMessages: ChatMessage[] = [];
  const turns: ChatMessage[] = [];
  for (const message of history) (message.role === "system" ? systemMessages : turns).push(message);
  const retained = (mode === "chat" ? 20 : 6) * 2;
  if (turns.length <= retained) return history;
  const prefixCost = estimateTokens(prefix) + estimateMessageTokens(systemMessages);
  const historyCost = estimateMessageTokens(turns);
  if (prefixCost + historyCost < trigger) return history;
  const earlier = turns.slice(0, -retained);
  const tail = turns.slice(-retained);
  notify?.({ type: "compressing_context" });
  try {
    const digest = await callSummarizeModel(earlier, vendor, config, cancellation);
    const checkpoint: ChatMessage = { role: "assistant", content: `[此前对话已压缩为记忆摘要]\n${digest}` };
    return [...systemMessages, checkpoint, ...tail];
  } catch (failure) {
    console.warn("[ContextManager] 模型压缩失败，回退到截断:", failure);
    return [...systemMessages, ...tail];
  }
}

export async function callSummarizeModel(messages: ChatMessage[], adapter: ChatVendorAdapter, settings: AgentLoopSettings, signal?: AbortSignal): Promise<string> {
  const instruction = summaryInstruction.replace("{history}", renderHistory(messages));
  const envelope: ChatRequest = {
    model: settings.model,
    messages: [{ role: "system", content: instruction }, { role: "user", content: "请总结上面的对话历史。" }],
    stream: false,
  };
  const vendor = {
    provider: settings.provider, baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey,
    explicitTransport: settings.explicitTransport, reasoning: settings.reasoning,
  };
  const hinted = adapter.applyCacheHints?.(envelope, vendor) ?? envelope;
  const transport = adapter.buildRequest(hinted, settings);
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const reply = await fetch(transport.url, { method: "POST", headers: transport.headers, body: transport.body, signal: cancellation.signal });
    if (!reply.ok) {
      const detail = await reply.text().catch(() => "");
      throw new Error(`压缩请求失败：HTTP ${reply.status}${detail ? ` - ${detail.slice(0, 200)}` : ""}`);
    }
    const completion = adapter.parseResponse(await reply.json());
    recordRequest(settings.model);
    if (completion.usage) {
      const usage = completion.usage;
      recordUsage(usage.input, usage.output, 1, usage.cachedInput, settings.model, usage.cacheCreation);
    }
    return completion.text.trim() || "[压缩结果为空]";
  } finally { signal?.removeEventListener("abort", cancel); }
}
