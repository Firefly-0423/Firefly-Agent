// @vitest-environment jsdom
// 用量卡片单测：格式化与汇总的纯函数口径 + 读取时机（挂载 / 换对话 / run 结束）与卡片内容。
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TOKEN_USAGE_BAR_DAYS,
  UsageCardBody,
  formatSeconds,
  formatTokenAmount,
  splitDuration,
  summarizeTokenUsage,
  type TokenUsageBarDay,
  usageCardSummary,
  useUsageData,
} from "./TokenUsageBar";

function day(overrides: Partial<TokenUsageBarDay> = {}): TokenUsageBarDay {
  return { input: 0, output: 0, hit: 0, miss: 0, requests: 0, attemptedRequests: 0, cacheUsageRequests: 0, ...overrides };
}

describe("formatTokenAmount", () => {
  it("keeps small values as integers and abbreviates k / M / B", () => {
    expect(formatTokenAmount(0)).toBe("0");
    expect(formatTokenAmount(Number.NaN)).toBe("0");
    expect(formatTokenAmount(999)).toBe("999");
    expect(formatTokenAmount(1234)).toBe("1.2k");
    expect(formatTokenAmount(12_345)).toBe("12.3k");
    expect(formatTokenAmount(123_456)).toBe("123k");
    expect(formatTokenAmount(1_234_567)).toBe("1.2M");
    expect(formatTokenAmount(350_000_000)).toBe("350M");
    expect(formatTokenAmount(2_500_000_000)).toBe("2.5B");
  });
});

describe("summarizeTokenUsage", () => {
  it("returns null when nothing was recorded, so the bar stays hidden", () => {
    expect(summarizeTokenUsage([])).toBeNull();
    expect(summarizeTokenUsage([day(), day()])).toBeNull();
  });

  it("treats attempted-but-unreported requests as data, with zero tokens", () => {
    const summary = summarizeTokenUsage([day({ attemptedRequests: 2 })]);
    expect(summary).not.toBeNull();
    expect(summary!.total).toBe(0);
    expect(summary!.attemptedRequests).toBe(2);
    expect(summary!.cacheHitRate).toBeUndefined();
  });

  it("sums days into requests, input, output and total", () => {
    const summary = summarizeTokenUsage([
      day({ input: 1000, output: 200, requests: 2, attemptedRequests: 2 }),
      day({ input: 500, output: 300, requests: 1, attemptedRequests: 1 }),
    ]);
    expect(summary).toEqual({
      requests: 3,
      attemptedRequests: 3,
      input: 1500,
      output: 500,
      hit: 0,
      miss: 0,
      total: 2000,
      cacheHitRate: undefined,
    });
  });

  it("computes the cache hit rate as hit / (hit + miss) like the settings token panel", () => {
    const summary = summarizeTokenUsage([
      day({ input: 1000, output: 10, hit: 990, miss: 10, requests: 1, cacheUsageRequests: 1 }),
    ]);
    expect(summary!.cacheHitRate).toBeCloseTo(0.99);
  });

  it("keeps cache read and uncached input so the detail card can list them", () => {
    const summary = summarizeTokenUsage([day({ input: 1000, output: 10, hit: 990, miss: 10, requests: 1, cacheUsageRequests: 1 })]);
    expect(summary).toEqual(expect.objectContaining({ hit: 990, miss: 10, output: 10, total: 1010 }));
  });

  it("omits the cache rate when the vendor never reported cache details", () => {
    const summary = summarizeTokenUsage([day({ input: 1000, output: 10, requests: 1 })]);
    expect(summary!.cacheHitRate).toBeUndefined();
  });
});

describe("duration helpers", () => {
  it("splits milliseconds into whole minutes and seconds without rolling into hours", () => {
    expect(splitDuration(162 * 60_000 + 16_000)).toEqual({ minutes: 162, seconds: 16 });
    expect(splitDuration(45_400)).toEqual({ minutes: 0, seconds: 45 });
    expect(splitDuration(-5)).toEqual({ minutes: 0, seconds: 0 });
  });

  it("writes the first-token delay with one decimal", () => {
    expect(formatSeconds(3900)).toBe("3.9");
    expect(formatSeconds(2000)).toBe("2");
  });
});

describe("usage card", () => {
  let root: Root;
  let host: HTMLDivElement;
  let getUsage: ReturnType<typeof vi.fn>;
  let getSessionStats: ReturnType<typeof vi.fn>;
  let summary: string | undefined;

  function Probe({ busy, sessionId }: { busy: boolean; sessionId?: string }) {
    const data = useUsageData(busy, sessionId);
    summary = usageCardSummary(data);
    return React.createElement(UsageCardBody, { data });
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    summary = undefined;
    getUsage = vi.fn(async () => ({
      days: [day({ input: 349_000_000, output: 1_000_000, hit: 346_000_000, miss: 3_000_000, requests: 133, attemptedRequests: 133, cacheUsageRequests: 133 })],
    }));
    getSessionStats = vi.fn(async () => ({ rounds: 153, steps: 1005, modelMs: 162 * 60_000 + 16_000, toolMs: 99 * 60_000 + 31_000, avgTtftMs: 3900, tokensPerSecond: 245 }));
    (window as unknown as { tokenUsage?: unknown }).tokenUsage = { get: getUsage, sessionStats: getSessionStats };
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (window as unknown as { tokenUsage?: unknown }).tokenUsage;
  });

  async function render(busy: boolean, sessionId?: string) {
    await act(async () => { root.render(React.createElement(Probe, { busy, sessionId })); });
  }

  it("reads the 90-day window on mount and puts the total in the card header", async () => {
    await render(false);
    expect(getUsage).toHaveBeenCalledWith(TOKEN_USAGE_BAR_DAYS);
    expect(summary).toBe("350M tok");
  });

  it("lists this conversation's run stats", async () => {
    await render(false, "session-a");
    expect(getSessionStats).toHaveBeenCalledWith("session-a");
    const text = host.textContent!;
    expect(text).toContain("153 轮 1005 步");
    expect(text).toContain("模型用时162分16秒");
    expect(text).toContain("工具调用用时99分31秒");
    expect(text).toContain("首 token 平均 (TTFT)3.9秒");
    expect(text).toContain("输出速度 (TPS)245 tok/s");
  });

  it("lists the token breakdown with exact numbers", async () => {
    await render(false, "session-a");
    const text = host.textContent!;
    expect(text).toContain("350,000,000 tok");
    expect(text).toContain("缓存命中99%");
    expect(text).toContain("未缓存输入3,000,000 tok");
    expect(text).toContain("缓存读取346,000,000 tok");
    expect(text).toContain("输出1,000,000 tok");
    expect(text).toContain("请求数133 次请求");
    expect(text).toContain("近 90 天累计");
  });

  it("shows em dashes where a conversation has no first-token or speed data", async () => {
    getSessionStats.mockResolvedValueOnce({ rounds: 1, steps: 2, modelMs: 800, toolMs: 0, avgTtftMs: null, tokensPerSecond: null });
    await render(false, "session-a");
    expect(host.textContent).toContain("首 token 平均 (TTFT)—");
    expect(host.textContent).toContain("输出速度 (TPS)—");
  });

  it("leaves out the conversation section when it has nothing recorded or no id yet", async () => {
    getSessionStats.mockResolvedValueOnce(null);
    await render(false, "session-a");
    expect(host.textContent).not.toContain("会话统计");
    await render(false, undefined);
    expect(host.textContent).not.toContain("会话统计");
    expect(host.textContent).toContain("Token 用量");
  });

  it("drops the previous conversation's numbers when switching and refetches for the new one", async () => {
    await render(false, "session-a");
    expect(host.textContent).toContain("会话统计");
    getSessionStats.mockResolvedValueOnce(null);
    await render(false, "session-b");
    expect(getSessionStats).toHaveBeenLastCalledWith("session-b");
    expect(host.textContent).not.toContain("会话统计");
  });

  it("does not read while a run is in progress, and reads once when it ends", async () => {
    await render(true, "session-a");
    expect(getUsage).not.toHaveBeenCalled();
    expect(getSessionStats).not.toHaveBeenCalled();
    await render(false, "session-a");
    expect(getUsage).toHaveBeenCalledTimes(1);
    await render(false, "session-a");
    expect(getUsage).toHaveBeenCalledTimes(1);
  });

  it("says there is nothing yet when no usage was recorded or the read fails", async () => {
    getUsage.mockRejectedValueOnce(new Error("ipc down"));
    await render(false);
    expect(host.textContent).toContain("还没有用量记录");
    expect(summary).toBeUndefined();
  });
});
