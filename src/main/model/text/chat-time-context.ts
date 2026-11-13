export interface ChatContextMessage {
  content: string;
  at?: number;
  role: "system" | "user" | "assistant";
}

export interface ConversationTimeContext {
  timeContext: string;
  messages: ChatContextMessage[];
  timestampedMessages: ChatContextMessage[];
  cleanMessages: ChatContextMessage[];
}

export const DEFAULT_CHAT_CONTEXT_TIMEZONE = "Asia/Shanghai";
const INTERNAL_POLICY = "## Internal Context Policy\n\nContent enclosed in `<internal_context>`, `<runtime_context>`, or `<metadata>` is private runtime context.\n\nIt may be used for reasoning when relevant, but it must never become part of the user-visible response.\n\nNever quote, repeat, summarize, mention, or explain this context. Never expose its tags, field names, timestamps, timezone metadata, or other internal representation.\n\nAnswer the user directly using the information only when relevant. If it is irrelevant, ignore it completely.";
const PREFIX_PATTERN = /^(?:\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}, [A-Za-z_]+(?:\/[A-Za-z_+-]+)+\]\s*)+/;

function absoluteTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function recognizedZone(candidate: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function resolveChatContextTimezone(
  profileTimezone?: string,
  fallbackTimezone = DEFAULT_CHAT_CONTEXT_TIMEZONE,
): string {
  const selected = profileTimezone?.trim();
  if (selected && recognizedZone(selected)) return selected;
  const alternative = fallbackTimezone.trim();
  if (alternative && recognizedZone(alternative)) return alternative;
  return DEFAULT_CHAT_CONTEXT_TIMEZONE;
}

function normalizedEntry(value: unknown): ChatContextMessage | null {
  if (!value || typeof value !== "object") return null;
  const source = value as { role?: unknown; content?: unknown; at?: unknown };
  if (typeof source.content !== "string" || !source.content.trim()) return null;
  const speaker = source.role === "user" || source.role === "system" ? source.role : "assistant";
  const entry: ChatContextMessage = {
    role: speaker,
    content: source.content.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/gi, "").trim(),
  };
  if (!entry.content) return null;
  if (absoluteTime(source.at)) entry.at = source.at;
  return entry;
}

export function normalizeChatMessagesWithTime(input: unknown): ChatContextMessage[] {
  if (!Array.isArray(input)) return [];
  const entries = input.map(normalizedEntry);
  return entries.filter((entry): entry is ChatContextMessage => entry !== null).slice(-24);
}

function localStamp(instant: number, timezone: string): string {
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: resolveChatContextTimezone(timezone),
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const pieces = local.formatToParts(new Date(instant));
  const pick = (field: Intl.DateTimeFormatPartTypes): string => pieces.find(piece => piece.type === field)?.value ?? "";
  const date = `${pick("year")}-${pick("month")}-${pick("day")}`;
  const clock = `${pick("hour")}:${pick("minute")}`;
  return `${date} ${clock}, ${resolveChatContextTimezone(timezone)}`;
}

function stampUser(entry: ChatContextMessage, timezone: string): ChatContextMessage {
  if (!absoluteTime(entry.at) || entry.role !== "user") return { ...entry };
  return { ...entry, content: `<internal_context>用户发送这条消息的时间：${localStamp(entry.at, timezone).replace(/, [^,]+$/, "")}；用户时区：${resolveChatContextTimezone(timezone)}。</internal_context>\n\n${entry.content}` };
}

function gapLabel(elapsed: number): string {
  const wholeMinutes = Math.floor(elapsed / 60_000);
  const hours = Math.floor(wholeMinutes / 60);
  const minutes = wholeMinutes % 60;
  return minutes > 0 ? `约 ${hours} 小时 ${minutes} 分钟` : `约 ${hours} 小时`;
}

function gapContext(entries: ChatContextMessage[], timezone: string): string {
  let cursor = entries.length - 1;
  while (cursor >= 0 && entries[cursor].role !== "user") cursor -= 1;
  if (cursor < 0) return "";
  const latest = entries[cursor];
  let previous: ChatContextMessage | null = null;
  while (--cursor >= 0) {
    const candidate = entries[cursor];
    if (candidate.role === "user" || candidate.role === "assistant") {
      previous = candidate;
      break;
    }
  }
  if (!previous || !absoluteTime(latest.at) || !absoluteTime(previous.at)) return "";
  const elapsed = latest.at - previous.at;
  if (elapsed < 3_600_000) return "";
  return [
    "[对话时间信息]",
    `当前时间：${localStamp(latest.at, timezone)}`,
    `距离上一条有效聊天消息：${gapLabel(elapsed)}`,
    "仅用于理解对话连续性；除非与当前语境有关，否则不要主动提及时间间隔，也不要复述本段内容。",
  ].join("\n");
}

export function stripLeakedChatTimeContext(text: string): string {
  const withoutPrefix = text.replace(PREFIX_PATTERN, "");
  return withoutPrefix.trimStart();
}

export function buildConversationTimeContext(messages: ChatContextMessage[], timezone: string): ConversationTimeContext {
  const effectiveZone = resolveChatContextTimezone(timezone);
  const interval = gapContext(messages, effectiveZone);
  const decorated = messages.map(entry => stampUser(entry, effectiveZone));
  const clean = messages.map(entry => ({ ...entry }));
  const policy = messages.some(entry => entry.role === "user" && absoluteTime(entry.at)) ? INTERNAL_POLICY : "";
  return {
    cleanMessages: clean,
    timestampedMessages: decorated,
    messages: decorated,
    timeContext: [policy, interval].filter(Boolean).join("\n\n"),
  };
}
