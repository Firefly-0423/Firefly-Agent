// 主动轮的提示词拼装与模型输出解析。
// 所有"本地时间"都按调用方给出的有效时区解释，不读取机器时区。
import { getZonedDateParts, isWithinQuietHours, minuteOfDay } from "./proactive-clock";
import type { ChatMessage } from "../orchestrator/vendors/types";

export type ProactiveHistoryTurn = {
  at: number;
  role: "user" | "model";
  content: string;
};

export type BuildProactiveMessagesInput = {
  sceneId: string;
  localNow: Date;
  idleSec: number;
  basePersona: string;
  unansweredCount: 0 | 1 | 2;
  ordinaryHistory: ProactiveHistoryTurn[];
  proactiveHistory: ProactiveHistoryTurn[];
  userProfile?: string;
  relevantMemory?: string;
  /**
   * 经 resolver 校验后的用户时区（IANA 字符串）。
   * 早晚判断、历史行与触发行的本地时间都以它为准；
   * 调用方须先走 resolveChatContextTimezone，不能直接传 profile.timezone。
   */
  timezone: string;
};

export type ProactiveModelDecision =
  | { kind: "send"; text: string }
  | { kind: "silent" }
  | { kind: "invalid"; reason: string };

const HISTORY_WINDOW = 16;
const TEXT_CEILING = 500;

// 提示词按行拼接，内容与逐字版本一致。
const SYSTEM_BLOCK = [
  "[proactive_system]",
  "你正在判断是否要主动向用户发起一次对话，而不是回答用户的新消息。",
  "不要把历史聊天中的最后一句当作用户刚刚发来的消息；历史只用于理解用户最近的状态和话题。",
  "如果没有自然且值得说的内容，请返回 silent。不要为了完成任务而强行寒暄。",
  "不要提及系统检测、触发规则、评分、上下文、用户画像或内部状态。",
  "消息应当简短自然，可以关心、分享、跟进或轻轻询问，但不要连续提出多个问题。",
  "不要声称自己调用了工具、读取了屏幕或执行了任何外部动作。",
].join("\n");

const NIGHT_BLOCK = [
  "[night_system]",
  "当前处于深夜，用户仍在使用电脑。",
  "生成内容时可以更倾向于温柔关心用户的休息状态，适度提醒不要熬得太晚，但不要说教、催促或制造压力。",
  "不要每次都提睡觉；如果上下文中有更自然、更重要的话题，可以先回应那个话题，再轻轻带到休息。",
  "不要透露你检测到了用户的键盘、鼠标、屏幕或系统状态。",
  "如果此刻没有值得主动说的话，请选择保持安静。",
].join("\n");

const FOLLOWUP_BLOCK = [
  "[followup_system]",
  "这是用户未回复情况下允许的最后一次主动机会。",
  "本地系统已经确认用户在离开后再次返回，但你仍应判断这次新的返回是否值得打扰用户。",
  `不要责怪、催促、卖惨或表现出被冷落，也不要机械地重复"在吗"。`,
  "没有充分理由时必须返回 silent。",
].join("\n");

const REQUEST_TAIL = [
  "请只返回以下一种 JSON，不要使用 Markdown 代码块，也不要添加解释：",
  `{"decision":"send","text":"要发送的一条自然消息"}`,
  "或",
  `{"decision":"silent","text":""}`,
].join("\n");

/** 22:00-08:00 静默段内，且最近 60 秒内有输入，才视为"活跃的深夜"。 */
function isActiveNight(date: Date, timezone: string, idleSec: number): boolean {
  const quiet = isWithinQuietHours(minuteOfDay(getZonedDateParts(date, timezone)));
  return quiet && idleSec < 60;
}

function twoDigits(n: number): string {
  return String(n).padStart(2, "0");
}

/** 用户时区下的"本地时间"格式化：`YYYY-MM-DD HH:MM`。 */
function localStamp(date: Date, timezone: string): string {
  const parts = getZonedDateParts(date, timezone);
  const datePart = `${parts.year}-${twoDigits(parts.month)}-${twoDigits(parts.day)}`;
  return `${datePart} ${twoDigits(parts.hour)}:${twoDigits(parts.minute)}`;
}

function renderHistory(label: string, turns: ProactiveHistoryTurn[], timezone: string): string {
  const usable = turns
    .filter((t) => t && (t.role === "user" || t.role === "model") && t.content.trim())
    .slice(-HISTORY_WINDOW);
  const rows = usable.map((t) => {
    const speaker = t.role === "model" ? "assistant" : "user";
    return `[${localStamp(new Date(t.at), timezone)}] ${speaker}: ${t.content.trim()}`;
  });
  const body = rows.length > 0 ? rows.join("\n") : "（暂无）";
  return `[${label}]\n${body}`;
}

export function buildProactiveMessages(input: BuildProactiveMessagesInput): ChatMessage[] {
  const pieces: string[] = [input.basePersona.trim(), SYSTEM_BLOCK];
  const profileText = input.userProfile?.trim();
  if (profileText) pieces.push(`[用户画像]\n${profileText}`);
  const memoryText = input.relevantMemory?.trim();
  if (memoryText) pieces.push(`[相关长期记忆]\n${memoryText}`);
  pieces.push(renderHistory("最近使用的普通聊天会话", input.ordinaryHistory, input.timezone));
  pieces.push(renderHistory("主动聊天专用会话", input.proactiveHistory, input.timezone));
  if (isActiveNight(input.localNow, input.timezone, input.idleSec)) pieces.push(NIGHT_BLOCK);
  if (input.unansweredCount === 1) pieces.push(FOLLOWUP_BLOCK);

  const candidateBlock = [
    "[本次主动聊天候选]",
    `电脑本地时间：${localStamp(input.localNow, input.timezone)}`,
    `候选场景：${input.sceneId}`,
    `连续未回复次数：${input.unansweredCount}`,
    "",
    REQUEST_TAIL,
  ].join("\n");

  return [
    { role: "system", content: pieces.filter(Boolean).join("\n\n---\n\n") },
    { role: "user", content: candidateBlock },
  ];
}

export function parseProactiveDecision(text: string): ProactiveModelDecision {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text.trim());
  } catch {
    return { kind: "invalid", reason: "invalid_json" };
  }
  const isPlainObject = Boolean(decoded) && typeof decoded === "object" && !Array.isArray(decoded);
  if (!isPlainObject) return { kind: "invalid", reason: "invalid_shape" };

  const record = decoded as { decision?: unknown; text?: unknown };
  if (record.decision === "silent") return { kind: "silent" };
  if (record.decision !== "send") return { kind: "invalid", reason: "invalid_decision" };
  const raw = record.text;
  if (typeof raw !== "string" || !raw.trim()) return { kind: "invalid", reason: "empty_text" };
  const trimmed = raw.trim();
  if (trimmed.length > TEXT_CEILING) return { kind: "invalid", reason: "text_too_long" };
  return { kind: "send", text: trimmed };
}
