import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PendingSenderRegistry,
  isSenderAllowed,
  isValidSenderId,
  normalizeSenderIds,
} from "./sender-gate";

afterEach(() => vi.useRealTimers());

describe("sender gate", () => {
  it("allows only listed senders unless everyone is allowed", () => {
    expect(isSenderAllowed({ allowAnyPrivate: false, allowedSenderIds: [] }, "ou_a")).toBe(false);
    expect(isSenderAllowed({ allowAnyPrivate: false, allowedSenderIds: ["ou_a"] }, "ou_a")).toBe(true);
    expect(isSenderAllowed({ allowAnyPrivate: false, allowedSenderIds: ["ou_a"] }, "ou_b")).toBe(false);
    expect(isSenderAllowed({ allowAnyPrivate: true, allowedSenderIds: [] }, "ou_b")).toBe(true);
  });

  it("normalizes sender ids and drops malformed entries", () => {
    expect(normalizeSenderIds([" ou_a ", "ou_a", "abc@im.wechat", "has space", "", "<script>", 7]))
      .toEqual(["ou_a", "abc@im.wechat", "7"]);
    expect(normalizeSenderIds("ou_a")).toEqual([]);
    expect(isValidSenderId("x".repeat(129))).toBe(false);
  });

  it("keeps one entry per sender, newest first, and bounds the list", () => {
    const registry = new PendingSenderRegistry();
    registry.record("wechat", "a@im.wechat", "A", 1);
    registry.record("wechat", "b@im.wechat", undefined, 2);
    registry.record("wechat", "a@im.wechat", "A2", 3);
    expect(registry.list("wechat").map((item) => [item.senderId, item.senderName])).toEqual([
      ["a@im.wechat", "A2"],
      ["b@im.wechat", undefined],
    ]);
    expect(registry.list("feishu")).toEqual([]);

    for (let i = 0; i < 40; i += 1) registry.record("feishu", `ou_${i}`, undefined, i);
    const feishu = registry.list("feishu");
    expect(feishu).toHaveLength(20);
    expect(feishu[0].senderId).toBe("ou_39");
    expect(feishu.some((item) => item.senderId === "ou_0")).toBe(false);
  });

  it("ignores invalid ids and notifies listeners only on change", () => {
    const registry = new PendingSenderRegistry();
    const listener = vi.fn();
    registry.onChange(listener);
    registry.record("wechat", "bad id");
    expect(listener).not.toHaveBeenCalled();
    registry.record("wechat", "a@im.wechat");
    expect(listener).toHaveBeenCalledWith("wechat");
    expect(registry.remove("wechat", "missing")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.remove("wechat", "a@im.wechat")).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("truncates long display names", () => {
    const registry = new PendingSenderRegistry();
    registry.record("feishu", "ou_a", "n".repeat(200));
    expect(registry.list("feishu")[0].senderName).toHaveLength(64);
  });

  it("does not notify again for repeat messages from the same pending sender", () => {
    vi.useFakeTimers();
    const registry = new PendingSenderRegistry();
    const listener = vi.fn();
    registry.onChange(listener);
    registry.record("wechat", "a@im.wechat", "A", 1);
    for (let i = 0; i < 100; i += 1) registry.record("wechat", "a@im.wechat", "A", 2 + i);
    vi.advanceTimersByTime(2000);
    expect(listener).toHaveBeenCalledTimes(1);
    // 时间仍然刷新，列表排序保持最新
    expect(registry.list("wechat")[0].at).toBe(101);
    // 昵称变化算实质变化
    registry.record("wechat", "a@im.wechat", "B", 500);
    vi.advanceTimersByTime(2000);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("coalesces a burst of new strangers into at most two notifications per window", () => {
    vi.useFakeTimers();
    const registry = new PendingSenderRegistry();
    const listener = vi.fn();
    registry.onChange(listener);
    for (let i = 0; i < 50; i += 1) registry.record("feishu", `ou_${i}`, undefined, i);
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(listener).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5000);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
