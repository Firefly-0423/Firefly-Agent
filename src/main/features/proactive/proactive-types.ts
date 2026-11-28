// 主动聊天共享的数据形状。只含类型，供策略、触发器与服务共用。

export type ProactiveBlockReason =
  | "stale_epoch"
  | "followup_score_too_low"
  | "allowed"
  | "generation_busy"
  | "night_inactive"
  | "unanswered_limit"
  | "disabled"
  | "screen_locked"
  | "conversation_busy"
  | "normal_quiet_period"
  | "global_cooldown"
  | "scene_cooldown"
  | "followup_cooldown"
  | "followup_requires_return";

export interface ProactiveCommitDecision {
  reason: ProactiveBlockReason;
  allowed: boolean;
}

export interface ProactiveCandidate {
  sceneCooldownMs: number;
  sceneId: string;
  score: number;
}

export interface ProactiveState {
  globalDesire: number;
  lastFiredAt: Record<string, number | null>;
  affinity: Record<string, number>;
  lastProactiveScene: string | null;
  proactiveEpoch: number;
  lastNormalConversationEndedAt: number | null;
  lastProactiveAt: number | null;
  unansweredCount: 0 | 1 | 2;
}

export interface ProactiveRuntimeSnapshot {
  localHour: number;
  /** 墙上时钟必须取用户指定时区，不能读本机时区。 */
  localMinute: number;
  now: number;
  idleSec: number;
  enabled: boolean;
  generationBusy: boolean;
  conversationBusy: boolean;
  screenLocked: boolean;
}
