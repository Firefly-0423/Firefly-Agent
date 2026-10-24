import { describe, expect, it } from "vitest";
import {
  buildScheduleConfig,
  defaultScheduleDraft,
  describeSchedule,
  describeTaskTools,
  fireNowErrorMessage,
  isValidTimeOfDay,
  scheduleDraftFromSchedule,
  toLocalDateTimeInputValue,
  type ScheduledTask,
} from "./scheduled-task-model";

/** 测试用翻译桩：返回 key 与插值，验证调用方传参而不依赖语言资源。 */
const t = (key: string, options?: Record<string, unknown>) => (
  options ? `${key}${JSON.stringify(options)}` : key
);

const NOW = Date.parse("2026-10-16T00:00:00.000Z");

describe("buildScheduleConfig", () => {
  it("builds a daily schedule and falls back to 08:00 when the time is cleared", () => {
    expect(buildScheduleConfig({ ...defaultScheduleDraft(), timeOfDay: "" }, NOW)).toEqual({
      ok: true,
      schedule: { kind: "daily", timeOfDay: "08:00" },
    });
  });

  it("rejects malformed daily and weekly times", () => {
    expect(buildScheduleConfig({ ...defaultScheduleDraft(), timeOfDay: "25:00" }, NOW))
      .toEqual({ ok: false, errorKey: "scheduledPanel.errors.dailyTimeInvalid" });
    expect(buildScheduleConfig({ ...defaultScheduleDraft(), kind: "weekly", timeOfDay: "7:00" }, NOW))
      .toEqual({ ok: false, errorKey: "scheduledPanel.errors.weeklyTimeInvalid" });
  });

  it("requires a future one-time run time and converts it to ISO", () => {
    expect(buildScheduleConfig({ ...defaultScheduleDraft(), kind: "once", runAt: "" }, NOW))
      .toEqual({ ok: false, errorKey: "scheduledPanel.errors.runAtRequired" });
    expect(buildScheduleConfig({ ...defaultScheduleDraft(), kind: "once", runAt: "not-a-date" }, NOW))
      .toEqual({ ok: false, errorKey: "scheduledPanel.errors.runAtInvalid" });
    const past = buildScheduleConfig({ ...defaultScheduleDraft(), kind: "once", runAt: "2000-01-01T00:00" }, NOW);
    expect(past).toEqual({ ok: false, errorKey: "scheduledPanel.errors.runAtPast" });
    const future = buildScheduleConfig({ ...defaultScheduleDraft(), kind: "once", runAt: "2030-01-01T09:30" }, NOW);
    expect(future.ok).toBe(true);
    if (future.ok) expect(future.schedule.kind).toBe("once");
  });

  it("validates interval numbers and per-unit upper bounds", () => {
    const interval = (every: string, unit: "minutes" | "hours") => buildScheduleConfig(
      { ...defaultScheduleDraft(), kind: "interval", every, unit },
      NOW,
    );
    expect(interval("", "minutes")).toEqual({ ok: false, errorKey: "scheduledPanel.errors.intervalInvalid" });
    expect(interval("1.5", "hours")).toEqual({ ok: false, errorKey: "scheduledPanel.errors.intervalInvalid" });
    expect(interval("1441", "minutes")).toEqual({ ok: false, errorKey: "scheduledPanel.errors.minuteIntervalTooLarge" });
    expect(interval("169", "hours")).toEqual({ ok: false, errorKey: "scheduledPanel.errors.hourIntervalTooLarge" });
    expect(interval("168", "hours")).toEqual({ ok: true, schedule: { kind: "interval", every: 168, unit: "hours" } });
  });

  it("rejects a weekday outside 0-6", () => {
    expect(buildScheduleConfig({ ...defaultScheduleDraft(), kind: "weekly", dayOfWeek: 7 }, NOW))
      .toEqual({ ok: false, errorKey: "scheduledPanel.errors.dayInvalid" });
  });
});

describe("scheduleDraftFromSchedule", () => {
  it("restores each schedule kind into the form draft", () => {
    expect(scheduleDraftFromSchedule({ kind: "weekly", dayOfWeek: 3, timeOfDay: "09:15" })).toMatchObject({
      kind: "weekly", dayOfWeek: 3, timeOfDay: "09:15",
    });
    expect(scheduleDraftFromSchedule({ kind: "interval", every: 5, unit: "minutes" })).toMatchObject({
      kind: "interval", every: "5", unit: "minutes",
    });
    expect(scheduleDraftFromSchedule({ kind: "once", runAt: "2030-01-01T00:00:00.000Z" }).runAt)
      .toBe(toLocalDateTimeInputValue("2030-01-01T00:00:00.000Z"));
  });
});

describe("formatting helpers", () => {
  it("accepts only HH:mm between 00:00 and 23:59", () => {
    expect(isValidTimeOfDay("00:00")).toBe(true);
    expect(isValidTimeOfDay("23:59")).toBe(true);
    expect(isValidTimeOfDay("24:00")).toBe(false);
    expect(isValidTimeOfDay("8:00")).toBe(false);
  });

  it("renders the local datetime-local value and empties invalid input", () => {
    expect(toLocalDateTimeInputValue("not-a-date")).toBe("");
    expect(toLocalDateTimeInputValue("2030-01-02T03:04:00")).toMatch(/^2030-01-02T03:04$/);
  });

  it("describes each schedule kind through i18n keys", () => {
    expect(describeSchedule({ kind: "daily", timeOfDay: "08:00" }, t)).toBe('scheduledPanel.summaryDaily{"time":"08:00"}');
    expect(describeSchedule({ kind: "weekly", dayOfWeek: 1, timeOfDay: "08:00" }, t))
      .toBe('scheduledPanel.summaryWeekly{"day":"scheduledPanel.days.mon","time":"08:00"}');
    expect(describeSchedule({ kind: "interval", every: 2, unit: "hours" }, t))
      .toBe('scheduledPanel.summaryInterval{"every":2,"unit":"scheduledPanel.units.hours"}');
  });
});

describe("task tool summaries and run errors", () => {
  const base: ScheduledTask = {
    id: "t", title: "t", prompt: "p", enabled: true, schedule: { kind: "daily", timeOfDay: "08:00" },
    nextFireAt: null, toolMode: "all-enabled", allowedToolIds: [], createdAt: "", updatedAt: "",
  };

  it("shows all tools for an unrestricted user task and the allow-list otherwise", () => {
    expect(describeTaskTools(base, t)).toBe("scheduledPanel.allTools");
    expect(describeTaskTools({ ...base, toolMode: "allow-list" }, t)).toBe("scheduledPanel.noTools");
    expect(describeTaskTools({ ...base, toolMode: "allow-list", allowedToolIds: ["a", "b"] }, t)).toBe("a, b");
    expect(describeTaskTools({ ...base, ownerPluginId: "p", allowedToolIds: [] }, t)).toBe("scheduledPanel.noTools");
  });

  it("maps fireNow reasons to readable messages", () => {
    expect(fireNowErrorMessage({ reason: "task already running" }, t)).toBe("scheduledPanel.errors.alreadyRunning");
    expect(fireNowErrorMessage({ reason: "plugin not running" }, t)).toBe("scheduledPanel.errors.pluginNotRunning");
    expect(fireNowErrorMessage({ error: "boom" }, t)).toBe("boom");
    expect(fireNowErrorMessage({}, t)).toBe("scheduledPanel.errors.runFailed");
  });
});
