/**
 * 一次性结算闸门：确保同一个 run 只记账一个终态。
 *
 * 负责的事情：
 * - 一个 run 的生命周期内，只接受第一份 FireflyRunTerminalResult 作为记账结果；
 * - 之后的 trySettle（例如 success 之后又来 error，或 cancelled 之后又来 timeout）
 *   一律悄悄丢弃，是否写诊断日志由调用方自己决定。
 *
 * 不负责的事情：
 * - 不判断 completion 或 continue_agent；
 * - 不改写 RUN_FINISHED.result 的结构，只做记账；
 * - 不消费 ExecutionLedger 或 UncertainEffectGuard；
 * - 不参与取消传播，取消由各 run 的 AbortController 处理（见 agui-bridge）。
 *
 * 调用方：
 * - agui-bridge 的 complete 与 error 两个回调在转发终态事件前都会先调用 trySettle，
 *   只有第一个到达的那次会真正发出 RUN_FINISHED 或 RUN_ERROR。
 * - 单元测试直接实例化 RunSettlementGate 来验证状态流转。
 */

import type { FireflyRunTerminalResult } from "../../shared/run-terminal";

export class RunSettlementGate {
  private settlement: FireflyRunTerminalResult | null = null;

  /**
   * 尝试登记一个终态结算。
   * @returns true 表示这是第一次结算（调用方应据此发出终态事件）；
   *          false 表示已经有终态被记账，本次调用被丢弃。
   */
  trySettle(result: FireflyRunTerminalResult): boolean {
    const alreadyRecorded = Boolean(this.settlement);
    if (alreadyRecorded) return false;
    this.settlement = result;
    return true;
  }

  /** 读取已记账的终态；还没有结算时是 null。 */
  get(): FireflyRunTerminalResult | null {
    const { settlement } = this;
    return settlement;
  }

  /** 是否已经有终态被记账。 */
  isSettled(): boolean {
    return !(this.settlement === null);
  }
}


export type SRunSettlementState = "open" | "cancel_requested" | "success_reserved" | "interrupted_reserved" | "success" | "interrupted" | "unknown";
type SResult = "success" | "interrupted";
/** Main-only dispatch reservation; durable confirmation comes exclusively from the S sink. */
export class SRunSettlementGate {
  private candidate: SResult | null = null;
  private phase: "open" | "reserved" | "confirmed" | "unknown" = "open";
  private cancelRequested = false;
  requestCancel(): boolean {
    if (this.phase !== "open")
      return false;
    this.cancelRequested = true;
    return true;
  }
  reserve(result: SResult): boolean {
    if (this.phase !== "open" || result !== "success" && result !== "interrupted" || result === "success" && this.cancelRequested)
      return false;
    this.candidate = result;
    this.phase = "reserved";
    return true;
  }
  confirm(result: SResult): boolean {
    if (this.phase !== "reserved" && this.phase !== "unknown" || this.candidate !== result)
      return false;
    this.phase = "confirmed";
    return true;
  }
  markUnknown(): boolean {
    if (this.phase !== "reserved")
      return false;
    this.phase = "unknown";
    return true;
  }
  get(): SRunSettlementState {
    if (this.phase === "open")
      return this.cancelRequested ? "cancel_requested" : "open";
    if (this.phase === "unknown")
      return "unknown";
    if (this.phase === "reserved")
      return this.candidate === "success" ? "success_reserved" : "interrupted_reserved";
    return this.candidate!;
  }
}
