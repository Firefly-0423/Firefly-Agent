import { describe, expect, it } from "vitest";
import { parseHistoryTimeIntent } from "./history-time-intent";

const HOUR = 3_600_000, DAY = 24 * HOUR;
// Friday 2026-10-16 13:00 in Asia/Shanghai (UTC+8, no DST); 2026-10-16 01:00 in New York (UTC-4).
const NOW = Date.UTC(2026, 9, 16, 5, 0, 0);
const SH = "Asia/Shanghai";
const shanghaiMidnight = (month: number, day: number) => Date.UTC(2026, month - 1, day) - 8 * HOUR;
const range = (from: number, to: number) => ({ kind: "range" as const, from, to });
const intent = (text: string, tz = SH, now = NOW) => parseHistoryTimeIntent(text, now, tz);

describe("history time intent", () => {
  it.each([
    ["昨天我们聊了什么", range(shanghaiMidnight(10, 15), shanghaiMidnight(10, 16) - 1)],
    ["what did we discuss yesterday", range(shanghaiMidnight(10, 15), shanghaiMidnight(10, 16) - 1)],
    ["前天那个问题", range(shanghaiMidnight(10, 14), shanghaiMidnight(10, 15) - 1)],
    ["the day before yesterday's question", range(shanghaiMidnight(10, 14), shanghaiMidnight(10, 15) - 1)],
    ["今天早些时候的讨论", range(shanghaiMidnight(10, 16), shanghaiMidnight(10, 17) - 1)],
    ["上周我提到的方案", range(shanghaiMidnight(10, 5), shanghaiMidnight(10, 12) - 1)],
    ["the plan I mentioned last week", range(shanghaiMidnight(10, 5), shanghaiMidnight(10, 12) - 1)],
    ["这周讨论过的", range(shanghaiMidnight(10, 12), shanghaiMidnight(10, 19) - 1)],
    ["上个月的计划", range(shanghaiMidnight(9, 1), shanghaiMidnight(10, 1) - 1)],
    ["本月的进展", range(shanghaiMidnight(10, 1), shanghaiMidnight(11, 1) - 1)],
    ["最近3天聊过的", range(NOW - 3 * DAY, NOW)],
    ["过去 七 天的记录", range(NOW - 7 * DAY, NOW)],
    ["in the last 10 days", range(NOW - 10 * DAY, NOW)],
    ["我最近说过什么", range(NOW - 14 * DAY, NOW)],
    ["what did I say recently", range(NOW - 14 * DAY, NOW)],
  ])("maps %s to its calendar window in the user's time zone", (text, expected) => {
    expect(intent(text)?.query).toEqual(expected);
  });

  it.each(["上次", "我们最近一次聊这个是什么时候", "when was the last time we talked about it"])("maps %s to the latest ordering", text => {
    expect(intent(text)?.query).toEqual({ kind: "latest" });
  });

  it("uses the supplied time zone for day boundaries", () => {
    // 01:00 on Oct 16 in New York is still the 16th there but the 16th (13:00) in Shanghai too; yesterday differs by zone.
    const ny = intent("yesterday", "America/New_York");
    expect(ny?.query).toEqual(range(Date.UTC(2026, 9, 15, 4), Date.UTC(2026, 9, 16, 4) - 1));
    expect(intent("yesterday", "UTC")?.query).toEqual(range(Date.UTC(2026, 9, 15), Date.UTC(2026, 9, 16) - 1));
  });

  it("falls back to UTC for an unknown time zone instead of throwing", () => {
    expect(intent("yesterday", "Not/AZone")?.query).toEqual(range(Date.UTC(2026, 9, 15), Date.UTC(2026, 9, 16) - 1));
  });

  it("carries a human readable label naming the window and zone", () => {
    expect(intent("上周我提到的方案")?.label).toContain("2026-10-05");
    expect(intent("上周我提到的方案")?.label).toContain("2026-10-11");
    expect(intent("上周我提到的方案")?.label).toContain(SH);
  });

  it.each([
    "我喜欢用 PowerShell",
    "explain how closures work",
    "give me the latest React version",
    "最新版本的 Node 是什么",
    "今天和昨天都聊过",
    "last week or last month",
    "最近3000天",
    "last 0 days",
    "",
  ])("returns nothing for text without exactly one clear time intent: %s", text => {
    expect(intent(text)).toBeUndefined();
  });

  it("is not triggered by words that merely contain a time word", () => {
    expect(intent("yesterdayish handling")).toBeUndefined();
    expect(intent("the todayfile.txt")).toBeUndefined();
  });

  it("week boundaries follow Monday-start weeks across a month change", () => {
    const sunday = Date.UTC(2026, 10, 1, 5, 0, 0); // Sunday 2026-11-01 13:00 Shanghai
    expect(intent("上周", SH, sunday)?.query).toEqual(range(shanghaiMidnight(10, 19), shanghaiMidnight(10, 26) - 1));
    expect(intent("这周", SH, sunday)?.query).toEqual(range(shanghaiMidnight(10, 26), shanghaiMidnight(11, 2) - 1));
  });

  it("is deterministic and never reads the clock itself", () => {
    expect(intent("yesterday")).toEqual(intent("yesterday"));
  });
});
