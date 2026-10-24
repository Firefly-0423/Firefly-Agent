// 定时任务面板的类型与纯函数。
//
// 与设置窗口的 src/renderer/settings/scheduler 口径保持一致（字段、校验规则、
// 主进程 IPC 返回形状），但独立拷贝一份：设置页是另一个 bundle，不能跨包引用。
// 文案统一经 i18n key 输出，校验函数只返回 key，由调用方翻译。

export type Translate = (key: string, options?: Record<string, unknown>) => string;

export type ScheduleConfig =
  | { kind: "once"; runAt: string }
  | { kind: "daily"; timeOfDay: string }
  | { kind: "weekly"; dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6; timeOfDay: string }
  | { kind: "interval"; every: number; unit: "minutes" | "hours" };

export type ScheduleKind = ScheduleConfig["kind"];

export type SchedulerToolMode = "all-enabled" | "allow-list";

export interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  enabled: boolean;
  schedule: ScheduleConfig;
  nextFireAt: string | null;
  lastFiredAt?: string;
  toolMode: SchedulerToolMode;
  allowedToolIds: string[];
  createdAt: string;
  updatedAt: string;
  /** 创建该任务的插件 id；缺失表示用户任务。 */
  ownerPluginId?: string;
  /** 插件任务冻结的会话模式；缺失按 work 执行。 */
  mode?: string;
}

export interface ScheduledTaskHistoryEntry {
  id: string;
  taskId: string;
  taskTitle: string;
  firedAt: string;
  finishedAt?: string;
  durationMs?: number;
  status: "running" | "success" | "failed" | "skipped" | "interrupted";
  hostEpoch?: string;
  executionOutcome?: "unknown";
  externalEffectsMayContinue?: boolean;
  recoveredAt?: string;
  reason?: string;
  outputPreview?: string;
  errorMessage?: string;
  effectiveToolIds: string[];
}

export interface SchedulerToolInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  risk: string;
}

export interface SchedulerResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
  reason?: string;
}

/** preload 暴露的 window.fireflyScheduler 形状（与 src/preload/index.ts 一致）。 */
export interface SchedulerApi {
  list: () => Promise<SchedulerResult<ScheduledTask[]>>;
  add: (input: unknown) => Promise<SchedulerResult<ScheduledTask>>;
  update: (id: string, patch: unknown) => Promise<SchedulerResult<ScheduledTask>>;
  delete: (id: string) => Promise<SchedulerResult<boolean>>;
  toggle: (id: string, enabled: boolean) => Promise<SchedulerResult<ScheduledTask>>;
  fireNow: (id: string) => Promise<SchedulerResult<boolean>>;
  getHistory: (taskId: string, limit?: number) => Promise<SchedulerResult<ScheduledTaskHistoryEntry[]>>;
  getTools: () => Promise<SchedulerResult<SchedulerToolInfo[]>>;
}

export const SCHEDULE_KINDS: ScheduleKind[] = ["once", "daily", "weekly", "interval"];

/** 周一在前的展示顺序；值沿用 Date.getDay() 语义（0 = 周日）。 */
export const WEEK_DAY_ORDER: Array<0 | 1 | 2 | 3 | 4 | 5 | 6> = [1, 2, 3, 4, 5, 6, 0];

export const WEEK_DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** 编辑器表单的原始输入态（与 <input> 的字符串值一一对应）。 */
export interface ScheduleDraft {
  kind: ScheduleKind;
  /** datetime-local 值，YYYY-MM-DDTHH:mm */
  runAt: string;
  /** HH:mm */
  timeOfDay: string;
  dayOfWeek: number;
  /** 间隔数值的输入文本，保存时再解析 */
  every: string;
  unit: "minutes" | "hours";
}

export function defaultScheduleDraft(): ScheduleDraft {
  return { kind: "daily", runAt: "", timeOfDay: "08:00", dayOfWeek: 1, every: "1", unit: "minutes" };
}

/** 将已保存的规格回填为表单态（与设置页 openSchedulerEditor 的回填规则一致）。 */
export function scheduleDraftFromSchedule(schedule: ScheduleConfig): ScheduleDraft {
  const base = { ...defaultScheduleDraft(), kind: schedule.kind };
  switch (schedule.kind) {
    case "once": return { ...base, runAt: toLocalDateTimeInputValue(schedule.runAt) };
    case "daily": return { ...base, timeOfDay: schedule.timeOfDay };
    case "weekly": return { ...base, timeOfDay: schedule.timeOfDay, dayOfWeek: schedule.dayOfWeek };
    case "interval": return { ...base, every: String(schedule.every), unit: schedule.unit };
  }
}

export type ScheduleBuildResult =
  | { ok: true; schedule: ScheduleConfig }
  | { ok: false; errorKey: string };

/**
 * 表单态 → 规格，并做与设置页相同的校验。
 * 失败时返回翻译 key（scheduledPanel.errors.*），由调用方 t() 输出。
 */
export function buildScheduleConfig(draft: ScheduleDraft, now: number): ScheduleBuildResult {
  const fail = (errorKey: string): ScheduleBuildResult => ({ ok: false, errorKey });
  if (draft.kind === "once") {
    if (!draft.runAt) return fail("scheduledPanel.errors.runAtRequired");
    const runAt = new Date(draft.runAt);
    if (Number.isNaN(runAt.getTime())) return fail("scheduledPanel.errors.runAtInvalid");
    if (runAt.getTime() <= now) return fail("scheduledPanel.errors.runAtPast");
    return { ok: true, schedule: { kind: "once", runAt: runAt.toISOString() } };
  }
  if (draft.kind === "weekly") {
    const timeOfDay = draft.timeOfDay || "08:00";
    if (!isValidTimeOfDay(timeOfDay)) return fail("scheduledPanel.errors.weeklyTimeInvalid");
    if (!Number.isInteger(draft.dayOfWeek) || draft.dayOfWeek < 0 || draft.dayOfWeek > 6) {
      return fail("scheduledPanel.errors.dayInvalid");
    }
    return {
      ok: true,
      schedule: { kind: "weekly", dayOfWeek: draft.dayOfWeek as 0 | 1 | 2 | 3 | 4 | 5 | 6, timeOfDay },
    };
  }
  if (draft.kind === "interval") {
    const every = Number(draft.every);
    const unit = draft.unit === "hours" ? "hours" : "minutes";
    if (!Number.isInteger(every) || every <= 0) return fail("scheduledPanel.errors.intervalInvalid");
    if (unit === "minutes" && every > 1440) return fail("scheduledPanel.errors.minuteIntervalTooLarge");
    if (unit === "hours" && every > 168) return fail("scheduledPanel.errors.hourIntervalTooLarge");
    return { ok: true, schedule: { kind: "interval", every, unit } };
  }
  const timeOfDay = draft.timeOfDay || "08:00";
  if (!isValidTimeOfDay(timeOfDay)) return fail("scheduledPanel.errors.dailyTimeInvalid");
  return { ok: true, schedule: { kind: "daily", timeOfDay } };
}

/** 将任意时间字符串转为 <input type="datetime-local"> 需要的本地时间格式 YYYY-MM-DDTHH:mm。 */
export function toLocalDateTimeInputValue(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 校验时间字符串是否为 HH:mm（00:00 ~ 23:59）。 */
export function isValidTimeOfDay(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** 时间值的本地可读形式；空值返回“未安排”，无效值返回“时间无效”。 */
export function formatScheduledTime(value: string | null | undefined, t: Translate): string {
  if (!value) return t("scheduledPanel.unscheduled");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("scheduledPanel.invalidTime");
  return date.toLocaleString();
}

/** 依据规格生成一句话描述（列表项 meta 第一段）。 */
export function describeSchedule(schedule: ScheduleConfig, t: Translate): string {
  if (schedule.kind === "once") return t("scheduledPanel.summaryOnce", { time: formatScheduledTime(schedule.runAt, t) });
  if (schedule.kind === "daily") return t("scheduledPanel.summaryDaily", { time: schedule.timeOfDay });
  if (schedule.kind === "weekly") {
    return t("scheduledPanel.summaryWeekly", {
      day: t(`scheduledPanel.days.${WEEK_DAY_KEYS[schedule.dayOfWeek]}`),
      time: schedule.timeOfDay,
    });
  }
  return t("scheduledPanel.summaryInterval", {
    every: schedule.every,
    unit: t(`scheduledPanel.units.${schedule.unit}`),
  });
}

/** 工具清单的展示文本：插件任务只显示白名单；用户任务未限制时显示“全部已启用工具”。 */
export function describeTaskTools(task: ScheduledTask, t: Translate): string {
  if (!task.ownerPluginId && task.toolMode === "all-enabled") return t("scheduledPanel.allTools");
  return task.allowedToolIds.join(", ") || t("scheduledPanel.noTools");
}

/** 主进程 fireNow 失败原因 → 用户可读文案。 */
export function fireNowErrorMessage(result: { error?: string; reason?: string }, t: Translate): string {
  if (result.reason === "task already running") return t("scheduledPanel.errors.alreadyRunning");
  if (result.reason === "plugin not running") return t("scheduledPanel.errors.pluginNotRunning");
  return result.error ?? result.reason ?? t("scheduledPanel.errors.runFailed");
}
