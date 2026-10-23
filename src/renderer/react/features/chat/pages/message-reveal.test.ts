import { afterEach, it, expect, describe, vi } from "vitest";
import { PacedTextReveal, FrameCoalescer, splitGraphemes, SmoothTextRevealQueue } from "./message-reveal";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function animationClock() {
  let timestamp = 100;
  let sequence = 20;
  const work = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => timestamp);
  vi.stubGlobal("window", {
    requestAnimationFrame(callback: FrameRequestCallback) { const id = ++sequence; work.set(id, callback); return id; },
    cancelAnimationFrame(id: number) { work.delete(id); },
  });
  return {
    count: () => work.size,
    tick() {
      timestamp += 40;
      const pending = Array.from(work.values());
      work.clear();
      for (const callback of pending) callback(timestamp);
    },
  };
}

describe("Animation-frame publication", () => {
  it("coalesces repeated work, supports synchronous flush and discards cancelled work", () => {
    const clock = animationClock(), updates: string[] = [], batched = new FrameCoalescer();
    batched.schedule(() => updates.push("obsolete"));
    batched.schedule(() => updates.push("latest"));
    expect(updates).toStrictEqual([]);
    clock.tick();
    expect(updates).toStrictEqual(["latest"]);
    batched.schedule(() => updates.push("flushed"));
    batched.flush();
    expect(updates).toStrictEqual(["latest", "flushed"]);
    expect(clock.count()).toEqual(0);
    batched.schedule(() => updates.push("cancelled"));
    batched.cancel();
    clock.tick();
    expect(updates).toStrictEqual(["latest", "flushed"]);
  });

  it("delivers queued segments to their own target in arrival order", () => {
    const clock = animationClock(), visible: [string, string][] = [], reveal = new PacedTextReveal(() => false);
    reveal.push("trace", "先核对输入", chunk => visible.push(["trace", chunk]));
    reveal.push("reply", "然后给出结论", chunk => visible.push(["reply", chunk]));
    clock.tick();
    expect(visible).toStrictEqual([["trace", "先核对"], ["trace", "输入"], ["reply", "然后给出结论"]]);
  });

  it("drains a non-paced burst on the first frame with exactly two publications", async () => {
    const clock = animationClock(), chunks: string[] = [], reveal = new PacedTextReveal(() => false);
    const done = reveal.push("reply", "光".repeat(200), chunk => chunks.push(chunk));
    clock.tick();
    await done;
    expect(chunks).toStrictEqual(["光".repeat(3), "光".repeat(197)]);
    expect(clock.count()).toEqual(0);
  });

  it("settles cancellation without publishing the remainder", async () => {
    const clock = animationClock(), chunks: string[] = [], reveal = new PacedTextReveal(() => true);
    const done = reveal.push("reply", "本段尚未显示的部分应被取消", chunk => chunks.push(chunk));
    reveal.cancel();
    clock.tick();
    await expect(done).resolves.toEqual(undefined);
    expect(chunks.join("")).toEqual("本段尚");
    expect(reveal.active).toEqual(false);
  });

  it("paces consecutive chunks with at most one publication per frame and no text loss", async () => {
    const clock = animationClock(), chunks: string[] = [], reveal = new PacedTextReveal(() => true);
    const done = reveal.push("reply", "现在开始核对资料，", chunk => chunks.push(chunk));
    void reveal.push("reply", "核对之后提供结论。", chunk => chunks.push(chunk));
    expect(chunks).toStrictEqual(["现在开"]);
    let frames = 0;
    while (clock.count()) {
      const previous = chunks.length;
      clock.tick();
      expect(chunks.length - previous).toBeLessThanOrEqual(1);
      frames++;
    }
    await done;
    expect(frames).toBeGreaterThan(1);
    expect(chunks.join("")).toEqual("现在开始核对资料，核对之后提供结论。");
    expect(reveal.active).toEqual(false);
  });
});

describe("Grapheme queue pacing", () => {
  it("treats a joined emoji as one character", () => {
    const astronaut = "👩‍🚀";
    const input = `甲${astronaut}乙`;
    expect(splitGraphemes(input)).toStrictEqual(["甲", astronaut, "乙"]);
    expect(new SmoothTextRevealQueue().push(input)).toEqual(input);
  });

  it("increases burst size gradually while keeping each group at most nine graphemes", () => {
    const queue = new SmoothTextRevealQueue();
    queue.push("萤".repeat(300));
    const lengths = Array.from({ length: 8 }, () => splitGraphemes(queue.takeNext(40)).length);
    expect(lengths[0]).toBeGreaterThanOrEqual(3);
    expect(lengths[7]).toBeGreaterThan(lengths[0]);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(9);
  });

  it("shows the first three characters immediately and preserves all subsequent groups", () => {
    const queue = new SmoothTextRevealQueue(), text = "首先整理公开资料然后逐项核对来源";
    const beginning = queue.push(text), later: string[] = [];
    while (queue.hasPending) later.push(queue.takeNext(40));
    expect(beginning).toEqual("首先整");
    expect(beginning + later.join("")).toEqual(text);
    expect(later.every(part => splitGraphemes(part).length >= 2)).toEqual(true);
  });
});
