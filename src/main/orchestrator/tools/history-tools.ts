import { addMemory, isUserMemoryVectorStoreReady, searchHistoryEntries } from "../../rag";
import { toolRegistry } from "./registry/tool-registry";
import { currentUserTimezone } from "./built-in-tools";
import { getDateLocale } from "../../startup/locale-context";

const historyLog = "[History]";
export async function indexConversationTurn(
  sessionId: string, userText: string, assistantText: string,
  options: { personalMemoryMode?: "legacy" | "smh" } = {},
): Promise<{ status: "complete" | "partial" | "unavailable" | "failed" | "retired"; indexed: number; code?: "MEMORY_LEGACY_RETIRED" }> {
  if (options.personalMemoryMode === "smh") return { status: "retired", indexed: 0, code: "MEMORY_LEGACY_RETIRED" };
  if (!isUserMemoryVectorStoreReady()) {
    console.warn(historyLog, "对话向量索引未就绪；原始对话已保留，请检查 BGE-M3 模型状态");
    return { status: "unavailable", indexed: 0 };
  }
  const timestamp = Date.now();
  let stored = 0;
  try {
    for (const entry of [{ text: userText, role: "user" }, { text: assistantText, role: "assistant" }]) {
      if (!entry.text) continue;
      await addMemory(entry.text, "chat_history", { sessionId, role: entry.role, ts: timestamp });
      stored += 1;
    }
    return { status: "complete", indexed: stored };
  } catch (failure) {
    console.warn(historyLog, "对话向量索引失败；原始对话已保留", failure instanceof Error ? failure.name : "unknown");
    return { status: stored > 0 ? "partial" : "failed", indexed: stored };
  }
}

export function registerRecallHistoryTool(options: { personalMemoryMode?: "legacy" | "smh" } = {}): void {
  const HANDLER_recall_history = async (args: Record<string, unknown>): Promise<string> => {
    if (options.personalMemoryMode === "smh") return "MEMORY_LEGACY_RETIRED";
    if (!isUserMemoryVectorStoreReady()) return "[recall_history] 向量检索未就绪，请在设置中检查 BGE-M3 模型状态；未执行检索。";
    const phrase = String(args.query || "").trim();
    if (!phrase) return "[错误] query 不能为空";
    const lookback = Number(args.days) || 30;
    const earliest = Date.now() - lookback * 24 * 60 * 60 * 1000;
    let matches: Awaited<ReturnType<typeof searchHistoryEntries>>;
    try { matches = await searchHistoryEntries(phrase, 5); }
    catch (failure) { return "[recall_history] 检索失败：" + (failure instanceof Error ? failure.message : String(failure)); }
    const selected = matches.filter(item => item.createdAt >= earliest);
    if (selected.length === 0) return `[recall_history] 没有找到关于 "${phrase}" 的历史记录`;
    const chronological = [...selected].sort((left, right) => left.createdAt - right.createdAt);
    const excerpts = chronological.map(item => {
      const stamp = new Date(item.createdAt).toLocaleString(getDateLocale(), { timeZone: currentUserTimezone() });
      const speaker = item.metadata?.role === "user" ? "用户" : "流萤";
      const excerpt = item.text.length > 300 ? item.text.slice(0, 300) + "..." : item.text;
      return `[${stamp}] ${speaker}：${excerpt}`;
    });
    return `[recall_history] 找到 ${chronological.length} 条相关历史：\n\n${excerpts.join("\n\n")}`;
  };
  toolRegistry.register({
  "id": "recall_history",
  "name": "回忆历史",
  "description": "从所有历史对话中语义检索相关内容。返回按时间排序的相关片段（最多 5 条），每条带角色和时间戳。\n\n何时用：\n- 用户说「还记得」「上次」「之前」「那个」「前几天」等指代词\n- 用户问的事在最近几轮对话里找不到答案\n- 用户接续之前的话题但当前上下文没有细节\n\n不要用于：\n- 当前对话最近几轮里能直接看到的信息\n- 完全无关的闲聊\n- 用户从没提过的事（查不到就老实说不知道）\n\n参数：query（必填，检索关键词或自然语言问题），days（可选，限制最近 N 天，默认 30）。",
  "enabled": true,
  "risk": "safe",
  "effectKind": "read",
  "verificationPolicy": "none",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "检索关键词或自然语言问题"
      },
      "days": {
        "type": "number",
        "description": "可选，限制最近 N 天，默认 30"
      }
    },
    "required": [
      "query"
    ]
  }
, execute: HANDLER_recall_history });
}
