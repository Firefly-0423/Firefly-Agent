import { afterEach, it, expect, describe, vi } from "vitest";
import {
  DEFAULT_PACER_OPTIONS, FrameCoalescer, FramePacer, PacedTextReveal, splitGraphemes,
} from "./message-reveal";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fakeRaf(startAt = 0) {
  let now = startAt;
  let seq = 0;
  const queue = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = ++seq;
    queue.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    queue.delete(id);
  });
  return {
    pending: () => queue.size,
    frame(dtMs = 1000 / 60) {
      now += dtMs;
      const batch = Array.from(queue.values());
      queue.clear();
      for (const cb of batch) cb(now);
    },
    drain(dtMs = 1000 / 60, maxFrames = 600) {
      let count = 0;
      while (queue.size > 0 && count < maxFrames) {
        this.frame(dtMs);
        count += 1;
      }
      return count;
    },
  };
}

describe("Animation-frame publication", () => {
  it("coalesces repeated work, supports synchronous flush and discards cancelled work", () => {
    const raf = fakeRaf();
    const updates: string[] = [];
    const batched = new FrameCoalescer();
    batched.schedule(() => updates.push("obsolete"));
    batched.schedule(() => updates.push("latest"));
    expect(updates).toStrictEqual([]);
    raf.frame();
    expect(updates).toStrictEqual(["latest"]);
    batched.schedule(() => updates.push("flushed"));
    batched.flush();
    expect(updates).toStrictEqual(["latest", "flushed"]);
    expect(raf.pending()).toEqual(0);
    batched.schedule(() => updates.push("cancelled"));
    batched.cancel();
    raf.frame();
    expect(updates).toStrictEqual(["latest", "flushed"]);
  });

  it("delivers queued segments to their own target in arrival order when unpaced", async () => {
    const raf = fakeRaf();
    const visible: [string, string][] = [];
    const reveal = new PacedTextReveal(() => false);
    const done = reveal.push("trace", "先核对输入", chunk => visible.push(["trace", chunk]));
    void reveal.push("reply", "然后给出结论", chunk => visible.push(["reply", chunk]));
    expect(visible).toStrictEqual([]);
    raf.frame();
    await done;
    expect(visible).toStrictEqual([["trace", "先核对输入"], ["reply", "然后给出结论"]]);
    expect(raf.pending()).toEqual(0);
  });

  it("drains a non-paced burst on the next single frame", async () => {
    const raf = fakeRaf();
    const chunks: string[] = [];
    const reveal = new PacedTextReveal(() => false);
    const done = reveal.push("reply", "光".repeat(200), chunk => chunks.push(chunk));
    raf.frame();
    await done;
    expect(chunks).toStrictEqual(["光".repeat(200)]);
    expect(raf.pending()).toEqual(0);
  });

  it("settles cancellation without publishing the unrevealed remainder", async () => {
    const raf = fakeRaf();
    const chunks: string[] = [];
    const reveal = new PacedTextReveal(() => true);
    const done = reveal.push("reply", "本段尚未显示的部分应被取消", chunk => chunks.push(chunk));
    raf.frame();
    const beforeCancel = chunks.join("");
    expect(splitGraphemes(beforeCancel).length).toBeGreaterThanOrEqual(1);
    expect(beforeCancel.length).toBeLessThan("本段尚未显示的部分应被取消".length);
    reveal.cancel();
    raf.drain();
    await expect(done).resolves.toEqual(undefined);
    expect(chunks.join("")).toEqual(beforeCancel);
    expect(reveal.active).toEqual(false);
  });

  it("paces at 60 Hz and 120 Hz with at most one publish and 4 graphemes per frame", async () => {
    const input = "现在开始核对资料，核对之后提供完整结论。".repeat(6);
    for (const hz of [60, 120] as const) {
      const raf = fakeRaf();
      const chunks: string[] = [];
      const reveal = new PacedTextReveal(() => true);
      const done = reveal.push("reply", input, chunk => chunks.push(chunk));
      const dt = 1000 / hz;
      raf.frame(dt);
      // Fast first safe grapheme even at 120 Hz (dt ~ 8.33 ms).
      expect(chunks).toHaveLength(1);
      expect(splitGraphemes(chunks[0]!).length).toBeGreaterThanOrEqual(1);
      expect(splitGraphemes(chunks[0]!).length).toBeLessThanOrEqual(4);
      while (raf.pending() > 0) {
        const before = chunks.length;
        raf.frame(dt);
        expect(chunks.length - before).toBeLessThanOrEqual(1);
      }
      await done;
      expect(chunks.every(c => splitGraphemes(c).length <= 4)).toBe(true);
      expect(chunks.join("")).toBe(input);
      expect(reveal.active).toBe(false);
    }
  });

  it("handles jittered frames and clamps long pauses without accumulating burst debt", async () => {
    const raf = fakeRaf();
    const chunks: string[] = [];
    const reveal = new PacedTextReveal(() => true);
    const input = "流".repeat(120);
    const done = reveal.push("reply", input, chunk => chunks.push(chunk));
    const jitter = [5, 28, 9, 41, 12, 5000, 16, 16, 16];
    for (const dt of jitter) {
      const before = chunks.length;
      raf.frame(dt);
      expect(chunks.length - before).toBeLessThanOrEqual(1);
      if (chunks.length > before) {
        expect(splitGraphemes(chunks.at(-1)!).length).toBeLessThanOrEqual(4);
      }
    }
    raf.drain(1000 / 60);
    await done;
    expect(chunks.every(c => splitGraphemes(c).length <= 4)).toBe(true);
    expect(chunks.join("")).toBe(input);
  });

  it("preserves split ZWJ emoji and combining marks across deltas without breaking clusters", async () => {
    const raf = fakeRaf();
    const out: string[] = [];
    const reveal = new PacedTextReveal(() => true);
    const input = "流萤👩‍👩‍👧你好，世界。".repeat(20);
    const done = reveal.push("reply", input.slice(0, 7), c => out.push(c));
    void reveal.push("reply", input.slice(7), c => out.push(c));
    raf.drain(1000 / 60);
    await done;
    expect(out.every(c => splitGraphemes(c).length <= 4)).toBe(true);
    expect(out.join("")).toBe(input);

    // Split across separate animation frames (trailing ZWJ waits for completion).
    const out2: string[] = [];
    const reveal2 = new PacedTextReveal(() => true);
    const done2 = reveal2.push("reply", "测试👩\u200D", c => out2.push(c));
    raf.frame(1000 / 60);
    raf.frame(1000 / 60);
    expect(out2.join("")).toBe("测试");
    void reveal2.push("reply", "👩\u200D👧完成", c => out2.push(c));
    raf.drain(1000 / 60);
    await done2;
    expect(out2.some(c => c.includes("👩‍👩‍👧"))).toBe(true);
    expect(out2.join("")).toBe("测试👩‍👩‍👧完成");

    // Combining mark appended before first frame merges with base character.
    const out3: string[] = [];
    const reveal3 = new PacedTextReveal(() => true);
    const done3 = reveal3.push("reply", "e", c => out3.push(c));
    void reveal3.push("reply", "\u0301!", c => out3.push(c));
    raf.drain(1000 / 60);
    await done3;
    expect(out3[0]!.startsWith("e\u0301")).toBe(true);
    expect(out3.join("")).toBe("e\u0301!");
  });

  it("preserves multi-target ordering and issues at most one callback per frame", async () => {
    const raf = fakeRaf();
    const seen: Array<[string, string]> = [];
    const reveal = new PacedTextReveal(() => true);
    void reveal.push("trace", "核对👩", c => seen.push(["trace", c]));
    const done = reveal.push("reply", "\u200D👧结论", c => seen.push(["reply", c]));
    while (raf.pending() > 0) {
      const before = seen.length;
      raf.frame(1000 / 60);
      expect(seen.length - before).toBeLessThanOrEqual(1);
    }
    await done;
    const traceJoined = seen.filter(([k]) => k === "trace").map(([, c]) => c).join("");
    const replyJoined = seen.filter(([k]) => k === "reply").map(([, c]) => c).join("");
    expect(traceJoined).toBe("核对👩");
    expect(replyJoined).toBe("\u200D👧结论");
    const lastTrace = seen.findLastIndex(([k]) => k === "trace");
    const firstReply = seen.findIndex(([k]) => k === "reply");
    expect(lastTrace).toBeLessThan(firstReply);
  });
});

describe("FramePacer credit and velocity curve", () => {
  it("clears fractional credit when empty and ramps speed smoothly with backlog", () => {
    const pacer = new FramePacer(DEFAULT_PACER_OPTIONS);
    pacer.push("a", "1", () => {});
    const first = pacer.tick(16);
    expect(first?.chunk).toBe("1");
    expect(pacer.backlog).toBe(0);
    // Calling tick while empty resets credit so next burst starts fresh at 120 Hz.
    expect(pacer.tick(50)).toBeNull();

    pacer.push("a", "萤".repeat(200), () => {});
    const counts: number[] = [];
    for (let i = 0; i < 12; i++) {
      const step = pacer.tick(16.67);
      if (step) counts.push(splitGraphemes(step.chunk).length);
    }
    expect(counts[0]).toBeGreaterThanOrEqual(1);
    expect(Math.max(...counts)).toBeLessThanOrEqual(4);
    expect(counts.at(-1)!).toBeGreaterThan(counts[0]!);
  });
});
