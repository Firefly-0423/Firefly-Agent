/**
 * Learn 进度抽取：用一次轻量、非流式的模型调用，从刚结束的一轮对话里提取进度增量。
 *
 * 预算很小（少量消息、较低 maxTokens），优先采用结构化输出；失败只记日志并返回 null，不影响主回复。
 */

import type { ChatMessage, ChatVendorAdapter } from "../../orchestrator/vendors/types";
import type { VendorConfig } from "../../orchestrator/vendors/types";
import { extractJsonCandidates } from "../../orchestrator/structured-output/json-candidates";
import type { QuizAnswerResult } from "../../../shared/pop-quiz";
import type { LearnProgressUpdate } from "./learn-progress-types";

const SCHEMA_EXAMPLE = [
  "{",
  '  "hasMeaningfulChange": true,',
  '  "topic": "正在学习的大主题（如 "Transformer 架构"）",',
  '  "section": "当前具体章节或知识点（如 "Self-Attention"）",',
  '  "masteryDelta": 10,',
  '  "status": "learning",',
  '  "unresolvedQuestionsAdded": ["用户刚提出的未解决问题"],',
  '  "unresolvedQuestionsResolved": ["本回合已解决的问题"],',
  '  "nextStep": "建议的下一步学习方向"',
  "}",
];

const RULE_LINES = [
  "- 如果只是闲聊，没有实质学习进展，hasMeaningfulChange 设为 false",
  "- masteryDelta 范围 -100 到 100，表示知识掌握度变化",
  "- status 可选值：learning（学习中）、reviewing（复习中）、mastered（已掌握）",
  "- 不要编造信息，只提取对话中确实出现的",
  "- 若对话附带「本轮抽查实测数据」：这是已判分的确定事实，优先级高于对话推断——",
  '  答错的知识点必须体现为负向 masteryDelta 并加入 unresolvedQuestionsAdded（描述里带上"抽查答错"）；',
  '  答对的知识点可给正向 masteryDelta；简答题"待讲评"不算答对也不算答错，按讲评内容判断；',
  "  这类轮次 hasMeaningfulChange 通常应为 true",
];

const EXTRACTOR_PROMPT = [
  "你是一个学习进度追踪助手。根据以下对话，提取学习进度增量。",
  "",
  "用户和 AI 助手刚完成了一轮教学对话。你需要判断这轮对话是否带来了有实质意义的学习进展，",
  "如果是，提取相关的进度信息。",
  "",
  "返回 JSON 格式：",
  ...SCHEMA_EXAMPLE,
  "",
  "规则：",
  ...RULE_LINES,
  "",
].join("\n");

export interface ProgressExtractDeps {
  adapter: ChatVendorAdapter;
  cfg: VendorConfig;
  systemPrompt: string;
  userMessage: string;
  assistantMessage: string;
  modelId?: string;
  /** 本轮 pop_quiz 抽查的作答结果（已在本地判分），跳过的抽查不会传入。 */
  quizEvidence?: QuizAnswerResult[];
}

const STATUS_VALUES = ["learning", "reviewing", "mastered"];

/** 把抽查作答压缩成一段紧凑文本：每行一个知识点，附判分与原始作答。 */
export function formatQuizEvidence(evidence: QuizAnswerResult[]): string {
  return evidence
    .map((item) => {
      const rendered = Array.isArray(item.userAnswer) ? `[${item.userAnswer.join(",")}]` : String(item.userAnswer);
      let verdict = "简答待讲评";
      if (item.grading === "correct") {
        verdict = "答对";
      } else if (item.grading === "incorrect") {
        verdict = `答错（作答 ${rendered}）`;
      }
      return `- 知识点「${item.learningObjective}」：${verdict}`;
    })
    .join("\n");
}

/** 拼装用户侧内容：有抽查数据时附在用户消息之后。 */
function composeUserContent(deps: ProgressExtractDeps): string {
  const evidence = deps.quizEvidence;
  if (!evidence || evidence.length === 0) {
    return deps.userMessage;
  }
  return `${deps.userMessage}\n\n【本轮抽查实测数据】\n${formatQuizEvidence(evidence)}`;
}

/** 以 Node 原生 http/https 发出一次 POST 并收齐响应体。 */
function postRaw(request: { method: string; url: string; headers: Record<string, string>; body: string }): Promise<{ status: number; data: string }> {
  const httpModule = require("http") as typeof import("http");
  const httpsModule = require("https") as typeof import("https");
  const target = new URL(request.url);
  const send = target.protocol === "https:" ? httpsModule.request : httpModule.request;

  return new Promise((resolve, reject) => {
    const outgoing = send(
      {
        method: request.method,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: request.headers,
      },
      (incoming: import("http").IncomingMessage) => {
        let collected = "";
        incoming.on("data", (chunk: Buffer) => {
          collected += chunk.toString();
        });
        incoming.on("end", () => resolve({ status: incoming.statusCode ?? 500, data: collected }));
      },
    );
    outgoing.on("error", reject);
    outgoing.write(request.body);
    outgoing.end();
  });
}

/**
 * 从一轮对话中提取进度增量。任何失败都返回 null，不抛出异常。
 */
export async function extractProgress(deps: ProgressExtractDeps): Promise<LearnProgressUpdate | null> {
  try {
    const messages: ChatMessage[] = [
      { role: "system", content: `${deps.systemPrompt}\n\n${EXTRACTOR_PROMPT}` },
      { role: "user", content: composeUserContent(deps) },
      { role: "assistant", content: deps.assistantMessage },
    ];

    const built = deps.adapter.buildRequest(
      { model: deps.cfg.model, messages, maxTokens: 1024, temperature: 0.1, stream: false },
      deps.cfg,
    );

    // adapter.buildRequest 已经把 body 序列化成字符串，这里直接发送。
    const reply = await postRaw(built);
    if (reply.status !== 200) {
      console.warn(`[LearnProgress] 模型调用失败 HTTP ${reply.status}: ${reply.data.slice(0, 200)}`);
      return null;
    }

    const parsed = deps.adapter.parseResponse(JSON.parse(reply.data));
    if (!parsed.text?.trim()) {
      return null;
    }
    const direct = parsed.structuredValue;
    if (direct) {
      return validateUpdate(direct);
    }
    const [first] = extractJsonCandidates(parsed.text);
    return first ? validateUpdate(first.value) : null;
  } catch (err) {
    console.warn("[LearnProgress] 进度提取失败：", err);
    return null;
  }
}

/** 只保留字符串元素；非数组返回 undefined。 */
function stringItems(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

/** 把模型给出的任意对象规范成 LearnProgressUpdate，字段类型不符的一律视为缺省。 */
function validateUpdate(raw: unknown): LearnProgressUpdate | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const source = raw as Record<string, unknown>;
  const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  return {
    hasMeaningfulChange: source.hasMeaningfulChange === true,
    topic: text(source.topic),
    section: text(source.section),
    masteryDelta: typeof source.masteryDelta === "number" ? source.masteryDelta : undefined,
    status: STATUS_VALUES.includes(String(source.status)) ? (source.status as LearnProgressUpdate["status"]) : undefined,
    unresolvedQuestionsAdded: stringItems(source.unresolvedQuestionsAdded),
    unresolvedQuestionsResolved: stringItems(source.unresolvedQuestionsResolved),
    nextStep: text(source.nextStep),
  };
}
