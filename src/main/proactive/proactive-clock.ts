// 主动陪伴的唯一时钟与免打扰规则。
// 此前"是否打扰"用系统本地小时，候选打分用用户设置的 IANA 时区，夜间规则又在策略与提示词里各写一份，
// 同一次决策会用到两个时钟。这里只保留一份实现，所有调用方都从用户时区取墙上时间。

export interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * 用 Intl 把时刻拆成用户时区下的 {year, month, day, hour, minute}。
 * 不依赖 toLocaleString 的本地化标点和顺序；`h23` 保证午夜是 0 而不是 24。
 * 时区非法时降级为系统本地时间（调用方应先经 resolveChatContextTimezone 校验，此分支只在调试时出现）。
 */
export function getZonedDateParts(date: Date, timezone: string): ZonedDateParts {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
  } catch {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  }
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

export const minuteOfDay = (parts: Pick<ZonedDateParts, "hour" | "minute">): number => parts.hour * 60 + parts.minute;

/** 免打扰窗口，按一天中的分钟数表示。含起点、不含终点；终点小于起点表示跨午夜。 */
export interface QuietHoursWindow {
  startMinute: number;
  endMinute: number;
}

export const DEFAULT_QUIET_HOURS: Readonly<QuietHoursWindow> = Object.freeze({ startMinute: 22 * 60, endMinute: 8 * 60 });

export function isWithinQuietHours(minute: number, window: QuietHoursWindow = DEFAULT_QUIET_HOURS): boolean {
  const { startMinute, endMinute } = window;
  if (startMinute === endMinute) return false;
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
}
