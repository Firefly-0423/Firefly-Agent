// 主动聊天的定时候选器：每分钟附近醒来一次，给出一个分数最高的场景交给 service。
// 时间判断一律使用用户时区。天气场景目前只保留占位，外部缓存接入后再补齐生成逻辑。

import { getZonedDateParts } from "./proactive-clock";
import type { ProactiveCandidate, ProactiveRuntimeSnapshot, ProactiveState } from "./proactive-types";

export { getZonedDateParts } from "./proactive-clock";

/** 天气上下文占位，字段待缓存模块定义。 */
export interface WeatherContext {
  readonly _placeholder?: never;
}

/** 单次评估所需的全部输入，打包后便于纯计算。 */
export interface ProactiveTriggerContext {
  now: number;
  timezone: string;
  localDate: string;
  localHour: number;
  localMinute: number;
  snapshot: ProactiveRuntimeSnapshot;
  state: ProactiveState;
  /** 上一轮记录的 idle 秒数，首轮为 null。 */
  previousIdleSec: number | null;
  /** 当前连续活跃段的开始时间，空闲超过阈值后清空。 */
  activeSessionStartedAt: number | null;
  weather: WeatherContext | null;
}

type Opportunity = {
  score: number;
  reason: string;
  sceneId: string;
  sceneCooldownMs: number;
};

export interface ProactiveTriggerDependencies {
  /** 取用户时区，调用前已校验。 */
  getTimezone: () => string;
  getProactiveState: () => ProactiveState;
  getRuntimeSnapshot: () => ProactiveRuntimeSnapshot;
  evaluateCandidate: (candidate: ProactiveCandidate) => Promise<unknown>;
  setLastEvaluatedAtByScene: (next: Map<string, number>) => void;
  getLastEvaluatedAtByScene: () => Map<string, number>;
  /** 天气缓存未接入时可省略；返回 null 或空对象都不产生天气候选。 */
  getWeatherContext?: () => WeatherContext | null;
}

export interface ProactiveTriggerController {
  start(): void;
  stop(): void;
  /** 绕过定时器立即评估一轮。 */
  evaluateNow(reason?: string): Promise<void>;
}

// ── 常量 ──────────────────────────────────────────────────────────────
const CYCLE_MS = 60_000;
const BOOT_DELAY_MS = 90_000;
const JITTER_CEILING_MS = 10_000;

const RETRY_GAP_MS = 30 * 60 * 1000;
const SCORE_FLOOR = 60;

const AWAY_MIN_SEC = 30 * 60;
const IDLE_CEILING_SEC = 60;
const WORK_BREAK_FLOOR_MS = 90 * 60 * 1000;

const HALF_HOUR_MS = 30 * 60 * 1000;
const TWO_HOUR_MS = 2 * 60 * 60 * 1000;

const LOG_TAG = "[ProactiveTrigger]";
const DAY_MINUTES = 1440;

const WEATHER_SCENE_IDS = ["weather_rain", "weather_temperature_drop", "weather_sunny"] as const;

const clampInto = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));

/** 用户时区下的 YYYY-MM-DD。 */
function localDateStamp(date: Date, timezone: string): string {
  const parts = getZonedDateParts(date, timezone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/**
 * 时间窗口贴合分（0-15）。窗口为 [startMin, endMin] 分钟区间，endMin 小于 startMin 时视为跨午夜。
 * 越接近窗口中心分越高，到边缘线性降到 0，窗口之外为 0。
 */
function windowFit(hour: number, minute: number, startMin: number, endMin: number): number {
  const at = hour * 60 + minute;
  const crosses = endMin < startMin;
  let distance: number;
  if (!crosses) {
    if (at < startMin || at > endMin) return 0;
    distance = Math.abs(at - (startMin + endMin) / 2);
  } else {
    if (!(at >= startMin || at <= endMin)) return 0;
    const unwrappedEnd = endMin + DAY_MINUTES;
    const mid = startMin <= 720
      ? (startMin + unwrappedEnd) / 2
      : (startMin + unwrappedEnd) / 2 - DAY_MINUTES;
    const probe = at >= startMin ? at : at + DAY_MINUTES;
    distance = Math.abs(probe - mid);
  }
  const span = crosses ? (DAY_MINUTES - startMin) + endMin : endMin - startMin;
  const halfSpan = span / 2;
  if (halfSpan <= 0) return at >= startMin && at <= endMin ? 15 : 0;
  return clampInto(Math.round((1 - distance / halfSpan) * 15), 0, 15);
}

/** 事件紧迫度（0-20）：离开或连续活跃越久，分越高。 */
function urgencyFor(sceneId: string, ctx: ProactiveTriggerContext): number {
  if (sceneId === "back_from_away") {
    const awaySec = ctx.previousIdleSec;
    if (awaySec === null || !(awaySec >= AWAY_MIN_SEC)) return 0;
    return clampInto(Math.round(4 + 4 * Math.log2(awaySec / AWAY_MIN_SEC)), 0, 20);
  }
  if (sceneId === "work_break") {
    const activeMs = ctx.activeSessionStartedAt !== null ? ctx.now - ctx.activeSessionStartedAt : 0;
    if (activeMs < WORK_BREAK_FLOOR_MS) return 0;
    const steps = Math.round((activeMs - WORK_BREAK_FLOOR_MS) / (30 * 60 * 1000));
    return clampInto(steps * 4, 0, 20);
  }
  return 0;
}

/** 新鲜度奖励目前恒为 0，为天气缓存预留。 */
function freshnessFor(_sceneId: string): number {
  return 0;
}

/**
 * 沉默奖励（0-12）。从未有过任何活动的用户直接给满分，保证首次启动能够触发。
 */
function silenceFor(ctx: ProactiveTriggerContext): number {
  const anchor = ctx.state.lastNormalConversationEndedAt !== null
    ? ctx.state.lastNormalConversationEndedAt
    : ctx.state.lastProactiveAt;
  if (anchor === null) return 12;
  const gap = ctx.now - anchor;
  if (gap < HALF_HOUR_MS) return 0;
  if (gap >= TWO_HOUR_MS) return 12;
  const progress = (gap - HALF_HOUR_MS) / (TWO_HOUR_MS - HALF_HOUR_MS);
  return clampInto(Math.round(progress * 12), 0, 12);
}

/** 未回复扣分：一次扣 15，新的返回仍须满足 policy 的 12h 间隔和 75 分门槛；两次及以上扣 100。 */
function penaltyFor(count: 0 | 1 | 2): number {
  switch (count) {
    case 0: return 0;
    case 1: return -15;
    default: return -100;
  }
}

/** 把各个分量加总并夹到 0-100。 */
function totalScore(base: number, fit: number, urgency: number, sceneId: string, ctx: ProactiveTriggerContext): number {
  const sum = base + fit + urgency + freshnessFor(sceneId) + silenceFor(ctx) + penaltyFor(ctx.state.unansweredCount);
  return clampInto(sum, 0, 100);
}

// ── 场景表 ────────────────────────────────────────────────────────────
interface SceneSpec {
  sceneId: string;
  baseScore: number;
  sceneCooldownMs: number;
  /** tie-break 优先级，数值越小越先选。 */
  priority: number;
  evaluate(ctx: ProactiveTriggerContext): { fit: number; urgency: number; applicable: boolean };
}

function scoreWindow(ctx: ProactiveTriggerContext, from: number, to: number) {
  const fit = windowFit(ctx.localHour, ctx.localMinute, from, to);
  return { fit, urgency: 0, applicable: fit > 0 };
}

const SCENE_TABLE: readonly SceneSpec[] = [
  {
    priority: 4,
    baseScore: 52,
    sceneId: "morning_greeting",
    sceneCooldownMs: 23 * 60 * 60 * 1000,
    evaluate: (ctx) => scoreWindow(ctx, 7 * 60, 10 * 60 + 30),
  },
  {
    priority: 4,
    baseScore: 44,
    sceneId: "evening_checkin",
    sceneCooldownMs: 8 * 60 * 60 * 1000,
    evaluate: (ctx) => scoreWindow(ctx, 18 * 60, 22 * 60),
  },
  {
    sceneId: "back_from_away",
    baseScore: 68,
    sceneCooldownMs: 4 * 60 * 60 * 1000,
    priority: 1,
    evaluate(ctx) {
      if (ctx.previousIdleSec === null) return { fit: 0, urgency: 0, applicable: false };
      const applicable = ctx.previousIdleSec >= AWAY_MIN_SEC && ctx.snapshot.idleSec < IDLE_CEILING_SEC;
      return { fit: 0, urgency: urgencyFor("back_from_away", ctx), applicable };
    },
  },
  {
    baseScore: 56,
    sceneId: "work_break",
    sceneCooldownMs: 3 * 60 * 60 * 1000,
    priority: 2,
    evaluate(ctx) {
      if (ctx.activeSessionStartedAt === null) return { fit: 0, urgency: 0, applicable: false };
      const elapsed = ctx.now - ctx.activeSessionStartedAt;
      return { fit: 0, urgency: urgencyFor("work_break", ctx), applicable: elapsed >= WORK_BREAK_FLOOR_MS };
    },
  },
];

// ── 候选生成与排序 ────────────────────────────────────────────────────
function timeBasedOpportunities(ctx: ProactiveTriggerContext): Opportunity[] {
  const found: Opportunity[] = [];
  for (const spec of SCENE_TABLE) {
    const verdict = spec.evaluate(ctx);
    if (!verdict.applicable) continue;
    const score = totalScore(spec.baseScore, verdict.fit, verdict.urgency, spec.sceneId, ctx);
    if (score < SCORE_FLOOR) continue;
    found.push({
      sceneId: spec.sceneId,
      score,
      sceneCooldownMs: spec.sceneCooldownMs,
      reason: `base=${spec.baseScore} fit=${verdict.fit} urgency=${verdict.urgency}`,
    });
  }
  return found;
}

/** 天气候选占位：没有有效上下文时不产生任何候选，有上下文也暂不生成。 */
function weatherBasedOpportunities(_ctx: ProactiveTriggerContext, weather: WeatherContext | null): Opportunity[] {
  if (!weather || typeof weather !== "object") return [];
  if (Object.keys(weather).length === 0) return [];
  return [];
}

function allOpportunities(ctx: ProactiveTriggerContext): Opportunity[] {
  return [...timeBasedOpportunities(ctx), ...weatherBasedOpportunities(ctx, ctx.weather)];
}

/** 先按优先级排序，同优先级保持输入顺序。 */
function rankOpportunities(opps: Opportunity[]): Opportunity[] {
  const rank = new Map<string, number>();
  for (const spec of SCENE_TABLE) rank.set(spec.sceneId, spec.priority);
  for (const id of WEATHER_SCENE_IDS) {
    if (!rank.has(id)) rank.set(id, 3);
  }
  const position = new Map<Opportunity, number>();
  opps.forEach((opp, index) => position.set(opp, index));
  const priorityOf = (opp: Opportunity) => rank.get(opp.sceneId) ?? 99;
  return [...opps].sort((x, y) => {
    const gap = priorityOf(x) - priorityOf(y);
    if (gap !== 0) return gap;
    return (position.get(x) as number) - (position.get(y) as number);
  });
}

/** 快速过滤：这些状态下连评估都不做，细粒度判断仍交给 policy。 */
function isFastBlocked(snapshot: ProactiveRuntimeSnapshot): boolean {
  return !snapshot.enabled
    || snapshot.screenLocked
    || snapshot.conversationBusy
    || snapshot.generationBusy;
}

// ── 控制器 ────────────────────────────────────────────────────────────
export function createProactiveTrigger(deps: ProactiveTriggerDependencies): ProactiveTriggerController {
  let handle: ReturnType<typeof setTimeout> | null = null;
  let busy = false;
  let halted = true;

  let lastIdleSec: number | null = null;
  let activeStart: number | null = null;

  const emit = (event: string, detail?: unknown): void => {
    console.log(`${LOG_TAG} ${event}`, detail ?? "");
  };

  const randomJitter = (): number => Math.floor(Math.random() * JITTER_CEILING_MS);

  function armTimer(delayMs: number): void {
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => { void runCycle(); }, delayMs);
  }

  function scheduleNext(): void {
    if (halted) return;
    armTimer(CYCLE_MS + randomJitter());
  }

  async function evaluateNow(reason: string): Promise<void> {
    const snapshot = deps.getRuntimeSnapshot();
    if (isFastBlocked(snapshot)) return;

    const state = deps.getProactiveState();
    const timezone = deps.getTimezone();
    const when = new Date(snapshot.now);
    const localParts = getZonedDateParts(when, timezone);
    const weather = deps.getWeatherContext?.() ?? null;

    if (snapshot.idleSec >= IDLE_CEILING_SEC) {
      activeStart = null;
    } else if (activeStart === null) {
      activeStart = snapshot.now;
    }

    const ctx: ProactiveTriggerContext = {
      now: snapshot.now,
      timezone,
      localDate: localDateStamp(when, timezone),
      snapshot,
      state,
      localHour: localParts.hour,
      localMinute: localParts.minute,
      previousIdleSec: lastIdleSec,
      activeSessionStartedAt: activeStart,
      weather,
    };

    const passing = allOpportunities(ctx).filter((opp) => opp.score >= SCORE_FLOOR);
    const ranked = rankOpportunities(passing);

    if (ranked.length === 0) {
      lastIdleSec = snapshot.idleSec;
      return;
    }

    const evaluatedAt = deps.getLastEvaluatedAtByScene();
    const eligible = ranked.filter((opp) => {
      const previous = evaluatedAt.get(opp.sceneId);
      if (typeof previous === "number" && snapshot.now - previous < RETRY_GAP_MS) {
        emit("skipped scene=" + opp.sceneId + " reason=evaluation_backoff", { reason });
        return false;
      }
      return true;
    });

    if (eligible.length === 0) {
      lastIdleSec = snapshot.idleSec;
      return;
    }

    const chosen = eligible[0];
    emit("selected", { sceneId: chosen.sceneId, score: chosen.score, reason });

    evaluatedAt.set(chosen.sceneId, snapshot.now);
    deps.setLastEvaluatedAtByScene(evaluatedAt);

    try {
      await deps.evaluateCandidate({
        sceneId: chosen.sceneId,
        score: chosen.score,
        sceneCooldownMs: chosen.sceneCooldownMs,
      });
    } catch (err) {
      emit("evaluation_failed", { sceneId: chosen.sceneId, error: err instanceof Error ? err.message : String(err) });
    } finally {
      lastIdleSec = snapshot.idleSec;
    }
  }

  async function runCycle(): Promise<void> {
    if (halted) return;
    if (busy) {
      scheduleNext();
      return;
    }
    busy = true;
    try {
      await evaluateNow("timer");
    } catch (err) {
      emit("tick_failed", err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
      scheduleNext();
    }
  }

  function start(): void {
    if (!halted) return;
    halted = false;
    if (handle) { clearTimeout(handle); handle = null; }
    handle = setTimeout(() => { void runCycle(); }, BOOT_DELAY_MS);
  }

  function stop(): void {
    halted = true;
    if (handle) { clearTimeout(handle); handle = null; }
  }

  return { start, stop, evaluateNow };
}

// ── 测试用常量导出 ────────────────────────────────────────────────────
export const TRIGGER_CONSTANTS = {
  TRIGGER_INTERVAL_MS: CYCLE_MS,
  INITIAL_DELAY_MS: BOOT_DELAY_MS,
  INTERVAL_JITTER_MS: JITTER_CEILING_MS,
  EVALUATION_RETRY_MS: RETRY_GAP_MS,
  MIN_EVALUATION_SCORE: SCORE_FLOOR,
  AWAY_THRESHOLD_SEC: AWAY_MIN_SEC,
  ACTIVE_THRESHOLD_SEC: IDLE_CEILING_SEC,
  WORK_BREAK_MIN_MS: WORK_BREAK_FLOOR_MS,
  WEATHER_SCENE_IDS,
} as const;
