import type { Live2DModel } from "pixi-live2d-display/cubism4";
export interface FocusOptions { pollIntervalMs?: number; }

export class MouseFocusController {
  private readonly surface: HTMLCanvasElement;
  private readonly avatar: Live2DModel;
  private readonly interval: number;
  private suspended = false;
  private ended = false;
  private timer: number | null = null;
  private frame: number | null = null;
  private inFlight = false;
  private cursor: { x: number; y: number } | null = null;

  constructor(canvas: HTMLCanvasElement, model: Live2DModel, options: FocusOptions = {}) {
    this.surface = canvas;
    this.avatar = model;
    this.interval = options.pollIntervalMs ?? 50;
    canvas.addEventListener("pointermove", this.receive);
    this.beginPolling();
  }
  pause(reset = false): void {
    this.suspended = true;
    this.dropFrame();
    this.endPolling();
    if (reset) this.focusCenter();
  }
  resume(): void {
    if (this.ended) return;
    this.suspended = false;
    this.beginPolling();
  }
  focusCenter(instant = false): void {
    const bounds = this.surface.getBoundingClientRect();
    this.avatar.focus(bounds.width / 2, bounds.height / 2, instant);
  }
  dispose(): void {
    if (this.ended) return;
    this.ended = true;
    this.dropFrame();
    this.endPolling();
    this.surface.removeEventListener("pointermove", this.receive);
  }
  private receive = (pointer: PointerEvent): void => {
    if (this.ended || this.suspended) return;
    this.enqueue(pointer.clientX, pointer.clientY);
  };
  private beginPolling(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => { void this.readCursor(); }, this.interval);
    void this.readCursor();
  }
  private endPolling(): void {
    if (this.timer === null) return;
    window.clearInterval(this.timer);
    this.timer = null;
  }
  private async readCursor(): Promise<void> {
    if (this.ended || this.suspended || this.inFlight) return;
    this.inFlight = true;
    try {
      const location = await window.firefly.getCursorPosition();
      if (!location || this.ended || this.suspended) return;
      this.enqueue(location.x - window.screenX, location.y - window.screenY);
    } finally { this.inFlight = false; }
  }
  private enqueue(x: number, y: number): void {
    this.cursor = { x, y };
    if (this.frame === null) this.frame = requestAnimationFrame(this.applyCursor);
  }
  private applyCursor = (): void => {
    this.frame = null;
    if (!this.cursor || this.suspended || this.ended) return;
    this.avatar.focus(this.cursor.x, this.cursor.y);
    this.cursor = null;
  };
  private dropFrame(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.cursor = null;
  }
}
