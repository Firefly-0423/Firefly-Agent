import type { ScheduleConfig } from "./types";

// datetime-local 使用本机时间，不附带时区。
export function toLocalDateTimeInputValue(value: string): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) { return ""; }
  const twoDigits = (part: number): string => String(part).padStart(2, "0");
  const calendar = [instant.getFullYear(), twoDigits(instant.getMonth() + 1), twoDigits(instant.getDate())];
  const clock = [twoDigits(instant.getHours()), twoDigits(instant.getMinutes())];
  return calendar.join("-") + "T" + clock.join(":");
}

export function isValidTimeOfDay(value: string): boolean {
  const clockPattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  return clockPattern.test(value);
}

export function formatSchedulerDate(value: string | null | undefined): string {
  if (!value) { return "未安排"; }
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? "时间无效" : instant.toLocaleString();
}

export function describeSchedule(schedule: ScheduleConfig): string {
  switch (schedule.kind) {
    case "once": return "仅一次 " + formatSchedulerDate(schedule.runAt);
    case "daily": return "每天 " + schedule.timeOfDay;
    case "weekly": {
      const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
      return weekdays[schedule.dayOfWeek] + " " + schedule.timeOfDay;
    }
    default: return `每隔 ${schedule.every} ${schedule.unit === "minutes" ? "分钟" : "小时"}`;
  }
}
