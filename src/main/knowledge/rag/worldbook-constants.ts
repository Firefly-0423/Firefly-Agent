// 世界书的非算法常量集中放这里，便于调参。
// 算法参数（Bu/Bm/γ/λ/α/β 等）由 DmaeParams 管理。

type WorldbookStates = { readonly ACTIVE: "Active"; readonly DORMANT: "Dormant"; readonly ARCHIVED: "Archived" };

export const WORLDBOOK_CONSTANTS: {
  MAX_ACTIVE: number; DEFAULT_INTRINSIC_VALUE: number; MIN_INTRINSIC_VALUE: number;
  EPSILON: number; FLOOR_TRIGGER_STATE: string; STATES: WorldbookStates;
} = {
  // 状态机业务参数
  MAX_ACTIVE: 8,                   // 最终注入条数上限（调度层硬限制）
  DEFAULT_INTRINSIC_VALUE: 60,     // 条目未写内在价值时采用的默认值

  // 数值保护
  MIN_INTRINSIC_VALUE: 1,          // 二次阻力衰减的除零保护
  EPSILON: 0.01,                   // 保持 Rm < D：Rm 被限制在 [0, D - ε]

  // Floor 语义
  FLOOR_TRIGGER_STATE: "Archived", // 只有从 Archived 复活才触发 Floor

  // 状态名称，避免字符串散落
  STATES: { ACTIVE: "Active", DORMANT: "Dormant", ARCHIVED: "Archived" },
};

// 拼接注入 Prompt 时使用的标题与前言
export const INJECTION_HEADER = "【已激活的世界知识】";
export const INJECTION_PREAMBLE =
  "以下内容已由当前用户消息触发，视为原作世界中的已知资料。回复时请自然使用这些信息；原作中的开拓者与当前用户的共同经历必须区分，共同经历只能依据当前对话或有效用户记忆，不得凭世界知识补造。资料有矛盾时应如实说明。";
