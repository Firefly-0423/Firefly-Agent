import type { ScheduleConfig } from "./types";

function localClock(anchor: Date, hhmm: string, daysAhead = 0): Date | null {
  const digits = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!digits) return null;
  const hh = Number(digits[1]);
  const mm = Number(digits[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  // 在目标日重建墙上时间：上一次触发若被夏令时缺口挪过，不能带到之后的日子里。
  return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + daysAhead, hh, mm, 0, 0);
}

function intervalLength(plan: Extract<ScheduleConfig, { kind: "interval" }>): number {
  return plan.every * (plan.unit === "minutes" ? 60_000 : 3_600_000);
}

export function computeInitialNextFireAt(plan: ScheduleConfig, instant: Date): Date | null {
  if (plan.kind === "once") {
    const appointment = new Date(plan.runAt);
    if (Number.isNaN(appointment.getTime()) || appointment.getTime() <= instant.getTime()) return null;
    return appointment;
  }
  if (plan.kind === "interval") {
    if (!Number.isInteger(plan.every) || plan.every <= 0) return null;
    return new Date(instant.getTime() + intervalLength(plan));
  }
  if (plan.kind === "daily" || plan.kind === "weekly") {
    const offset = plan.kind === "weekly" ? (plan.dayOfWeek - instant.getDay() + 7) % 7 : 0;
    const appointment = localClock(instant, plan.timeOfDay, offset);
    if (!appointment) return null;
    if (appointment.getTime() > instant.getTime()) return appointment;
    return localClock(instant, plan.timeOfDay, offset + (plan.kind === "daily" ? 1 : 7));
  }
  return undefined as never;
}

export function computeNextFireAtAfter(plan: ScheduleConfig, appointment: Date): Date | null {
  if (plan.kind === "once") return null;
  if (plan.kind === "daily" || plan.kind === "weekly") {
    return localClock(appointment, plan.timeOfDay, plan.kind === "daily" ? 1 : 7);
  }
  if (plan.kind === "interval") {
    if (!Number.isInteger(plan.every) || plan.every <= 0) return null;
    return new Date(appointment.getTime() + intervalLength(plan));
  }
  return undefined as never;
}

export function normalizeOverdueNextFireAt(plan: ScheduleConfig, appointment: Date, instant: Date): Date | null {
  if (appointment.getTime() > instant.getTime()) return appointment;
  if (plan.kind === "once") return null;
  if (plan.kind === "interval") {
    const spacing = intervalLength(plan);
    if (spacing <= 0) return null;
    const increments = Math.floor((instant.getTime() - appointment.getTime()) / spacing) + 1;
    return new Date(appointment.getTime() + increments * spacing);
  }
  let upcoming: Date | null = appointment;
  let attempts = 0;
  while (upcoming && upcoming.getTime() <= instant.getTime() && attempts < 10_000) {
    upcoming = computeNextFireAtAfter(plan, upcoming);
    attempts++;
  }
  return upcoming && upcoming.getTime() > instant.getTime() ? upcoming : computeInitialNextFireAt(plan, instant);
}
