import type { ScheduleConfig } from "../../../main/platform/schedule/schedule-types";
import * as cron from "../../../main/features/scheduler/cron";
import { PluginScheduleError, type Schedule } from "./types";
export type { ParsedCronExpression } from "../../../main/features/scheduler/cron";

const MAX_MINUTES_INTERVAL = 168 * 60;
const MAX_STORE_MINUTES_INTERVAL = 1440;

function pluginCronCall<T>(call: () => T): T {
  try { return call(); }
  catch (cause) { throw new PluginScheduleError("ERR_INVALID_ARGUMENT", cause instanceof Error ? cause.message : "Invalid cron schedule", { cause }); }
}
export function parseCronExpression(expression: string, timezone?: string): cron.ParsedCronExpression {
  return pluginCronCall(() => cron.parseCronExpression(expression, timezone));
}
export function validateTimezone(timezone: string): void {
  pluginCronCall(() => cron.validateTimezone(timezone));
}
export function computeNextCronFireAt(expression: string, after: Date, timezone?: string): Date {
  return pluginCronCall(() => {
    const next = cron.computeNextCronFireAt(expression, after, timezone);
    if (!next) throw new Error(`Cron expression "${expression}" has no future occurrence`);
    return next;
  });
}

/** Validate the SDK schedule and preserve cron as a native recurring host schedule. */
export function validateAndConvertSchedule(
  schedule: Schedule,
  now: Date,
  options: { checkOnceInFuture?: boolean } = {},
): { storeSchedule: ScheduleConfig } {
  if (!schedule || typeof schedule !== "object") {
    throw new PluginScheduleError("ERR_INVALID_ARGUMENT", "Schedule must be an object");
  }

  const checkOnceInFuture = options.checkOnceInFuture ?? true;

  if (schedule.kind === "once") {
    if (typeof schedule.at !== "number" || !Number.isFinite(schedule.at)) {
      throw new PluginScheduleError("ERR_INVALID_ARGUMENT", "One-shot schedule requires a finite timestamp 'at'");
    }
    if (checkOnceInFuture && schedule.at <= now.getTime()) {
      throw new PluginScheduleError("ERR_INVALID_ARGUMENT", "One-shot schedule 'at' must be in the future");
    }
    return {
      storeSchedule: { kind: "once", runAt: new Date(schedule.at).toISOString() },
    };
  }

  if (schedule.kind === "interval") {
    if (
      typeof schedule.minutes !== "number"
      || !Number.isInteger(schedule.minutes)
      || schedule.minutes <= 0
      || schedule.minutes > MAX_MINUTES_INTERVAL
    ) {
      throw new PluginScheduleError(
        "ERR_INVALID_ARGUMENT",
        `Interval minutes must be an integer between 1 and ${MAX_MINUTES_INTERVAL}`,
      );
    }
    if (schedule.minutes <= MAX_STORE_MINUTES_INTERVAL) {
      return {
        storeSchedule: { kind: "interval", every: schedule.minutes, unit: "minutes" },
      };
    }
    if (schedule.minutes % 60 === 0) {
      return {
        storeSchedule: { kind: "interval", every: schedule.minutes / 60, unit: "hours" },
      };
    }
    throw new PluginScheduleError(
      "ERR_INVALID_ARGUMENT",
      `Interval minutes above ${MAX_STORE_MINUTES_INTERVAL} must be a whole multiple of 60`,
    );
  }

  if (schedule.kind === "cron") {
    const parsed = parseCronExpression(schedule.expression, schedule.timezone);
    computeNextCronFireAt(parsed.expression, now, parsed.timezone);
    return { storeSchedule: { kind: "cron", expression: parsed.expression, ...(parsed.timezone !== undefined ? { timezone: parsed.timezone } : {}) } };
  }

  throw new PluginScheduleError("ERR_INVALID_ARGUMENT", `Unsupported schedule kind: ${String((schedule as { kind?: unknown }).kind)}`);
}
