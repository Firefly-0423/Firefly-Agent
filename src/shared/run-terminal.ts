/**
 * Run 终态与 ACK 的共享类型（仅类型，三端均可引用）。
 *
 * 依据 @ag-ui/core@0.0.57：RUN_FINISHED.result 是可选 any，outcome 只支持
 * success/interrupt，所以 cancelled / timeout 只写入 result 而不写 outcome；
 * runtime error 仍走 RUN_ERROR，但同样要经过「只结算一次」的 gate，
 * gate 内部统一记作 runtime_error（已冻结的边界名）。
 */

/** 规范终态：FireflyAgent、Harness、Bridge 三方共用 */
export type FireflyTerminalStatus = "success" | "cancelled" | "timeout" | "runtime_error";

/**
 * RUN_FINISHED.result 与 FireflyAgent 内部终态共用的描述：
 * success 正常完成；cancelled 用户或上游取消；timeout 总超时或触顶 max_rounds；
 * runtime_error 仅用于异常路径（事件仍是 RUN_ERROR，gate 内统一记账）。
 */
export interface FireflyRunTerminalResult {
  status: FireflyTerminalStatus;
  /** 机器可读原因码，如 max_rounds / call_timeout / user_cancelled / run_timeout */
  reason?: string;
  /** 仅含来源元数据，不带异常消息、供应商响应体或工具输出 */
  errorSource?: import("./run-failure").RunFailureSource;
  /**
   * 冻结的约定：渲染端据此判断能否假定 run 已干净结束，调用方必须显式给出。
   * 无遗留不确定项的正常成功为 false；成功但仍有 uncertainEffects、
   * 以及 cancelled / timeout / runtime_error 均为 true（偏保守）。
   */
  externalEffectsMayContinue: boolean;
}

/**
 * AGUI_RUN 调用立即返回的 ACK。
 * 渲染端拿到 runId 后可与 RUN_STARTED 校验一致、在其到达前就发起取消，
 * 并在终态事件到达前把它当作占位 runId。终态仍由事件流承载，
 * success=false 仅表示 run 没能开始（例如缺少 sessionId）。
 */
export interface AguiRunAck {
  success: boolean;
  /** Bridge 创建的 runId，与 RUN_STARTED.runId 一致 */
  runId: string;
  /** success=false 时的原因，不暴露内部细节 */
  error?: string;
}
