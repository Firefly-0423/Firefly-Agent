// 主动聊天的硬性门禁与状态迁移。门禁按固定顺序检查：先看运行环境，再看未回复与冷却。
import { isWithinQuietHours } from "./proactive-clock";
import type { ProactiveBlockReason, ProactiveCandidate, ProactiveCommitDecision, ProactiveRuntimeSnapshot, ProactiveState } from "./proactive-types";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export const NORMAL_QUIET_MS = 30 * MINUTE_MS;
export const GLOBAL_PROACTIVE_INTERVAL_MS = 2 * HOUR_MS;
export const FOLLOWUP_INTERVAL_MS = 12 * HOUR_MS;
export const NIGHT_ACTIVE_IDLE_LIMIT_SEC = 60;
export const FOLLOWUP_MIN_SCORE = 75;

const passDecision = (): ProactiveCommitDecision => ({ allowed: true, reason: "allowed" });
const denyWith = (reason: ProactiveBlockReason): ProactiveCommitDecision => ({ allowed: false, reason });

export function createDefaultProactiveState(): ProactiveState {
  const fresh = {} as ProactiveState;
  fresh.proactiveEpoch = 0;
  fresh.unansweredCount = 0;
  fresh.lastProactiveAt = null;
  fresh.lastProactiveScene = null;
  fresh.lastNormalConversationEndedAt = null;
  fresh.globalDesire = 0;
  fresh.affinity = {};
  fresh.lastFiredAt = {};
  return fresh;
}

/** 夜间判断只复用 proactive-clock 中的静默时段规则，本文件不另写时间边界。 */
function inQuietWallClock(snapshot: ProactiveRuntimeSnapshot): boolean {
  return isWithinQuietHours(snapshot.localHour * 60 + snapshot.localMinute);
}

type Guard = (
  snapshot: ProactiveRuntimeSnapshot,
  state: ProactiveState,
  candidate: ProactiveCandidate,
) => ProactiveBlockReason | null;

/** 按顺序检查，第一个命中的拦截原因胜出。 */
const startGuards: Guard[] = [
  (snap) => (snap.enabled ? null : "disabled"),
  (snap) => (snap.screenLocked ? "screen_locked" : null),
  (snap) => (snap.conversationBusy ? "conversation_busy" : null),
  (snap) => (snap.generationBusy ? "generation_busy" : null),
  (snap) => (inQuietWallClock(snap) && snap.idleSec >= NIGHT_ACTIVE_IDLE_LIMIT_SEC ? "night_inactive" : null),
  (_snap, state) => (state.unansweredCount >= 2 ? "unanswered_limit" : null),
  (snap, state) => (
    state.lastNormalConversationEndedAt !== null
    && snap.now - state.lastNormalConversationEndedAt < NORMAL_QUIET_MS
      ? "normal_quiet_period"
      : null
  ),
  (snap, state) => (
    state.lastProactiveAt !== null && snap.now - state.lastProactiveAt < GLOBAL_PROACTIVE_INTERVAL_MS
      ? "global_cooldown"
      : null
  ),
  (snap, state, cand) => {
    const lastFired = state.lastFiredAt[cand.sceneId];
    return typeof lastFired === "number" && snap.now - lastFired < cand.sceneCooldownMs ? "scene_cooldown" : null;
  },
  (snap, state, cand) => {
    if (state.unansweredCount !== 1) return null;
    if (state.lastProactiveAt !== null && snap.now - state.lastProactiveAt < FOLLOWUP_INTERVAL_MS) {
      return "followup_cooldown";
    }
    // trigger 只在新的离开后返回边沿产生此候选；上一次也可以是返回场景。
    if (cand.sceneId !== "back_from_away") return "followup_requires_return";
    if (cand.score < FOLLOWUP_MIN_SCORE) return "followup_score_too_low";
    return null;
  },
];

export function canStartProactiveGeneration(snapshot: ProactiveRuntimeSnapshot, state: ProactiveState, candidate: ProactiveCandidate): ProactiveCommitDecision {
  for (const guard of startGuards) {
    const blocked = guard(snapshot, state, candidate);
    if (blocked) return denyWith(blocked);
  }
  return passDecision();
}

export function canCommitProactiveMessage(snapshot: ProactiveRuntimeSnapshot, state: ProactiveState, candidate: ProactiveCandidate, generationEpoch: number): ProactiveCommitDecision {
  if (generationEpoch !== state.proactiveEpoch) return denyWith("stale_epoch");
  return canStartProactiveGeneration(snapshot, state, candidate);
}

export function markUserActivity(state: ProactiveState): void {
  state.unansweredCount = 0;
  state.proactiveEpoch += 1;
}

export function markNormalConversationStarted(state: ProactiveState): void {
  state.proactiveEpoch += 1;
}

export function markNormalConversationEnded(state: ProactiveState, now: number): void {
  state.globalDesire = 0;
  state.lastNormalConversationEndedAt = now;
  state.proactiveEpoch += 1;
}

export function markProactiveCommitted(state: ProactiveState, candidate: ProactiveCandidate, now: number): void {
  state.globalDesire = 0;
  state.lastFiredAt[candidate.sceneId] = now;
  state.lastProactiveScene = candidate.sceneId;
  state.lastProactiveAt = now;
  state.unansweredCount = Math.min(2, state.unansweredCount + 1) as 0 | 1 | 2;
}
