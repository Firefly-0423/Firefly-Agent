import type { DesktopAsrApi } from "../../../../../shared/desktop-asr";
export type DictationState = "idle" | "starting" | "recording" | "stopping";
export interface DictationCapture { stop(): Promise<void>; cancel(): void }
interface Attempt {
  id: string; phase: DictationState; abort: AbortController; capture?: DictationCapture;
  queue: Promise<void>; pending: number; timer?: ReturnType<typeof setTimeout>;
}
/** One composer owns one controller. Disposal invalidates all late async results. */
export class DesktopAsrController {
  private active?: Attempt;
  private disposed = false;
  constructor(private readonly deps: {
    api: DesktopAsrApi;
    capture: (signal: AbortSignal, onFrame: (pcm: Uint8Array) => void, onError: (code: string) => void) => Promise<DictationCapture>;
    isFocused?: () => boolean;
    onText: (text: string) => void;
    onState: (state: DictationState, error?: string) => void;
  }) {}
  async start(): Promise<void> {
    if (this.active || this.disposed) return;
    const startedAt = Date.now();
    const attempt: Attempt = { id: crypto.randomUUID(), phase: "starting", abort: new AbortController(), queue: Promise.resolve(), pending: 0 };
    this.active = attempt; this.deps.onState("starting");
    attempt.timer = setTimeout(() => { if (this.active === attempt) this.cancel("timeout"); }, 30_000);
    try {
      const result = await this.deps.api.start(attempt.id);
      if (this.active !== attempt) return;
      if (!result.ok) { this.cancel(result.code); return; }
      if (this.deps.isFocused?.() === false) { this.cancel("cancelled"); return; }
      const capture = await this.deps.capture(attempt.abort.signal, pcm => this.frame(attempt, pcm), error => { if (this.active === attempt) this.cancel(error); });
      if (this.active !== attempt) { capture.cancel(); return; }
      if (this.deps.isFocused?.() === false) { capture.cancel(); this.cancel("cancelled"); return; }
      attempt.capture = capture; attempt.phase = "recording";
      clearTimeout(attempt.timer);
      // Leave time for permission/setup inside Main's two-minute limit.
      attempt.timer = setTimeout(() => { if (this.active === attempt) void this.stop(); }, Math.max(0, 110_000 - (Date.now() - startedAt)));
      this.deps.onState("recording");
    } catch (error) {
      if (this.active === attempt) this.cancel(error instanceof Error && error.name === "NotAllowedError" ? "microphone_denied" : "microphone_error");
    }
  }
  async stop(): Promise<void> {
    const attempt = this.active;
    if (!attempt || attempt.phase !== "recording") return;
    attempt.phase = "stopping"; clearTimeout(attempt.timer); this.deps.onState("stopping");
    attempt.timer = setTimeout(() => { if (this.active === attempt) this.cancel("timeout"); }, 30_000);
    try {
      await attempt.capture?.stop();
      await attempt.queue;
      if (this.active !== attempt) return;
      const result = await this.deps.api.stop(attempt.id);
      if (this.active !== attempt) return;
      if (!result.ok) { this.cancel(result.code); return; }
      this.finish(attempt);
      if (result.text?.trim()) this.deps.onText(result.text.trim());
      else this.deps.onState("idle", "empty");
    } catch { if (this.active === attempt) this.cancel("service_error"); }
  }
  cancel(error?: string): void {
    const attempt = this.active;
    if (!attempt) return;
    this.finish(attempt, error);
    void this.deps.api.cancel(attempt.id).catch(() => {});
  }
  dispose(): void { this.cancel(); this.disposed = true; }
  private finish(attempt: Attempt, error?: string): void {
    this.active = undefined; clearTimeout(attempt.timer); attempt.abort.abort(); attempt.capture?.cancel();
    if (!this.disposed) this.deps.onState("idle", error);
  }
  private frame(attempt: Attempt, pcm: Uint8Array): void {
    if (this.active !== attempt || (attempt.phase !== "recording" && attempt.phase !== "stopping")) return;
    if (++attempt.pending > 8) { this.cancel("limit"); return; }
    attempt.queue = attempt.queue.then(async () => {
      if (this.active !== attempt) return;
      const result = await this.deps.api.frame(attempt.id, pcm);
      if (!result.ok && this.active === attempt) this.cancel(result.code);
    }).catch(() => { if (this.active === attempt) this.cancel("service_error"); }).finally(() => { attempt.pending--; });
  }
}
