import type { ScheduleConfig } from "../../../main/platform/schedule/schedule-types";
import { PluginError, type Schedule } from "./types";

export interface ParsedCronExpression {
  expression: string;
  timezone?: string;
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
  rawFields: readonly [string, string, string, string, string];
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const MAX_MINUTES_INTERVAL = 168 * 60;
const MAX_STORE_MINUTES_INTERVAL = 1440;
const MAX_CRON_LOOKAHEAD_DAYS = 366 * 4;

function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseCronField(
  field: string,
  min: number,
  max: number,
  label: string,
  normalize?: (value: number) => number,
): { values: Set<number>; restricted: boolean } {
  if (!field) {
    throw new PluginError("ERR_INVALID_ARGUMENT", `Cron ${label} field is empty`);
  }
  const values = new Set<number>();
  const restricted = field !== "*";

  for (const part of field.split(",")) {
    if (!part) {
      throw new PluginError("ERR_INVALID_ARGUMENT", `Invalid cron ${label} token: "${field}"`);
    }
    const slashSplit = part.split("/");
    if (slashSplit.length > 2) {
      throw new PluginError("ERR_INVALID_ARGUMENT", `Invalid cron ${label} step: "${part}"`);
    }
    const [rangeRaw, stepRaw] = slashSplit;
    let step = 1;
    if (stepRaw !== undefined) {
      const parsedStep = parsePositiveInt(stepRaw);
      if (parsedStep === null || parsedStep <= 0) {
        throw new PluginError("ERR_INVALID_ARGUMENT", `Invalid cron ${label} step: "${part}"`);
      }
      step = parsedStep;
    }

    let start: number;
    let end: number;
    if (rangeRaw === "*") {
      start = min;
      end = max;
    } else if (rangeRaw.includes("-")) {
      const bounds = rangeRaw.split("-");
      if (bounds.length !== 2) {
        throw new PluginError("ERR_INVALID_ARGUMENT", `Invalid cron ${label} range: "${part}"`);
      }
      const left = parsePositiveInt(bounds[0]);
      const right = parsePositiveInt(bounds[1]);
      if (left === null || right === null || left < min || right > max || left > right) {
        throw new PluginError("ERR_INVALID_ARGUMENT", `Out-of-range cron ${label} range: "${part}"`);
      }
      start = left;
      end = right;
    } else {
      const exact = parsePositiveInt(rangeRaw);
      if (exact === null || exact < min || exact > max) {
        throw new PluginError("ERR_INVALID_ARGUMENT", `Out-of-range cron ${label} value: "${part}"`);
      }
      if (stepRaw !== undefined) {
        start = exact;
        end = max;
      } else {
        values.add(normalize ? normalize(exact) : exact);
        continue;
      }
    }

    for (let current = start; current <= end; current += step) {
      values.add(normalize ? normalize(current) : current);
    }
  }

  if (values.size === 0) {
    throw new PluginError("ERR_INVALID_ARGUMENT", `Cron ${label} field matched no values`);
  }
  return { values, restricted };
}

export function validateTimezone(timezone: string): void {
  if (typeof timezone !== "string" || timezone.trim().length === 0) {
    throw new PluginError("ERR_INVALID_ARGUMENT", "Timezone must be a non-empty IANA string");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch (cause) {
    throw new PluginError("ERR_INVALID_ARGUMENT", `Invalid timezone: "${timezone}"`, { cause });
  }
}

export function parseCronExpression(expression: string, timezone?: string): ParsedCronExpression {
  if (typeof expression !== "string") {
    throw new PluginError("ERR_INVALID_ARGUMENT", "Cron expression must be a string");
  }
  if (timezone !== undefined) {
    validateTimezone(timezone);
  }
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new PluginError(
      "ERR_INVALID_ARGUMENT",
      `Cron expression must have exactly 5 fields, got ${fields.length}`,
    );
  }
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = fields;
  const minute = parseCronField(minuteRaw, 0, 59, "minute");
  const hour = parseCronField(hourRaw, 0, 23, "hour");
  const dom = parseCronField(domRaw, 1, 31, "day-of-month");
  const month = parseCronField(monthRaw, 1, 12, "month");
  const dow = parseCronField(dowRaw, 0, 7, "day-of-week", (v) => (v === 7 ? 0 : v));

  return {
    expression: fields.join(" "),
    ...(timezone !== undefined ? { timezone } : {}),
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dom.values,
    months: month.values,
    daysOfWeek: dow.values,
    dayOfMonthRestricted: dom.restricted,
    dayOfWeekRestricted: dow.restricted,
    rawFields: [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw],
  };
}

interface WallClockParts {
  month: number;
  day: number;
  dayOfWeek: number;
  hour: number;
  minute: number;
}

function createFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
}

function getWallClockParts(timestampMs: number, formatter?: Intl.DateTimeFormat): WallClockParts {
  const date = new Date(timestampMs);
  if (!formatter) {
    return {
      month: date.getMonth() + 1,
      day: date.getDate(),
      dayOfWeek: date.getDay(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  }
  const parts = formatter.formatToParts(date);
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let dayOfWeek = 0;
  for (const part of parts) {
    if (part.type === "month") month = Number(part.value);
    else if (part.type === "day") day = Number(part.value);
    else if (part.type === "hour") hour = Number(part.value) % 24;
    else if (part.type === "minute") minute = Number(part.value);
    else if (part.type === "weekday") dayOfWeek = WEEKDAY_MAP[part.value] ?? 0;
  }
  return { month, day, dayOfWeek, hour, minute };
}

function matchesDay(parsed: ParsedCronExpression, parts: WallClockParts): boolean {
  if (!parsed.months.has(parts.month)) return false;
  const domMatch = parsed.daysOfMonth.has(parts.day);
  const dowMatch = parsed.daysOfWeek.has(parts.dayOfWeek);
  if (parsed.dayOfMonthRestricted && parsed.dayOfWeekRestricted) {
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}

/**
 * Computes the next firing timestamp strictly after `after` for a 5-field cron expression.
 */
export function computeNextCronFireAt(expression: string, after: Date, timezone?: string): Date {
  const parsed = parseCronExpression(expression, timezone);
  const formatter = timezone ? createFormatter(timezone) : undefined;
  let cursorMs = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const limitMs = cursorMs + MAX_CRON_LOOKAHEAD_DAYS * 24 * 60 * 60_000;

  while (cursorMs <= limitMs) {
    const parts = getWallClockParts(cursorMs, formatter);
    if (!matchesDay(parsed, parts)) {
      cursorMs += parts.hour < 22 ? (22 - parts.hour) * 3_600_000 : 60_000;
      continue;
    }
    if (!parsed.hours.has(parts.hour)) {
      cursorMs += parts.minute < 58 ? (58 - parts.minute) * 60_000 : 60_000;
      continue;
    }
    if (!parsed.minutes.has(parts.minute)) {
      cursorMs += 60_000;
      continue;
    }
    return new Date(cursorMs);
  }

  throw new PluginError(
    "ERR_INVALID_ARGUMENT",
    `Cron expression "${expression}" has no firing time within ${MAX_CRON_LOOKAHEAD_DAYS} days`,
  );
}

function padTwo(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Validates an SDK 1.2.0 `Schedule` and converts it into a host `ScheduleConfig`
 * accepted by `SchedulerStore` / `SchedulerEngine`.
 *
 * Simple local daily (`M H * * *`) and weekly (`M H * * D`) cron expressions map
 * natively to `daily` / `weekly`; general 5-field or timezone-pinned cron expressions
 * compute their next occurrence as `once` and are re-armed by the host service after
 * each trigger.
 */
export function validateAndConvertSchedule(
  schedule: Schedule,
  now: Date,
  options: { checkOnceInFuture?: boolean } = {},
): { storeSchedule: ScheduleConfig; requiresCronRearm: boolean } {
  if (!schedule || typeof schedule !== "object") {
    throw new PluginError("ERR_INVALID_ARGUMENT", "Schedule must be an object");
  }

  const checkOnceInFuture = options.checkOnceInFuture ?? true;

  if (schedule.kind === "once") {
    if (typeof schedule.at !== "number" || !Number.isFinite(schedule.at)) {
      throw new PluginError("ERR_INVALID_ARGUMENT", "One-shot schedule requires a finite timestamp 'at'");
    }
    if (checkOnceInFuture && schedule.at <= now.getTime()) {
      throw new PluginError("ERR_INVALID_ARGUMENT", "One-shot schedule 'at' must be in the future");
    }
    return {
      storeSchedule: { kind: "once", runAt: new Date(schedule.at).toISOString() },
      requiresCronRearm: false,
    };
  }

  if (schedule.kind === "interval") {
    if (
      typeof schedule.minutes !== "number"
      || !Number.isInteger(schedule.minutes)
      || schedule.minutes <= 0
      || schedule.minutes > MAX_MINUTES_INTERVAL
    ) {
      throw new PluginError(
        "ERR_INVALID_ARGUMENT",
        `Interval minutes must be an integer between 1 and ${MAX_MINUTES_INTERVAL}`,
      );
    }
    if (schedule.minutes <= MAX_STORE_MINUTES_INTERVAL) {
      return {
        storeSchedule: { kind: "interval", every: schedule.minutes, unit: "minutes" },
        requiresCronRearm: false,
      };
    }
    if (schedule.minutes % 60 === 0) {
      return {
        storeSchedule: { kind: "interval", every: schedule.minutes / 60, unit: "hours" },
        requiresCronRearm: false,
      };
    }
    throw new PluginError(
      "ERR_INVALID_ARGUMENT",
      `Interval minutes above ${MAX_STORE_MINUTES_INTERVAL} must be a whole multiple of 60`,
    );
  }

  if (schedule.kind === "cron") {
    const parsed = parseCronExpression(schedule.expression, schedule.timezone);
    const [mRaw, hRaw, domRaw, monthRaw, dowRaw] = parsed.rawFields;
    const mNum = parsePositiveInt(mRaw);
    const hNum = parsePositiveInt(hRaw);

    if (
      !parsed.timezone
      && mNum !== null
      && hNum !== null
      && domRaw === "*"
      && monthRaw === "*"
    ) {
      const timeOfDay = `${padTwo(hNum)}:${padTwo(mNum)}`;
      if (dowRaw === "*") {
        return { storeSchedule: { kind: "daily", timeOfDay }, requiresCronRearm: false };
      }
      const dowNum = parsePositiveInt(dowRaw);
      if (dowNum !== null) {
        return {
          storeSchedule: {
            kind: "weekly",
            dayOfWeek: (dowNum % 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6,
            timeOfDay,
          },
          requiresCronRearm: false,
        };
      }
    }

    const nextFire = computeNextCronFireAt(parsed.expression, now, parsed.timezone);
    return {
      storeSchedule: { kind: "once", runAt: nextFire.toISOString() },
      requiresCronRearm: true,
    };
  }

  throw new PluginError("ERR_INVALID_ARGUMENT", `Unsupported schedule kind: ${String((schedule as { kind?: unknown }).kind)}`);
}
