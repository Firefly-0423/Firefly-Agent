// 各调用场景的超时配置，按场景命名而不是按数值归并。
// 单次调用传入的 override 只替换它给出的字段。

export type RuntimeTimeoutStage =
  | "memory-llm"
  | "tool-execution"
  | "asr-mossland"
  | "external-http"
  | "vision-caption";

export interface TimeoutPolicy {
  /** 总超时，毫秒 */
  totalMs: number;
  /** 首包等待上限，毫秒（尚未启用） */
  firstResponseMs?: number;
  /** 相邻数据块的最大间隔，毫秒（尚未启用） */
  idleMs?: number;
}

export interface ResolveTimeoutPolicyOptions {
  stage: RuntimeTimeoutStage;
  /** 只覆盖给出的字段 */
  override?: Partial<TimeoutPolicy>;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

// 数值沿用原有各模块里的现行取值
const defaultsByStage: Record<RuntimeTimeoutStage, TimeoutPolicy> = {
  "memory-llm": { totalMs: 30 * SECOND },
  "tool-execution": { totalMs: 5 * MINUTE },
  "asr-mossland": { totalMs: 30 * SECOND },
  "external-http": { totalMs: 30 * SECOND },
  "vision-caption": { totalMs: 30 * SECOND },
};

export function resolveTimeoutPolicy(options: ResolveTimeoutPolicyOptions): TimeoutPolicy {
  const base = defaultsByStage[options.stage];
  const patch = options.override;
  if (patch === undefined) return base;

  return {
    totalMs: patch.totalMs ?? base.totalMs,
    firstResponseMs: patch.firstResponseMs ?? base.firstResponseMs,
    idleMs: patch.idleMs ?? base.idleMs,
  };
}

/** 读取某阶段的完整策略，仅供诊断 */
export function getStageTimeoutPolicy(stage: RuntimeTimeoutStage): Readonly<TimeoutPolicy> {
  return defaultsByStage[stage];
}
