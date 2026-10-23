import { estimateMessageTokens, estimateTokens } from "../context-manager";
import { autoCompactTriggerTokens, AUTO_COMPACT_THRESHOLD } from "../../../shared/context-window";
import type { ChatMessage } from "../vendors/types";

export interface TokenBudget {
  needsCompaction: boolean;
  estimatedInput: number;
  usableInputBudget: number;
}

export function computeTokenBudget(
  system: string,
  schemas: Array<{ name: string; description: string; parameters: object }>,
  transcript: ChatMessage[],
  windowSize: number,
  outputReserve: number,
  margin: number,
  threshold = AUTO_COMPACT_THRESHOLD,
): TokenBudget {
  const prefixCost = estimateTokens(system);
  const definitionsCost = schemas.reduce((total, definition) => {
    return total + estimateTokens(definition.name + definition.description + JSON.stringify(definition.parameters));
  }, 0);
  const historyCost = estimateMessageTokens(transcript);
  const capacity = windowSize - outputReserve - margin;
  const consumed = prefixCost + definitionsCost + historyCost;
  return {
    usableInputBudget: capacity,
    estimatedInput: consumed,
    needsCompaction: consumed >= autoCompactTriggerTokens(windowSize, {
      reservedOutputTokens: outputReserve,
      safetyMarginTokens: margin,
      threshold,
    }),
  };
}

export function findSafeCutPoint(history: ChatMessage[], recentCount: number): number {
  if (history.length <= recentCount) return 0;
  let boundary = history.length - recentCount;
  for (; boundary > 0; boundary--) {
    const candidate = history[boundary];
    if (candidate.role === "user") return boundary;
    if (candidate.role === "assistant" && (!candidate.toolCalls || candidate.toolCalls.length === 0)) return boundary;
    if (candidate.role === "system") return boundary;
  }
  return boundary;
}

export function isToolPairSafeBoundary(history: ChatMessage[], boundary: number): boolean {
  const declarations = new Map<string, number>();
  for (let position = 0; position < history.length; position++) {
    const candidate = history[position];
    if (candidate?.role === "assistant") {
      for (const invocation of candidate.toolCalls ?? []) declarations.set(invocation.id, position);
    }
  }
  for (let position = 0; position < history.length; position++) {
    const candidate = history[position];
    if (candidate?.role === "tool" && candidate.toolCallId) {
      const declaration = declarations.get(candidate.toolCallId);
      if (declaration !== undefined && declaration < boundary && position >= boundary) return false;
    }
  }
  return true;
}

export function findSafeCutPointForRetainedTokens(history: ChatMessage[], retainedBudget: number): number {
  if (history.length === 0 || retainedBudget <= 0) return 0;
  let boundary = history.length;
  let cost = 0;
  for (; boundary > 0 && cost < retainedBudget;) {
    boundary--;
    cost += estimateMessageTokens([history[boundary]!]);
  }
  for (; boundary > 0 && !isToolPairSafeBoundary(history, boundary); boundary--) {
    // 回退到工具结果与声明的同一侧。
  }
  return boundary;
}

export const AGENT_COMPACTION_PROMPT = "你正在为 FireflyHarness 生成可恢复的执行历史检查点。请将上方较早的对话历史压缩为以下固定 Markdown 结构；每个标题都必须保留，没有内容时写“无”。\n\n## 原始任务与意图\n## 已确认事实\n## 文件与改动\n## 工具结果与引用\n## Todo 与未完成事项\n## 不确定副作用\n## 当前进度\n## 下一步\n\n规则：\n1. 保留用户目标、明确约束、精确路径、命令、错误、标识符、数值和已经确认的结论。\n2. 工具结果只写必要事实；若消息里已有 tool-result:// 引用，保留该引用，不要编造完整输出。\n3. 合并先前的检查点，只保留仍然有效的事实，删除模型自言自语与重复过渡语。\n4. 使用简洁中文项目符号；不要调用工具，不要解释你正在生成摘要。\n5. 摘要必须明显短于被压缩的历史。";

const checkpointTags = ["<firefly_compaction_checkpoint>", "</firefly_compaction_checkpoint>"] as const;

export function isCompactionCheckpointMessage(candidate: Pick<ChatMessage, "role" | "content">): boolean {
  return candidate.role === "system" && typeof candidate.content === "string"
    && candidate.content.includes(checkpointTags[0]);
}

export function buildCompactionCheckpoint(abstract: string): ChatMessage {
  return { role: "system", content: [checkpointTags[0], abstract.trim(), checkpointTags[1]].join("\n") };
}

export interface CompactionOptions {
  summarize: (history: ChatMessage[]) => Promise<string>;
  retainTokens: number;
  messages: ChatMessage[];
}

export async function compressForAgentLoop(request: CompactionOptions): Promise<ChatMessage[]> {
  const { messages: history, retainTokens: retainedBudget, summarize: makeSummary } = request;
  const boundary = findSafeCutPointForRetainedTokens(history, retainedBudget);
  if (boundary === 0) return history;
  const earlier = history.slice(0, boundary);
  const recent = history.slice(boundary);
  try {
    const abstract = await makeSummary(earlier);
    if (!abstract.trim()) return history;
    const checkpoint = buildCompactionCheckpoint(abstract);
    if (estimateMessageTokens([checkpoint]) >= estimateMessageTokens(earlier)) return history;
    return [checkpoint, ...recent];
  } catch {
    return history;
  }
}
