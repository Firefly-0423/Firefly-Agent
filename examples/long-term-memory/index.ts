/**
 * long-term-memory 示例：把每个成功的桌面轮次沉淀成一句摘要，
 * 并在同一会话的后续轮次里以动态提示词带回。
 *
 * 用到的 SDK 能力：
 * - 订阅 host:turn:finished；事件是以 source 为判别字段的联合类型，
 *   判断过 "desktop" 之后才能安全读取 inputMessageId / finalMessageId
 * - 把这两个 id 原样交给 getMessages() 的 fromMessageId / throughMessageId，
 *   读取范围随之冻结，分页时不会读到后面轮次的消息
 * - manifest 声明 llm 依赖后，ctx.deps.llm 可用来生成摘要
 * - registerPromptProvider 只放事实性的短内容，不写指令
 */
import type { FireflyPlugin, PluginConversationMessage, PluginDeps, PluginTool, PluginPromptProvider, PluginTurnFinishedEvent } from "@firefly/plugin-sdk";

const KEEP_PER_CONVERSATION = 5;
const INJECTED_PER_PROMPT = 3;
const TRANSCRIPT_CHAR_LIMIT = 4000;
const FALLBACK_CHAR_LIMIT = 50;

let deps: PluginDeps = {};
/** 会话 id 到摘要列表，数组末尾是最新的一条。 */
let notebook = new Map<string, string[]>();

/** 摘要入账：超出保留数量时从最旧的一条开始丢弃。 */
function appendNote(conversationId: string, note: string): void {
  const notes = notebook.get(conversationId) ?? [];
  notes.push(note);
  notebook.set(conversationId, notes.slice(-KEEP_PER_CONVERSATION));
}

function renderTranscript(messages: PluginConversationMessage[]): string {
  const lines = messages.map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.text}`);
  return lines.join("\n").slice(0, TRANSCRIPT_CHAR_LIMIT);
}

/** 没有可用 LLM 时的替代摘要：取首条用户消息的开头。 */
function truncatedFallback(messages: PluginConversationMessage[]): string | null {
  const opening = messages.find((m) => m.role === "user");
  if (!opening) return null;
  return `（未摘要）${opening.text.slice(0, FALLBACK_CHAR_LIMIT)}`;
}

async function summarizeTurn(messages: PluginConversationMessage[]): Promise<string | null> {
  if (!messages.length) return null;
  try {
    return await deps.llm!.generateText(
      [
        { role: "system", content: "用一句不超过 50 字的中文总结这轮对话的关键事实或决定。" },
        { role: "user", content: renderTranscript(messages) },
      ],
      { maxTokens: 128, purpose: "summarize-turn" },
    );
  } catch {
    return truncatedFallback(messages);
  }
}

/** 单个会话的摘要查询；没有记录时给出固定提示。 */
function describeConversation(conversationId: string): string {
  const notes = notebook.get(conversationId);
  if (!notes?.length) return "该会话暂无记忆";
  return notes.map((note, i) => `${i + 1}. ${note}`).join("\n");
}

/** 全部会话的条数统计。 */
function describeAll(): string {
  if (notebook.size === 0) return "暂无任何记忆";
  return Array.from(notebook, ([id, notes]) => `${id}: ${notes.length} 条`).join("\n");
}

/** 只读工具的统一外壳：风险级固定为 safe，effectKind 固定为 read。 */
function readOnlyTool(
  id: string,
  name: string,
  description: string,
  properties: PluginTool["inputSchema"]["properties"],
  execute: PluginTool["execute"],
): PluginTool {
  return {
    id,
    name,
    description,
    inputSchema: { type: "object", properties },
    execute,
    effectKind: "read",
    risk: "safe",
    enabled: true,
  };
}

const recallTool = readOnlyTool(
  "long-term-memory_recall",
  "回忆最近对话",
  "查看指定会话的最近记忆摘要。参数 conversationId 为会话 id；省略时查看所有会话的记忆条数。",
  { conversationId: { type: "string", description: "会话 id，省略时返回全部会话的记忆统计" } },
  async (args) => {
    const target = String(args.conversationId ?? "");
    return target ? describeConversation(target) : describeAll();
  },
);

/** 桌面轮次成功结束后：按冻结范围取回本轮消息，摘要并入账。 */
async function onTurnFinished(event: PluginTurnFinishedEvent): Promise<void> {
  if (event.source !== "desktop" || event.status !== "success") return;
  if (!deps.conversations || !event.inputMessageId) return;

  const { items } = await deps.conversations.getMessages({
    limit: 50,
    throughMessageId: event.finalMessageId,
    fromMessageId: event.inputMessageId,
    conversationId: event.conversationId,
  });
  const note = await summarizeTurn(items);
  if (note) appendNote(event.conversationId, note);
}

/** 动态提示词：只带回事实性的最近摘要，不夹带指令。 */
const recentMemoryProvider: PluginPromptProvider = {
  id: "recent-memories",
  provide(input) {
    if (input.source !== "conversation") return "";
    const notes = notebook.get(input.conversationId ?? "") ?? [];
    if (!notes.length) return "";
    const bullets = notes.slice(-INJECTED_PER_PROMPT).map((note) => `- ${note}`);
    return `[长期记忆] 该会话最近摘要:\n${bullets.join("\n")}`;
  },
};

const plugin: FireflyPlugin = {
  async register(ctx) {
    deps = ctx.deps;

    // 启动时读回上次落盘的摘要，停止时再写回
    notebook = ctx.storage.get<Map<string, string[]>>("memories") ?? new Map();
    ctx.onDispose(() => {
      ctx.storage.set("memories", notebook);
    });

    ctx.events.on("host:turn:finished", onTurnFinished);

    ctx.registerPromptProvider(recentMemoryProvider);

    ctx.registerTool(recallTool);
  },
  unregister() {
    notebook = new Map();
  },
};

export = plugin;
