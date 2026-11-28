import { describe, expect, it, vi } from "vitest";
import { createSocialContextScheduler } from "./scheduler";
import { createSocialAtomStore } from "./store";
import type { SocialExtractionInput } from "./types";

const CONV = "thread-42";
const NOW = 5_000;

const job = (): SocialExtractionInput => ({
  conversationId: CONV,
  userTurn: { id: "u-1", role: "user", text: "周末我打算去爬山，顺便拍点照片。" },
  assistantTurn: { id: "a-1", role: "assistant", text: "爬山很不错，记得带水。" },
  retrievedAtoms: [],
  now: NOW,
});

const goodOp = (content = "用户周末爬山") => ({
  operation: "add",
  type: "long_term",
  content,
  evidenceTurnId: "u-1",
  evidenceQuote: "去爬山",
  supersedesAtomId: null,
  expiresAt: null,
});
const goodReply = (...contents: string[]): string =>
  JSON.stringify({ operations: (contents.length ? contents : ["用户周末爬山"]).map((c) => goodOp(c)) });
const badReply = JSON.stringify({ operations: [{ ...goodOp(), operation: "bogus" }] });

type Task = () => Promise<void>;

// 立即执行任务的队列，并记录标签
const immediateQueue = () => {
  const labels: string[] = [];
  const enqueue = vi.fn((label: string, task: Task) => {
    labels.push(label);
    return task();
  });
  return { enqueue, labels };
};

async function settle(metric: ReturnType<typeof vi.fn>): Promise<void> {
  await vi.waitFor(() => expect(metric).toHaveBeenCalled());
}

describe("成功路径", () => {
  it("首轮合格：只调用一次模型，写入存储，并上报零修复的成功指标", async () => {
    const store = createSocialAtomStore();
    const generate = vi.fn().mockResolvedValue(goodReply());
    const metric = vi.fn();
    const { enqueue } = immediateQueue();
    createSocialContextScheduler({ store, generate, enqueue, recordMetric: metric }).schedule(job());

    await settle(metric);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][1]).toBeUndefined();
    expect(metric).toHaveBeenCalledWith({
      outcome: "success",
      acceptedCount: 1,
      rejectedCount: 0,
      attempts: 1,
      repairCount: 0,
    });
    expect(store.listActive(CONV, NOW).map((a) => a.content)).toEqual(["用户周末爬山"]);
  });

  it("把输入原样交给模型，并以固定标签入队", async () => {
    const generate = vi.fn().mockResolvedValue(goodReply());
    const metric = vi.fn();
    const { enqueue, labels } = immediateQueue();
    const input = job();
    createSocialContextScheduler({
      store: createSocialAtomStore(), generate, enqueue, recordMetric: metric,
    }).schedule(input);

    await settle(metric);
    expect(generate.mock.calls[0][0]).toBe(input);
    expect(labels).toEqual(["chat-social-context"]);
  });

  it("模型返回空 operations 也算成功，且不写入任何内容", async () => {
    const store = createSocialAtomStore();
    const metric = vi.fn();
    createSocialContextScheduler({
      store,
      generate: vi.fn().mockResolvedValue('{"operations":[]}'),
      enqueue: immediateQueue().enqueue,
      recordMetric: metric,
    }).schedule(job());

    await settle(metric);
    expect(metric.mock.calls[0][0]).toMatchObject({ outcome: "success", acceptedCount: 0, attempts: 1 });
    expect(store.listActive(CONV, NOW)).toEqual([]);
  });

  it("按输入里的 now 判断存储中的有效期", async () => {
    const store = createSocialAtomStore();
    const metric = vi.fn();
    const reply = JSON.stringify({ operations: [{
      ...goodOp("用户明天考试"),
      type: "short_term",
      evidenceQuote: "去爬山",
      expiresAt: NOW + 100,
    }] });
    createSocialContextScheduler({
      store,
      generate: vi.fn().mockResolvedValue(reply),
      enqueue: immediateQueue().enqueue,
      recordMetric: metric,
    }).schedule(job());

    await settle(metric);
    expect(store.listActive(CONV, NOW)).toHaveLength(1);
    expect(store.listActive(CONV, NOW + 100)).toHaveLength(0);
  });

  it("不提供 recordMetric 时也能正常运行", async () => {
    const store = createSocialAtomStore();
    const generate = vi.fn().mockResolvedValue(goodReply());
    createSocialContextScheduler({ store, generate, enqueue: immediateQueue().enqueue }).schedule(job());
    await vi.waitFor(() => expect(store.listActive(CONV, NOW)).toHaveLength(1));
  });

  it("多条合格操作一次性写入", async () => {
    const store = createSocialAtomStore();
    const metric = vi.fn();
    createSocialContextScheduler({
      store,
      generate: vi.fn().mockResolvedValue(goodReply("甲", "乙")),
      enqueue: immediateQueue().enqueue,
      recordMetric: metric,
    }).schedule(job());

    await settle(metric);
    expect(metric.mock.calls[0][0].acceptedCount).toBe(2);
    expect(store.listActive(CONV, NOW)).toHaveLength(2);
  });
});

describe("修复回合", () => {
  it("第一次有被拒条目：整批不写入，带着上次输出重试；第二次合格才落库", async () => {
    const mixed = JSON.stringify({ operations: [goodOp("好的一条"), { ...goodOp("坏的一条"), operation: "zap" }] });
    const store = createSocialAtomStore();
    const generate = vi.fn().mockResolvedValueOnce(mixed).mockResolvedValueOnce(goodReply("修正后"));
    const metric = vi.fn();
    createSocialContextScheduler({
      store, generate, enqueue: immediateQueue().enqueue, recordMetric: metric,
    }).schedule(job());

    await settle(metric);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][1]).toEqual({ attempt: 1, previousOutput: mixed, rejectedCount: 1 });
    expect(store.listActive(CONV, NOW).map((a) => a.content)).toEqual(["修正后"]);
    expect(metric).toHaveBeenCalledWith({
      outcome: "success", acceptedCount: 1, rejectedCount: 0, attempts: 2, repairCount: 1,
    });
  });

  it("第三次才合格：尝试 3 次，修复 2 次", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(badReply)
      .mockResolvedValueOnce("不是 JSON")
      .mockResolvedValueOnce(goodReply());
    const metric = vi.fn();
    const store = createSocialAtomStore();
    createSocialContextScheduler({
      store, generate, enqueue: immediateQueue().enqueue, recordMetric: metric,
    }).schedule(job());

    await settle(metric);
    expect(generate.mock.calls.map((c) => c[1]?.attempt)).toEqual([undefined, 1, 2]);
    expect(generate.mock.calls[2][1]).toMatchObject({ previousOutput: "不是 JSON", rejectedCount: 1 });
    expect(metric).toHaveBeenCalledWith({
      outcome: "success", acceptedCount: 1, rejectedCount: 0, attempts: 3, repairCount: 2,
    });
    expect(store.listActive(CONV, NOW)).toHaveLength(1);
  });

  it("三次都被拒：上报失败（以最后一次的拒绝数为准）并且不落库", async () => {
    const twoBad = JSON.stringify({ operations: [
      { ...goodOp(), operation: "x" }, { ...goodOp(), operation: "y" },
    ] });
    const store = createSocialAtomStore();
    const generate = vi.fn().mockResolvedValue(twoBad);
    const metric = vi.fn();
    createSocialContextScheduler({
      store, generate, enqueue: immediateQueue().enqueue, recordMetric: metric,
    }).schedule(job());

    await settle(metric);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(metric).toHaveBeenCalledTimes(1);
    expect(metric).toHaveBeenCalledWith({
      outcome: "failure", acceptedCount: 0, rejectedCount: 2, attempts: 3, repairCount: 2,
    });
    expect(store.listActive(CONV, NOW)).toEqual([]);
  });

  it("传给修复回合的上次输出最多保留 6000 个字符", async () => {
    const huge = "x".repeat(9_000);
    const generate = vi.fn()
      .mockResolvedValueOnce(huge)
      .mockResolvedValueOnce(goodReply());
    const metric = vi.fn();
    createSocialContextScheduler({
      store: createSocialAtomStore(), generate, enqueue: immediateQueue().enqueue, recordMetric: metric,
    }).schedule(job());

    await settle(metric);
    expect(generate.mock.calls[1][1].previousOutput).toBe(huge.slice(0, 6_000));
  });

  it("每一轮修复拿到的是上一轮的输出", async () => {
    const first = JSON.stringify({ operations: [{ ...goodOp(), operation: "a" }] });
    const second = JSON.stringify({ operations: [{ ...goodOp(), operation: "b" }] });
    const generate = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(goodReply());
    const metric = vi.fn();
    createSocialContextScheduler({
      store: createSocialAtomStore(), generate, enqueue: immediateQueue().enqueue, recordMetric: metric,
    }).schedule(job());

    await settle(metric);
    expect(generate.mock.calls[1][1].previousOutput).toBe(first);
    expect(generate.mock.calls[2][1].previousOutput).toBe(second);
  });
});

describe("异常与队列", () => {
  it("模型调用抛错：不重试，上报失败并带上已进行的轮次", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("offline"));
    const metric = vi.fn();
    const store = createSocialAtomStore();
    createSocialContextScheduler({
      store, generate, enqueue: immediateQueue().enqueue, recordMetric: metric,
    }).schedule(job());

    await settle(metric);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(metric).toHaveBeenCalledWith({
      outcome: "failure", acceptedCount: 0, rejectedCount: 0, attempts: 1, repairCount: 0,
    });
    expect(store.listActive(CONV, NOW)).toEqual([]);
  });

  it("修复回合中模型抛错：失败指标记录 2 次尝试与 1 次修复", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(badReply)
      .mockRejectedValueOnce(new Error("timeout"));
    const metric = vi.fn();
    createSocialContextScheduler({
      store: createSocialAtomStore(), generate, enqueue: immediateQueue().enqueue, recordMetric: metric,
    }).schedule(job());

    await settle(metric);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(metric).toHaveBeenCalledWith({
      outcome: "failure", acceptedCount: 0, rejectedCount: 0, attempts: 2, repairCount: 1,
    });
  });

  it("队列自身拒绝任务：从未调用模型，上报零尝试的失败", async () => {
    const generate = vi.fn();
    const metric = vi.fn();
    createSocialContextScheduler({
      store: createSocialAtomStore(),
      generate,
      enqueue: () => Promise.reject(new Error("queue full")),
      recordMetric: metric,
    }).schedule(job());

    await settle(metric);
    expect(generate).not.toHaveBeenCalled();
    expect(metric).toHaveBeenCalledWith({
      outcome: "failure", acceptedCount: 0, rejectedCount: 0, attempts: 0, repairCount: 0,
    });
  });

  it("schedule 立即返回，不等待队列任务完成", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const generate = vi.fn().mockResolvedValue(goodReply());
    const metric = vi.fn();
    const store = createSocialAtomStore();
    createSocialContextScheduler({
      store,
      generate,
      enqueue: async (_label, task) => { await gate; await task(); },
      recordMetric: metric,
    }).schedule(job());

    expect(generate).not.toHaveBeenCalled();
    release();
    await settle(metric);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("多次 schedule 各自独立入队并各自上报一次指标", async () => {
    const store = createSocialAtomStore();
    const generate = vi.fn().mockResolvedValue('{"operations":[]}');
    const metric = vi.fn();
    const { enqueue } = immediateQueue();
    const scheduler = createSocialContextScheduler({ store, generate, enqueue, recordMetric: metric });

    scheduler.schedule(job());
    scheduler.schedule(job());
    await vi.waitFor(() => expect(metric).toHaveBeenCalledTimes(2));
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
});
