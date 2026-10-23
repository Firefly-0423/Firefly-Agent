/**
 * Pacing for public text: Work/Learn/Code receive and classify a model turn before its public text is shown, and the
 * text then appears at a reading pace; Chat shows it as it arrives. This only changes when received text appears,
 * never what appears.
 */
/** 按字形簇切分（emoji、组合字符不会被拆开）；运行环境没有 Segmenter 时退回按码点切分。 */
export function splitGraphemes(text: string): string[] {
  type SegmenterCtor = new (locales?: string | string[], options?: { granularity: "grapheme" }) => { segment: (value: string) => Iterable<{ segment: string }> };
  const Ctor = (Intl as typeof Intl & { Segmenter?: SegmenterCtor }).Segmenter;
  if (!Ctor) return [...text];
  return [...new Ctor(undefined, { granularity: "grapheme" }).segment(text)].map((item) => item.segment);
}

export const SMOOTH_REVEAL_TICK_MS: number = 40;

type SmoothTextRevealOptions = {
  decelerationMs: number;
  accelerationMs: number;
  maxGroupSize: number;
  initialGroupSize: number;
  maxRate: number;
  baseRate: number;
};

const DEFAULT_SMOOTH_REVEAL_OPTIONS: SmoothTextRevealOptions = {
  decelerationMs: 300,
  accelerationMs: 180,
  maxGroupSize: 9,
  initialGroupSize: 3,
  maxRate: 220,
  baseRate: 75,
};

/**
 * 这里只管已经收到的文本何时露出：第一组同步返回，之后根据堆积的字数逐步加快。
 * 真正的内容来源仍是模型事件；队列本身不补字、不改字，也不做预测。
 */
export class SmoothTextRevealQueue {
  private readonly options: SmoothTextRevealOptions;
  private pending: string[] = [];
  private started = false;
  private currentRate: number;
  private credit = 0;

  constructor(options: Partial<SmoothTextRevealOptions> = {}) {
    this.options = Object.assign({}, DEFAULT_SMOOTH_REVEAL_OPTIONS, options);
    this.currentRate = this.options.baseRate;
  }

  get hasPending(): boolean {
    return this.pending.length !== 0;
  }

  get pendingCount(): number {
    const { length } = this.pending;
    return length;
  }

  push(text: string): string {
    const incoming = splitGraphemes(text);
    if (!incoming.length) return "";
    this.pending.push(...incoming);
    if (this.started) return "";
    this.started = true;
    const head = Math.min(this.options.initialGroupSize, this.pending.length);
    return this.takeExact(head);
  }

  takeNext(elapsedMs = SMOOTH_REVEAL_TICK_MS): string {
    if (!this.pending.length) return "";
    const { baseRate, maxRate, accelerationMs, decelerationMs, maxGroupSize } = this.options;
    const duration = Math.max(0, elapsedMs);
    // 积压越多，目标速率越高，但不超过 maxRate
    const targetRate = Math.min(maxRate, baseRate + this.pending.length * 0.9);
    const transitionMs = targetRate > this.currentRate ? accelerationMs : decelerationMs;
    const blend = 1 - Math.exp(-duration / Math.max(1, transitionMs));
    this.currentRate += (targetRate - this.currentRate) * blend;
    this.credit += (this.currentRate * duration) / 1000;

    let count = Math.min(maxGroupSize, this.pending.length, Math.floor(this.credit));
    if (count === 0) return "";
    // 避免节奏结束时尾部只剩一个字；极短的尾段仍会完整显示
    if (this.pending.length - count === 1 && count < maxGroupSize) count += 1;
    const remainder = this.credit - count;
    this.credit = Math.max(0, remainder);
    return this.takeExact(count);
  }

  drain(): string {
    return this.takeExact(this.pending.length);
  }

  clear(): void {
    this.credit = 0;
    this.started = false;
    this.pending = [];
    this.currentRate = this.options.baseRate;
  }

  private takeExact(count: number): string {
    return this.pending.splice(0, count).join("");
  }
}

type FrameHandle = { id: number; raf: boolean };

function requestFrame(callback: (now: number) => void): FrameHandle {
  if (typeof window !== "undefined" && window.requestAnimationFrame) return { id: window.requestAnimationFrame(callback), raf: true };
  return { id: setTimeout(() => callback(performance.now()), SMOOTH_REVEAL_TICK_MS) as unknown as number, raf: false };
}

function cancelFrame(handle: FrameHandle | undefined): void {
  if (!handle) return;
  if (handle.raf) window.cancelAnimationFrame(handle.id);
  else clearTimeout(handle.id);
}

/**
 * Streams received text onto the screen at most once per animation frame, so a fast model no longer costs one
 * Markdown re-render per network chunk (the stutter users saw). Several targets can be fed in order (the answer, then a
 * process message); each frame hands every target the characters that are due, in arrival order.
 * - paced: characters come out at the adaptive rate of SmoothTextRevealQueue (it speeds up when a backlog builds);
 * - not paced (Chat, reduced motion): everything received so far appears on the next frame.
 * It only changes when text appears, never what appears.
 */
export class PacedTextReveal {
  private readonly queue = new SmoothTextRevealQueue();
  private segments: Array<{ key: string; publish: (chunk: string) => void; count: number }> = [];
  private frame: FrameHandle | undefined;
  private lastFrameAt: number | undefined;
  private drain: { promise: Promise<void>; resolve: () => void } | undefined;

  constructor(private readonly paced: () => boolean) {}

  /** True while received text is still waiting to be shown. */
  get active(): boolean {
    return this.drain !== undefined;
  }

  /** Queues text for the target `key`; the promise settles once everything queued so far is on screen. */
  push(key: string, text: string, publish: (chunk: string) => void): Promise<void> {
    const count = splitGraphemes(text).length;
    if (count === 0) return this.drain?.promise ?? Promise.resolve();
    const last = this.segments[this.segments.length - 1];
    if (last && last.key === key) {
      last.count += count;
      last.publish = publish;
    } else {
      this.segments.push({ key, publish, count });
    }
    if (!this.drain) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      this.drain = { promise, resolve };
    }
    // The first characters of a new burst show at once; the rest follow frame by frame. A short burst can finish right
    // here, so hold on to its promise first.
    const { promise } = this.drain;
    this.emit(this.queue.push(text));
    this.schedule();
    return promise;
  }

  /** Drops whatever has not been shown yet (the run failed or was cancelled). */
  cancel(): void {
    cancelFrame(this.frame);
    this.frame = undefined;
    this.segments = [];
    this.queue.clear();
    this.finish();
  }

  private schedule(): void {
    if (this.frame || !this.queue.hasPending) {
      if (!this.queue.hasPending && !this.frame) this.finish();
      return;
    }
    if (this.lastFrameAt === undefined) this.lastFrameAt = performance.now();
    this.frame = requestFrame((now) => {
      this.frame = undefined;
      if (!this.paced()) {
        this.emit(this.queue.drain());
      } else {
        const elapsed = Math.max(0, now - (this.lastFrameAt ?? now));
        if (elapsed >= SMOOTH_REVEAL_TICK_MS) {
          this.lastFrameAt = now;
          this.emit(this.queue.takeNext(Math.min(elapsed, 160)));
        }
      }
      this.schedule();
    });
  }

  private emit(text: string): void {
    if (!text) return;
    const graphemes = splitGraphemes(text);
    let index = 0;
    while (index < graphemes.length && this.segments.length) {
      const head = this.segments[0]!;
      const take = Math.min(head.count, graphemes.length - index);
      head.publish(graphemes.slice(index, index + take).join(""));
      head.count -= take;
      index += take;
      if (head.count === 0) this.segments.shift();
    }
  }

  private finish(): void {
    this.lastFrameAt = undefined;
    this.queue.clear();
    const drain = this.drain;
    this.drain = undefined;
    drain?.resolve();
  }
}

/**
 * Collapses many updates into one per animation frame: `run` is called once with the latest scheduled work.
 * `flush` runs pending work now (before a block closes or the run ends, so nothing is left behind).
 */
export class FrameCoalescer {
  private frame: FrameHandle | undefined;
  private pending: (() => void) | undefined;

  schedule(work: () => void): void {
    this.pending = work;
    if (this.frame) return;
    this.frame = requestFrame(() => {
      this.frame = undefined;
      this.flush();
    });
  }

  flush(): void {
    cancelFrame(this.frame);
    this.frame = undefined;
    const work = this.pending;
    this.pending = undefined;
    work?.();
  }

  cancel(): void {
    cancelFrame(this.frame);
    this.frame = undefined;
    this.pending = undefined;
  }
}
