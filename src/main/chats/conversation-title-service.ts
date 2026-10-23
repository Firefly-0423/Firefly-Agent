import type { ChatSession } from "../../shared/chat-types";
import type { ModelSettings } from "../settings/model-settings";
import type { LlmClient } from "../services/llm/llm-client";

const DELAY_BEFORE_TITLE_MS = 3_000;
const TITLE_TIMEOUT_MS = 15_000;
const TITLE_MAX_TOKENS = 32;
const SYSTEM_INSTRUCTION = "你是一个标题生成器，根据下面的文字生成一个5-8个字的标题。只输出标题，不要解释，不要添加引号。";

// 依次清理模型常见的包装：标题前缀、强调符号、引号括号、结尾标点和空白
const CLEANUP_STEPS: Array<[RegExp, string]> = [
  [/^#{1,6}\s*/, ""],
  [/^(?:会话)?标题\s*[:：]\s*/, ""],
  [/^(?:\*\*|__|`)+|(?:\*\*|__|`)+$/g, ""],
  [/^[“”"'「」『』《》【】（）()\[\]]+|[“”"'「」『』《》【】（）()\[\]]+$/g, ""],
  [/[。！？!?，,；;：:]+$/g, ""],
  [/\s+/g, ""],
];

export function normalizeGeneratedTitle(raw: string): string | null {
  const head = (raw.split(/\r?\n/).find((line) => line.trim()) ?? "").trim();
  const cleaned = CLEANUP_STEPS.reduce((text, [pattern, to]) => text.replace(pattern, to), head).trim();
  const size = [...cleaned].length;
  if (size < 5 || size > 8) return null;
  return cleaned;
}

export interface ConversationTitleService {
  schedule(input: { sessionId: string; userMessageId: string; text: string }): boolean;
}

export interface ConversationTitleServiceDependencies {
  onTitleChanged(sessionId: string): void;
  enqueueTask<T>(label: string, task: () => Promise<T>): Promise<T>;
  llmClient: Pick<LlmClient, "chatNonStream">;
  isPrimaryModelBusy?(): boolean;
  resolveSettings(session: ChatSession): ModelSettings;
  setGeneratedTitle(sessionId: string, userMessageId: string, title: string): boolean;
  getSession(sessionId: string): ChatSession | null;
}

type TitleRequest = { sessionId: string; userMessageId: string; text: string };

export function createConversationTitleService(
  deps: ConversationTitleServiceDependencies,
): ConversationTitleService {
  const seen = new Set<string>();

  const generate = async (req: TitleRequest): Promise<void> => {
    const latest = deps.getSession(req.sessionId);
    if (!latest || latest.titleIsCustom) return;
    const settings = deps.resolveSettings(latest);
    if (!settings.baseUrl || !settings.model) return;

    const reply = await deps.llmClient.chatNonStream(
      settings,
      [
        { role: "system", content: SYSTEM_INSTRUCTION },
        { role: "user", content: req.text.trim() },
      ],
      undefined,
      TITLE_TIMEOUT_MS,
      "ConversationTitle",
      { mode: "off" },
      { maxTokens: TITLE_MAX_TOKENS },
    );
    const title = normalizeGeneratedTitle(reply.text);
    if (!title) return;
    if (deps.setGeneratedTitle(req.sessionId, req.userMessageId, title)) {
      deps.onTitleChanged(req.sessionId);
    }
  };

  // 主模型忙时继续顺延，空闲后才把任务放入队列
  const runWhenIdle = (req: TitleRequest): void => {
    if (!deps.getSession(req.sessionId)) return;
    if (deps.isPrimaryModelBusy?.()) {
      setTimeout(() => runWhenIdle(req), DELAY_BEFORE_TITLE_MS);
      return;
    }
    deps
      .enqueueTask(`会话标题:${req.sessionId}`, () => generate(req))
      .catch((error) => {
        console.warn("[ConversationTitle] 标题生成失败，保留临时标题:", error);
      });
  };

  return {
    schedule(input) {
      if (seen.has(input.sessionId)) return false;
      const session = deps.getSession(input.sessionId);
      if (!session || session.titleIsCustom || !input.text.trim()) return false;
      const opener = session.messages.find((m) => m.role === "user" && m.content.trim());
      if (opener?.id !== input.userMessageId) return false;

      seen.add(input.sessionId);
      setTimeout(() => runWhenIdle(input), DELAY_BEFORE_TITLE_MS);
      return true;
    },
  };
}
