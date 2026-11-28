export class TimeoutClock {
  private readonly created: number;
  private usedActive = 0;
  private runningSince: number | null = null;
  private waitingSince: number | null = null;
  private usedWaiting = 0;
  private onDeadline: (() => void) | null = null;
  private alarm: ReturnType<typeof setTimeout> | null = null;
  constructor(private totalTimeoutMs: number, private userWaitTimeoutMs: number) { this.created = Date.now(); }

  startActive(): void {
    if (this.runningSince !== null) return;
    this.runningSince = Date.now();
    this.armDeadline();
  }
  stopActive(): void {
    this.clearDeadline();
    if (this.runningSince === null) return;
    this.usedActive += Date.now() - this.runningSince;
    this.runningSince = null;
  }
  setDeadlineHandler(handler: (() => void) | null): void {
    this.onDeadline = handler;
    if (!handler) this.clearDeadline();
    else this.armDeadline();
  }
  private armDeadline(): void {
    this.clearDeadline();
    if (!this.onDeadline || this.runningSince === null) return;
    if (this.totalTimeoutMs <= 0 || !Number.isFinite(this.totalTimeoutMs)) return;
    const scheduled = setTimeout(() => {
      this.alarm = null;
      const callback = this.onDeadline;
      this.onDeadline = null;
      callback?.();
    }, this.remainingExecutionMs());
    scheduled.unref?.();
    this.alarm = scheduled;
  }
  private clearDeadline(): void {
    if (this.alarm === null) return;
    clearTimeout(this.alarm);
    this.alarm = null;
  }
  startUserWait(): void {
    this.stopActive();
    this.waitingSince = Date.now();
  }
  stopUserWait(): void {
    if (this.waitingSince !== null) {
      this.usedWaiting += Date.now() - this.waitingSince;
      this.waitingSince = null;
    }
    this.startActive();
  }
  getActiveExecutionMs(): number {
    return this.usedActive + (this.runningSince !== null ? Date.now() - this.runningSince : 0);
  }
  getUserWaitMs(): number {
    return this.usedWaiting + (this.waitingSince !== null ? Date.now() - this.waitingSince : 0);
  }
  getTotalElapsedMs(): number { return Date.now() - this.created; }
  isExecutionTimeout(): boolean {
    if (this.totalTimeoutMs <= 0 || !Number.isFinite(this.totalTimeoutMs)) return false;
    return this.getActiveExecutionMs() >= this.totalTimeoutMs;
  }
  isUserWaitTimeout(): boolean { return this.getUserWaitMs() >= this.userWaitTimeoutMs; }
  remainingExecutionMs(): number {
    if (this.totalTimeoutMs <= 0 || !Number.isFinite(this.totalTimeoutMs)) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.totalTimeoutMs - this.getActiveExecutionMs());
  }
}
