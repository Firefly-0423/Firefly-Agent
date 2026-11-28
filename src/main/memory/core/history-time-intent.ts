import type { HistoryTemporalQuery } from "./history-temporal";

/** A time intent recognised in the user's own question, with a label the model can be told. */
export interface HistoryTimeIntent { query: HistoryTemporalQuery; label: string }

const DAY = 86_400_000;
/** "Recently" is not a calendar unit; this is the window it means. */
export const RECENT_WINDOW_DAYS = 14;
const MAX_LAST_DAYS = 365;
const ZH_DIGITS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function zoneOrUtc(timeZone: string): string {
  try { new Intl.DateTimeFormat("en-US", { timeZone }); return timeZone; } catch { return "UTC"; }
}
interface Civil { year: number; month: number; day: number }
function civilOf(ts: number, timeZone: string): Civil & { hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ts));
  const value = (type: string) => Number(parts.find(part => part.type === type)!.value);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute"), second: value("second") };
}
function offsetMs(ts: number, timeZone: string): number {
  const c = civilOf(ts, timeZone);
  return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) - Math.floor(ts / 1000) * 1000;
}
/** Epoch of 00:00 on the given civil date in the zone; the date may overflow its month. */
function midnight(civil: Civil, timeZone: string): number {
  const target = Date.UTC(civil.year, civil.month - 1, civil.day);
  let guess = target;
  for (let i = 0; i < 3; i++) guess = target - offsetMs(guess, timeZone);
  return guess;
}
function shiftDays(civil: Civil, days: number): Civil {
  const date = new Date(Date.UTC(civil.year, civil.month - 1, civil.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}
const two = (n: number) => String(n).padStart(2, "0");
const dateText = (civil: Civil) => `${civil.year}-${two(civil.month)}-${two(civil.day)}`;

function dayWindow(today: Civil, fromOffset: number, toOffsetExclusive: number, timeZone: string) {
  const first = shiftDays(today, fromOffset), after = shiftDays(today, toOffsetExclusive);
  return { from: midnight(first, timeZone), to: midnight(after, timeZone) - 1, first, last: shiftDays(after, -1) };
}
function monthWindow(today: Civil, monthOffset: number, timeZone: string) {
  const index = today.year * 12 + (today.month - 1) + monthOffset;
  const first: Civil = { year: Math.floor(index / 12), month: (index % 12) + 1, day: 1 };
  const next = index + 1, after: Civil = { year: Math.floor(next / 12), month: (next % 12) + 1, day: 1 };
  return { from: midnight(first, timeZone), to: midnight(after, timeZone) - 1, first, last: shiftDays(after, -1) };
}
function zhNumber(text: string): number | undefined {
  if (/^\d{1,4}$/.test(text)) return Number(text);
  if (text === "十") return 10;
  const ten = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(text);
  if (ten) return (ten[1] ? ZH_DIGITS[ten[1]] : 1) * 10 + (ten[2] ? ZH_DIGITS[ten[2]] : 0);
  return text.length === 1 ? ZH_DIGITS[text] : undefined;
}

interface Rule { id: string; pattern: RegExp }
// Longer phrases come first and each match is consumed, so "last 3 days" never also reads as "recently".
const RULES: Rule[] = [
  { id: "latest", pattern: /上一次|上次|最近一次|最后一次|最近一回|\blast time\b|\bthe (?:latest|most recent) (?:time|conversation|discussion|chat)\b/giu },
  { id: "last-n-days", pattern: /(?:最近|过去|近)\s*([0-9一二两三四五六七八九十]{1,4})\s*[天日]|\b(?:last|past)\s+(\d{1,4})\s+days?\b/giu },
  { id: "day-before-yesterday", pattern: /前天|\bthe day before yesterday\b/giu },
  { id: "yesterday", pattern: /昨天|昨日|\byesterday\b/giu },
  { id: "last-week", pattern: /上个?星期|上周|\b(?:last|previous) week\b/giu },
  { id: "last-month", pattern: /上个?月|\b(?:last|previous) month\b/giu },
  { id: "this-week", pattern: /本周|这周|这个星期|\bthis week\b/giu },
  { id: "this-month", pattern: /本月|这个月|\bthis month\b/giu },
  { id: "today", pattern: /今天|今日|\btoday\b/giu },
  { id: "recently", pattern: /最近|近期|近来|这几天|这些天|\b(?:recently|lately|these days)\b/giu },
];

/**
 * Reads at most one explicit time intent from the user's own current question. The caller
 * supplies the clock and zone; nothing here reads either. Anything unclear (two different time
 * phrases, an out-of-range "last N days") yields no intent at all, never a guess.
 */
export function parseHistoryTimeIntent(text: string, now: number, timeZone: string): HistoryTimeIntent | undefined {
  if (typeof text !== "string" || !text || !Number.isSafeInteger(now) || now < 0) return undefined;
  const zone = zoneOrUtc(timeZone);
  let rest = text.normalize("NFKC").toLowerCase();
  const found: Array<{ id: string; days?: number }> = [];
  for (const rule of RULES) {
    rest = rest.replace(rule.pattern, (_match, zh?: string, en?: string) => {
      if (rule.id === "last-n-days") {
        const days = zhNumber(zh ?? en ?? "");
        found.push({ id: rule.id, ...(days === undefined ? {} : { days }) });
      } else found.push({ id: rule.id });
      return " ";
    });
  }
  if (found.length !== 1) return undefined;
  const [{ id, days }] = found;
  const today = civilOf(now, zone), tz = zone;
  const make = (window: { from: number; to: number; first: Civil; last: Civil }, name: string): HistoryTimeIntent => ({
    query: { kind: "range", from: window.from, to: window.to },
    label: `${name}（${dateText(window.first)}${window.first.day === window.last.day && window.first.month === window.last.month ? "" : " 至 " + dateText(window.last)}，时区 ${tz}）`,
  });
  if (id === "latest") return { query: { kind: "latest" }, label: "最近一次相关的历史" };
  if (id === "last-n-days") {
    if (days === undefined || days < 1 || days > MAX_LAST_DAYS) return undefined;
    return { query: { kind: "range", from: now - days * DAY, to: now }, label: `过去 ${days} 天（截至当前时刻，时区 ${tz}）` };
  }
  if (id === "recently") return { query: { kind: "range", from: now - RECENT_WINDOW_DAYS * DAY, to: now }, label: `最近 ${RECENT_WINDOW_DAYS} 天（截至当前时刻，时区 ${tz}）` };
  if (id === "today") return make(dayWindow(today, 0, 1, tz), "今天");
  if (id === "yesterday") return make(dayWindow(today, -1, 0, tz), "昨天");
  if (id === "day-before-yesterday") return make(dayWindow(today, -2, -1, tz), "前天");
  const weekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay(), sinceMonday = (weekday + 6) % 7;
  if (id === "this-week") return make(dayWindow(today, -sinceMonday, 7 - sinceMonday, tz), "本周");
  if (id === "last-week") return make(dayWindow(today, -sinceMonday - 7, -sinceMonday, tz), "上周");
  if (id === "this-month") return make(monthWindow(today, 0, tz), "本月");
  return make(monthWindow(today, -1, tz), "上个月");
}
