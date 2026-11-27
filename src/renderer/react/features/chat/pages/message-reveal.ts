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

export type PacerOptions = {
  baseRate: number;
  maxRate: number;
  backlogGain: number;
  maxPerFrame: number;
  maxFrameMs: number;
  smoothingMs: number;
};

export const DEFAULT_PACER_OPTIONS: PacerOptions = {
  baseRate: 60,
  maxRate: 400,
  backlogGain: 4,
  maxPerFrame: 4,
  maxFrameMs: 50,
  smoothingMs: 120,
};

function hasIncompleteTrailingCluster(cluster: string): boolean {
  if (!cluster) return false;
  const lastCode = cluster.charCodeAt(cluster.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) return true;
  if (lastCode === 0x200d || lastCode === 0x0d) return true;
  // Odd number of trailing Regional Indicator symbols (U+1F1E6..U+1F1FF) can pair with the next delta.
  const points = [...cluster];
  let ri = 0;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const cp = points[i]!.codePointAt(0)!;
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) ri += 1;
    else break;
  }
  return ri % 2 === 1;
}

type TargetBuffer = {
  key: string;
  publish: (chunk: string) => void;
  ready: string[];
  tail: string;
};

/**
 * Per-frame fractional-credit pacer. Preserves trailing potentially-incomplete grapheme clusters per target
 * without re-splitting already released groups, clamps long frame deltas, and clears credit when idle.
 */
export class FramePacer {
  private readonly options: PacerOptions;
  private targets: TargetBuffer[] = [];
  private credit = 0;
  private rate: number;
  private started = false;

  constructor(options: Partial<PacerOptions> = {}) {
    this.options = Object.assign({}, DEFAULT_PACER_OPTIONS, options);
    this.rate = this.options.baseRate;
  }

  get backlog(): number {
    let total = 0;
    for (const target of this.targets) {
      total += target.ready.length + (target.tail ? 1 : 0);
    }
    return total;
  }

  get safeBacklog(): number {
    let total = 0;
    for (let i = 0; i < this.targets.length; i += 1) {
      const target = this.targets[i]!;
      const closed = i < this.targets.length - 1;
      total += target.ready.length + (target.tail && (closed || !hasIncompleteTrailingCluster(target.tail)) ? 1 : 0);
    }
    return total;
  }

  get hasPending(): boolean {
    return this.targets.length > 0;
  }

  get hasSafePending(): boolean {
    return this.safeBacklog > 0;
  }

  push(key: string, text: string, publish: (chunk: string) => void): void {
    if (!text) return;
    const last = this.targets[this.targets.length - 1];
    if (last && last.key === key) {
      last.publish = publish;
      const combined = splitGraphemes(last.tail + text);
      if (combined.length === 0) return;
      if (combined.length > 1) last.ready.push(...combined.slice(0, -1));
      last.tail = combined[combined.length - 1]!;
      return;
    }
    // A new target closes the previous target's tail so its trailing grapheme cannot wait for more deltas.
    if (last && last.tail) {
      last.ready.push(last.tail);
      last.tail = "";
    }
    const parts = splitGraphemes(text);
    if (parts.length === 0) return;
    this.targets.push({
      key,
      publish,
      ready: parts.slice(0, -1),
      tail: parts[parts.length - 1]!,
    });
  }

  /** Settles one rAF frame and emits at most one publish callback for the current head target. */
  tick(dtMs: number): { publish: (chunk: string) => void; chunk: string } | null {
    const safe = this.safeBacklog;
    if (safe === 0) {
      if (this.targets.length === 0) {
        this.credit = 0;
        this.started = false;
        this.rate = this.options.baseRate;
      }
      return null;
    }
    const dt = Math.min(Math.max(dtMs, 0), this.options.maxFrameMs);
    const targetRate = Math.min(this.options.maxRate, this.options.baseRate + safe * this.options.backlogGain);
    const alpha = this.options.smoothingMs > 0 ? 1 - Math.exp(-dt / this.options.smoothingMs) : 1;
    this.rate += (targetRate - this.rate) * alpha;
    this.credit = Math.min(this.options.maxPerFrame, this.credit + (this.rate * dt) / 1000);

    const head = this.targets[0]!;
    const headAvailable = this.headSafeCount(head, this.targets.length > 1);
    if (headAvailable === 0) return null;

    let count: number;
    if (!this.started) {
      this.started = true;
      count = Math.min(this.options.maxPerFrame, headAvailable, Math.max(1, Math.floor(this.credit)));
    } else {
      count = Math.min(this.options.maxPerFrame, headAvailable, Math.floor(this.credit));
    }
    if (count === 0) return null;
    this.credit = Math.max(0, this.credit - count);
    return this.takeFromHead(count);
  }

  /** Fast-drain step for completion within remainingMs; emits at most one publish callback per frame. */
  finishTick(dtMs: number, remainingMs: number): Array<{ publish: (chunk: string) => void; chunk: string }> {
    if (this.targets.length === 0) return [];
    if (remainingMs <= 0) return this.drainAll();
    const total = this.backlog;
    const share = Math.max(1, Math.ceil(total * Math.min(1, Math.max(dtMs, 1) / remainingMs)));
    const head = this.targets[0]!;
    const headTotal = head.ready.length + (head.tail ? 1 : 0);
    const taken = this.takeFromHead(Math.min(share, headTotal), true);
    return taken ? [taken] : [];
  }

  drainAll(): Array<{ publish: (chunk: string) => void; chunk: string }> {
    const out: Array<{ publish: (chunk: string) => void; chunk: string }> = [];
    for (const target of this.targets) {
      const text = target.ready.join("") + target.tail;
      if (text) out.push({ publish: target.publish, chunk: text });
    }
    this.clear();
    return out;
  }

  clear(): void {
    this.targets = [];
    this.credit = 0;
    this.started = false;
    this.rate = this.options.baseRate;
  }

  private headSafeCount(head: TargetBuffer, closed: boolean): number {
    if (head.ready.length > 0) return head.ready.length;
    if (head.tail && (closed || !hasIncompleteTrailingCluster(head.tail))) return 1;
    return 0;
  }

  private takeFromHead(count: number, allowIncompleteTail = false): { publish: (chunk: string) => void; chunk: string } | null {
    const head = this.targets[0];
    if (!head || count <= 0) return null;
    const closed = this.targets.length > 1 || allowIncompleteTail;
    if (head.ready.length === 0 && head.tail && (closed || !hasIncompleteTrailingCluster(head.tail))) {
      head.ready.push(head.tail);
      head.tail = "";
    }
    const take = Math.min(count, head.ready.length);
    let chunk = head.ready.splice(0, take).join("");
    if (take < count && head.tail && (closed || !hasIncompleteTrailingCluster(head.tail))) {
      chunk += head.tail;
      head.tail = "";
    }
    if (head.ready.length === 0 && !head.tail) this.targets.shift();
    if (this.targets.length === 0) {
      this.credit = 0;
      this.started = false;
      this.rate = this.options.baseRate;
    }
    return chunk ? { publish: head.publish, chunk } : null;
  }
}

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
 * Legacy helper retained until Step 3 migrates candidate preview onto FramePacer.
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
    const targetRate = Math.min(maxRate, baseRate + this.pending.length * 0.9);
    const transitionMs = targetRate > this.currentRate ? accelerationMs : decelerationMs;
    const blend = 1 - Math.exp(-duration / Math.max(1, transitionMs));
    this.currentRate += (targetRate - this.currentRate) * blend;
    this.credit += (this.currentRate * duration) / 1000;

    const frameGroup = maxGroupSize * Math.max(1, Math.floor(duration / 50));
    let count = Math.min(frameGroup, this.pending.length, Math.floor(this.credit));
    if (count === 0) return "";
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
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    return { id: window.requestAnimationFrame(callback), raf: true };
  }
  if (typeof globalThis.requestAnimationFrame === "function") {
    return { id: globalThis.requestAnimationFrame(callback), raf: true };
  }
  return { id: setTimeout(() => callback(performance.now()), 16) as unknown as number, raf: false };
}

function cancelFrame(handle: FrameHandle | undefined): void {
  if (!handle) return;
  if (handle.raf) {
    if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(handle.id);
    } else if (typeof globalThis.cancelAnimationFrame === "function") {
      globalThis.cancelAnimationFrame(handle.id);
    }
    return;
  }
  clearTimeout(handle.id);
}

/**
 * Streams received text onto the screen at most once per animation frame via FramePacer.
 * - paced: characters come out smoothly via fractional-credit accumulation (max 4 graphemes/frame);
 * - not paced: everything queued appears on the next frame.
 * It only changes when text appears, never what appears.
 */
export class PacedTextReveal {
  private readonly pacer: FramePacer;
  private frame: FrameHandle | undefined;
  private lastFrameAt: number | undefined;
  private drain: { promise: Promise<void>; resolve: () => void } | undefined;

  constructor(private readonly paced: () => boolean, options?: Partial<PacerOptions>) {
    this.pacer = new FramePacer(options);
  }

  /** True while received text is still waiting to be shown. */
  get active(): boolean {
    return this.drain !== undefined;
  }

  /** Queues text for the target `key`; the promise settles once everything queued so far is on screen. */
  push(key: string, text: string, publish: (chunk: string) => void): Promise<void> {
    if (!text) return this.drain?.promise ?? Promise.resolve();
    this.pacer.push(key, text, publish);
    if (!this.pacer.hasPending) return this.drain?.promise ?? Promise.resolve();
    if (!this.drain) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      this.drain = { promise, resolve };
    }
    const { promise } = this.drain;
    this.schedule();
    return promise;
  }

  /** Drops whatever has not been shown yet (the run failed or was cancelled). */
  cancel(): void {
    cancelFrame(this.frame);
    this.frame = undefined;
    this.lastFrameAt = undefined;
    this.pacer.clear();
    this.finish();
  }

  private schedule(): void {
    if (this.frame) return;
    if (!this.pacer.hasPending) {
      this.finish();
      return;
    }
    if (this.paced() && !this.pacer.hasSafePending) return;
    this.frame = requestFrame((now) => {
      this.frame = undefined;
      if (!this.paced()) {
        for (const item of this.pacer.drainAll()) item.publish(item.chunk);
      } else {
        const dt = this.lastFrameAt === undefined ? 16 : Math.max(0, now - this.lastFrameAt);
        this.lastFrameAt = now;
        const emission = this.pacer.tick(dt);
        if (emission) emission.publish(emission.chunk);
      }
      this.schedule();
    });
  }

  private finish(): void {
    this.lastFrameAt = undefined;
    this.pacer.clear();
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
