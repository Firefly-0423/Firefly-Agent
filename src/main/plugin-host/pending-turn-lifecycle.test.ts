import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createPendingTurnLifecycle, type PendingTurnInput } from "./pending-turn-lifecycle";

/** 记录所有发布调用的假发布器，按发生顺序保存。 */
function recorder() {
  const calls: Array<{ kind: "started" | "finished"; event: Record<string, unknown> }> = [];
  return {
    calls,
    started: () => calls.filter((c) => c.kind === "started").map((c) => c.event),
    finished: () => calls.filter((c) => c.kind === "finished").map((c) => c.event),
    publisher: {
      publishTurnStarted: (event: unknown) => void calls.push({ kind: "started", event: event as Record<string, unknown> }),
      publishTurnFinished: (event: unknown) => void calls.push({ kind: "finished", event: event as Record<string, unknown> }),
      publishSchedulerFinished: () => {},
      publishToolFinished: () => {},
    },
  };
}

const turnOf = (over: Partial<PendingTurnInput> = {}): PendingTurnInput => ({
  runId: "r-A",
  conversationId: "conv-A",
  mode: "chat",
  inputMessageId: "in-A",
  assistantMessageId: "out-A",
  startedAt: 1000,
  runTimeoutMs: 10_000,
  ...over,
});

function make(extra: { ackTimeoutMs?: number; graceMs?: number } = {}) {
  const rec = recorder();
  const abandoned: Array<[string, string]> = [];
  const lifecycle = createPendingTurnLifecycle({
    publisher: rec.publisher as never,
    now: () => 1000,
    onAbandon: (runId, reason) => abandoned.push([runId, reason]),
    ...extra,
  });
  return { rec, lifecycle, abandoned };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("开始轮次", () => {
  test("立即发布 turn:started，只含桌面来源的标识字段", () => {
    const { rec, lifecycle } = make();
    lifecycle.beginTurn(turnOf());
    expect(rec.started()).toEqual([
      { source: "desktop", runId: "r-A", mode: "chat", conversationId: "conv-A", inputMessageId: "in-A" },
    ]);
    expect(rec.finished()).toEqual([]);
    expect(lifecycle.pendingCount()).toBe(1);
  });

  test("缺少 inputMessageId：不发布、不占位，并通过 onAbandon 报告", () => {
    const { rec, lifecycle, abandoned } = make();
    lifecycle.beginTurn(turnOf({ inputMessageId: "" }));
    expect(rec.calls).toEqual([]);
    expect(lifecycle.pendingCount()).toBe(0);
    expect(abandoned).toEqual([["r-A", expect.stringContaining("inputMessageId")]]);
  });

  test("多个轮次并存，互不影响", () => {
    const { rec, lifecycle } = make();
    lifecycle.beginTurn(turnOf({ runId: "x", inputMessageId: "ix" }));
    lifecycle.beginTurn(turnOf({ runId: "y", inputMessageId: "iy" }));
    expect(lifecycle.pendingCount()).toBe(2);
    lifecycle.confirmPersistence("x", { finalMessageId: "fx" });
    lifecycle.settleTerminal("x", { status: "success" });
    expect(rec.finished().map((e) => e.runId)).toEqual(["x"]);
    expect(lifecycle.pendingCount()).toBe(1);
  });

  test("相同 runId 重新开始会替换旧轮次，且旧轮次不触发放弃回调", () => {
    const { rec, lifecycle, abandoned } = make();
    lifecycle.beginTurn(turnOf({ inputMessageId: "first" }));
    lifecycle.beginTurn(turnOf({ inputMessageId: "second" }));
    expect(lifecycle.pendingCount()).toBe(1);
    expect(abandoned).toEqual([]);
    lifecycle.confirmPersistence("r-A", {});
    lifecycle.settleTerminal("r-A", { status: "success" });
    expect(rec.finished()).toHaveLength(1);
    expect(rec.finished()[0].inputMessageId).toBe("second");
  });
});

describe("结束事件的合流", () => {
  test("终态先到：确认前不发布，确认后发布并带 finalMessageId", () => {
    const { rec, lifecycle } = make();
    lifecycle.beginTurn(turnOf());
    lifecycle.settleTerminal("r-A", { status: "success", durationMs: 4200 });
    expect(rec.finished()).toEqual([]);
    lifecycle.confirmPersistence("r-A", { finalMessageId: "final-1" });
    expect(rec.finished()).toEqual([
      {
        source: "desktop",
        runId: "r-A",
        mode: "chat",
        conversationId: "conv-A",
        inputMessageId: "in-A",
        finalMessageId: "final-1",
        status: "success",
        durationMs: 4200,
      },
    ]);
    expect(lifecycle.pendingCount()).toBe(0);
  });

  test("确认先到：终态一到就发布", () => {
    const { rec, lifecycle } = make();
    lifecycle.beginTurn(turnOf({ mode: "code" }));
    lifecycle.confirmPersistence("r-A", { finalMessageId: "f" });
    expect(rec.finished()).toEqual([]);
    lifecycle.settleTerminal("r-A", { status: "failure" } as never);
    expect(rec.finished()).toHaveLength(1);
    expect(rec.finished()[0]).toMatchObject({ mode: "code", status: "failure", finalMessageId: "f" });
  });

  test("确认里没有 finalMessageId 时，结束事件也不带该字段（不会用助手占位 id 顶替）", () => {
    const { rec, lifecycle } = make();
    lifecycle.beginTurn(turnOf({ assistantMessageId: "placeholder" }));
    lifecycle.settleTerminal("r-A", { status: "success" });
    lifecycle.confirmPersistence("r-A", {});
    expect(rec.finished()).toHaveLength(1);
    expect("finalMessageId" in rec.finished()[0]).toBe(false);
    expect(JSON.stringify(rec.finished()[0])).not.toContain("placeholder");
  });

  test("没有 durationMs 时结束事件不带该字段", () => {
    const { rec, lifecycle } = make();
    lifecycle.beginTurn(turnOf());
    lifecycle.confirmPersistence("r-A", { finalMessageId: "f" });
    lifecycle.settleTerminal("r-A", { status: "success" });
    expect("durationMs" in rec.finished()[0]).toBe(false);
  });

  test("durationMs 为 0 时仍然保留", () => {
    const { rec, lifecycle } = make();
    lifecycle.beginTurn(turnOf());
    lifecycle.confirmPersistence("r-A", {});
    lifecycle.settleTerminal("r-A", { status: "success", durationMs: 0 });
    expect(rec.finished()[0].durationMs).toBe(0);
  });

  test("重复的终态与确认只发布一次，并且以第一个终态为准", () => {
    const { rec, lifecycle } = make();
    lifecycle.beginTurn(turnOf());
    lifecycle.settleTerminal("r-A", { status: "success" });
    lifecycle.settleTerminal("r-A", { status: "failure" } as never);
    lifecycle.confirmPersistence("r-A", { finalMessageId: "one" });
    lifecycle.confirmPersistence("r-A", { finalMessageId: "two" });
    lifecycle.settleTerminal("r-A", { status: "success" });
    expect(rec.finished()).toHaveLength(1);
    expect(rec.finished()[0]).toMatchObject({ status: "success", finalMessageId: "one" });
  });

  test("终态先到时，之后到达的第二个确认以最新的一个为准（发布前）", () => {
    const { rec, lifecycle } = make();
    lifecycle.beginTurn(turnOf());
    lifecycle.confirmPersistence("r-A", { finalMessageId: "early" });
    lifecycle.confirmPersistence("r-A", { finalMessageId: "late" });
    lifecycle.settleTerminal("r-A", { status: "success" });
    expect(rec.finished()[0].finalMessageId).toBe("late");
  });

  test("发布之后轮次被释放，迟到的调用不再产生事件", () => {
    const { rec, lifecycle, abandoned } = make();
    lifecycle.beginTurn(turnOf());
    lifecycle.confirmPersistence("r-A", {});
    lifecycle.settleTerminal("r-A", { status: "success" });
    vi.advanceTimersByTime(10 * 60_000);
    expect(rec.finished()).toHaveLength(1);
    expect(abandoned).toEqual([]);
  });

  test("未知 runId 的终态与确认被静默忽略", () => {
    const { rec, lifecycle, abandoned } = make();
    lifecycle.settleTerminal("nobody", { status: "success" });
    lifecycle.confirmPersistence("nobody", { finalMessageId: "x" });
    expect(rec.calls).toEqual([]);
    expect(abandoned).toEqual([]);
    expect(lifecycle.pendingCount()).toBe(0);
  });
});

describe("超时与放弃", () => {
  test("终态后确认超时（默认 60 秒）：不发布，轮次清理，回调说明原因", () => {
    const { rec, lifecycle, abandoned } = make();
    lifecycle.beginTurn(turnOf());
    lifecycle.settleTerminal("r-A", { status: "success" });
    vi.advanceTimersByTime(59_999);
    expect(lifecycle.pendingCount()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(lifecycle.pendingCount()).toBe(0);
    expect(rec.finished()).toEqual([]);
    expect(abandoned).toEqual([["r-A", expect.stringContaining("ack")]]);
  });

  test("可自定义确认等待时间", () => {
    const { lifecycle, abandoned } = make({ ackTimeoutMs: 500 });
    lifecycle.beginTurn(turnOf());
    lifecycle.settleTerminal("r-A", { status: "success" });
    vi.advanceTimersByTime(500);
    expect(abandoned).toHaveLength(1);
  });

  test("确认超时后迟到的确认不会再发布", () => {
    const { rec, lifecycle } = make({ ackTimeoutMs: 100 });
    lifecycle.beginTurn(turnOf());
    lifecycle.settleTerminal("r-A", { status: "success" });
    vi.advanceTimersByTime(100);
    lifecycle.confirmPersistence("r-A", { finalMessageId: "too-late" });
    expect(rec.finished()).toEqual([]);
  });

  test("在确认窗口内到达的确认会取消超时计时", () => {
    const { rec, lifecycle, abandoned } = make({ ackTimeoutMs: 1000 });
    lifecycle.beginTurn(turnOf());
    lifecycle.settleTerminal("r-A", { status: "success" });
    vi.advanceTimersByTime(900);
    lifecycle.confirmPersistence("r-A", {});
    vi.advanceTimersByTime(5000);
    expect(rec.finished()).toHaveLength(1);
    expect(abandoned).toEqual([]);
  });

  test("整体期限 = 运行超时 + 宽限：到点即使没有终态也清理", () => {
    const { rec, lifecycle, abandoned } = make({ graceMs: 2000 });
    lifecycle.beginTurn(turnOf({ runTimeoutMs: 3000 }));
    vi.advanceTimersByTime(4999);
    expect(lifecycle.pendingCount()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(lifecycle.pendingCount()).toBe(0);
    expect(abandoned).toEqual([["r-A", expect.stringContaining("expired")]]);
    expect(rec.finished()).toEqual([]);
  });

  test("没有 runTimeoutMs 时期限只有宽限时间", () => {
    const { lifecycle } = make({ graceMs: 700 });
    lifecycle.beginTurn(turnOf({ runTimeoutMs: undefined }));
    vi.advanceTimersByTime(700);
    expect(lifecycle.pendingCount()).toBe(0);
  });

  test("整体期限也会终止已有终态但仍在等待确认的轮次", () => {
    const { rec, lifecycle, abandoned } = make({ ackTimeoutMs: 1_000_000, graceMs: 1000 });
    lifecycle.beginTurn(turnOf({ runTimeoutMs: 1000 }));
    lifecycle.settleTerminal("r-A", { status: "success" });
    vi.advanceTimersByTime(2000);
    expect(lifecycle.pendingCount()).toBe(0);
    expect(abandoned).toHaveLength(1);
    expect(rec.finished()).toEqual([]);
  });
});

describe("主动清理", () => {
  test("disposeEntry 清理指定轮次，不发布也不回调，其他轮次保留", () => {
    const { rec, lifecycle, abandoned } = make();
    lifecycle.beginTurn(turnOf({ runId: "a" }));
    lifecycle.beginTurn(turnOf({ runId: "b" }));
    lifecycle.disposeEntry("a");
    expect(lifecycle.pendingCount()).toBe(1);
    lifecycle.confirmPersistence("a", {});
    lifecycle.settleTerminal("a", { status: "success" });
    vi.advanceTimersByTime(10 * 60_000);
    expect(rec.finished()).toEqual([]);
    expect(abandoned.map(([id]) => id)).toEqual(["b"]);
  });

  test("disposeAll 清空全部轮次且之后计时器不再触发任何事件", () => {
    const { rec, lifecycle, abandoned } = make();
    lifecycle.beginTurn(turnOf({ runId: "a" }));
    lifecycle.beginTurn(turnOf({ runId: "b" }));
    lifecycle.settleTerminal("a", { status: "success" });
    lifecycle.disposeAll();
    expect(lifecycle.pendingCount()).toBe(0);
    vi.advanceTimersByTime(10 * 60_000);
    expect(abandoned).toEqual([]);
    expect(rec.finished()).toEqual([]);
  });

  test("对未知 runId 调用 disposeEntry 是无害的", () => {
    const { lifecycle } = make();
    expect(() => lifecycle.disposeEntry("none")).not.toThrow();
  });
});
