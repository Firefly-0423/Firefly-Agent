// Live2D 共享类型与表情常量。表情名以 Firefly.model3.json 自带的表情为准（expression00 ... expression10）。
// 旧的“别名目录 / LLM 工具触发动作”体系已废弃；表情规则如下：
//   - 默认基础表情 expression00；工作中（工具调用期间）基础表情 expression6。
//   - 双击头部 / 身体触发的临时表情由渲染端 interaction 按权重选取（见 renderer/live2d/interaction.ts）。

export type Live2DTarget =
  | { kind: "motion"; group: string; motionName: string }
  | { kind: "expression"; name: string };

export type Live2DExpressionTarget = Extract<Live2DTarget, { kind: "expression" }>;

/** 默认基础表情（模型自带 expression00）。 */
export const LIVE2D_DEFAULT_EXPRESSION = "expression00";

/** 工作中（工具调用期间）保持的基础表情。 */
export const LIVE2D_WORKING_EXPRESSION = "expression6";
