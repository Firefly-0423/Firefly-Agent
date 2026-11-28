// 桌宠“工作中”信号。
//
// 一次 Agent 运行在第一次工具调用开始时计入活跃工作运行（每次运行只计一次）；
// 运行结束（成功 / 失败 / 取消，由 FireflyAgent 的 finally 收尾）时移除。
// 多个并发运行共享同一计数：计数从 0 变为 >0 发送 true，从 >0 回到 0 发送 false，
// 中间的增减不重复通知，避免并发运行互相覆盖。

export type Live2dWorkSignalSender = (working: boolean) => unknown;

let sender: Live2dWorkSignalSender | null = null;
let activeWorkRuns = 0;

export function setLive2dWorkSignalSender(next: Live2dWorkSignalSender | null): void {
  sender = next;
}

export function getActiveLive2dWorkRunCount(): number {
  return activeWorkRuns;
}

function setActiveWorkRuns(next: number): void {
  const wasWorking = activeWorkRuns > 0;
  activeWorkRuns = Math.max(0, next);
  const working = activeWorkRuns > 0;
  if (working === wasWorking) return;
  try {
    sender?.(working);
  } catch (error) {
    console.warn("[live2d-work-signal] send failed", error);
  }
}

export interface Live2dWorkRunTracker {
  /** 本次运行第一次工具调用开始时调用；同一运行重复调用只计一次。 */
  markToolStarted(): void;
  /** 运行进入任意终态时调用；幂等，未计入时无副作用。 */
  finish(): void;
}

export function createLive2dWorkRunTracker(): Live2dWorkRunTracker {
  let counted = false;
  return {
    markToolStarted() {
      if (counted) return;
      counted = true;
      setActiveWorkRuns(activeWorkRuns + 1);
    },
    finish() {
      if (!counted) return;
      counted = false;
      setActiveWorkRuns(activeWorkRuns - 1);
    },
  };
}
