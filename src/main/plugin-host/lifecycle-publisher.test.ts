import { afterEach, describe, expect, test, vi } from "vitest";
import { createLifecyclePublisher } from "./lifecycle-publisher";

type Sent = { name: string; body: Record<string, unknown> };

function harness(publishImpl?: (name: string, body: unknown) => Promise<void>) {
  const sent: Sent[] = [];
  let seq = 0;
  const publisher = createLifecyclePublisher({
    publish: async (name, body) => {
      sent.push({ name, body: body as Record<string, unknown> });
      if (publishImpl) await publishImpl(name, body);
    },
    eventId: () => `evt-${++seq}`,
    now: () => new Date(Date.UTC(2030, 0, 2, 3, 4, 5)),
  });
  return { publisher, sent };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("事件名与载荷", () => {
  test("turn:started（桌面来源）保留来源专属字段", () => {
    const { publisher, sent } = harness();
    publisher.publishTurnStarted({
      source: "desktop",
      conversationId: "c-1",
      inputMessageId: "m-1",
    } as never);
    expect(sent).toEqual([
      {
        name: "turn:started",
        body: {
          source: "desktop",
          conversationId: "c-1",
          inputMessageId: "m-1",
          eventId: "evt-1",
          timestamp: "2030-01-02T03:04:05.000Z",
        },
      },
    ]);
  });

  test("turn:started 对通道与调度来源同样原样转发各自字段", () => {
    const { publisher, sent } = harness();
    publisher.publishTurnStarted({ source: "channel", channel: "tg" } as never);
    publisher.publishTurnStarted({ source: "scheduler", taskId: "t", schedulerRunId: "r" } as never);
    expect(sent[0].body).toMatchObject({ source: "channel", channel: "tg" });
    expect(sent[1].body).toMatchObject({ source: "scheduler", taskId: "t", schedulerRunId: "r" });
    expect(sent.map((s) => s.name)).toEqual(["turn:started", "turn:started"]);
  });

  test("turn:finished、scheduler:finished、tool:finished 各自使用对应事件名", () => {
    const { publisher, sent } = harness();
    publisher.publishTurnFinished({ source: "desktop", status: "success" } as never);
    publisher.publishSchedulerFinished({ taskId: "t", schedulerRunId: "r", status: "failure", durationMs: 12 });
    publisher.publishToolFinished({
      runId: "run",
      toolId: "fs.read",
      toolCallId: "tc",
      status: "success",
      risk: "fs-read",
    });
    expect(sent.map((s) => s.name)).toEqual(["turn:finished", "scheduler:finished", "tool:finished"]);
    expect(sent[1].body).toMatchObject({ taskId: "t", durationMs: 12 });
    expect(sent[2].body).toMatchObject({ toolId: "fs.read", risk: "fs-read" });
  });

  test("每个事件拿到各自唯一的 eventId", () => {
    const { publisher, sent } = harness();
    for (let i = 0; i < 3; i++) {
      publisher.publishSchedulerFinished({ taskId: `t${i}`, schedulerRunId: "r", status: "success" });
    }
    expect(sent.map((s) => s.body.eventId)).toEqual(["evt-1", "evt-2", "evt-3"]);
  });

  test("不修改调用方传入的对象", () => {
    const { publisher } = harness();
    const input = { taskId: "t", schedulerRunId: "r", status: "success" as const };
    publisher.publishSchedulerFinished(input);
    expect(input).toEqual({ taskId: "t", schedulerRunId: "r", status: "success" });
  });
});

describe("元数据由宿主决定", () => {
  test("调用方塞入的 eventId/timestamp 被覆盖（四类事件都一样）", () => {
    const { publisher, sent } = harness();
    const forged = { eventId: "forged", timestamp: "1999-01-01T00:00:00.000Z" };
    publisher.publishTurnStarted({ source: "channel", channel: "x", ...forged } as never);
    publisher.publishTurnFinished({ source: "desktop", status: "success", ...forged } as never);
    publisher.publishSchedulerFinished({ taskId: "t", schedulerRunId: "r", status: "success", ...forged });
    publisher.publishToolFinished({
      runId: "r",
      toolId: "t",
      toolCallId: "c",
      status: "failure",
      risk: "shell",
      ...forged,
    });
    for (const { body } of sent) {
      expect(body.eventId).toMatch(/^evt-\d$/);
      expect(body.timestamp).toBe("2030-01-02T03:04:05.000Z");
    }
  });

  test("未注入生成器时使用 UUID 与当前时间", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-05-06T07:08:09.000Z"));
    try {
      const publish = vi.fn(async () => undefined);
      const publisher = createLifecyclePublisher({ publish });
      publisher.publishSchedulerFinished({ taskId: "t", schedulerRunId: "r", status: "success" });
      publisher.publishSchedulerFinished({ taskId: "t", schedulerRunId: "r", status: "success" });
      const [a, b] = publish.mock.calls.map((c) => (c as unknown as [string, Record<string, string>])[1]);
      expect(a.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(a.eventId).not.toBe(b.eventId);
      expect(a.timestamp).toBe("2031-05-06T07:08:09.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("失败隔离", () => {
  test("异步发布失败只产生告警，调用不抛出也不产生未处理拒绝", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { publisher } = harness(async () => {
      throw new Error("bus down");
    });
    expect(() =>
      publisher.publishToolFinished({
        runId: "r",
        toolId: "t",
        toolCallId: "c",
        status: "unknown",
        risk: "safe",
      }),
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("tool:finished");
  });

  test("发布是即发即忘：不等待监听器完成就返回", () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { publisher, sent } = harness(() => gate);
    const ret = publisher.publishSchedulerFinished({ taskId: "t", schedulerRunId: "r", status: "success" });
    expect(ret).toBeUndefined();
    expect(sent).toHaveLength(1);
    release();
  });
});
