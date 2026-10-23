import type { Live2DManager } from "./manager";

export interface ClickThroughOptions {
  onInteractive?: (interactive: boolean) => void;
  alphaThreshold?: number;
}
export class ClickThroughController {
  private readonly surface: HTMLCanvasElement;
  private readonly renderer: Live2DManager;
  private readonly cutoff: number;
  private readonly notify?: (interactive: boolean) => void;
  private frame: number | null = null;
  private cursor: { x: number; y: number } | null = null;
  private lastHit: boolean | null = null;
  private suspended = false;
  private ended = false;

  constructor(canvas: HTMLCanvasElement, manager: Live2DManager, options: ClickThroughOptions = {}) {
    this.surface = canvas;
    this.renderer = manager;
    this.cutoff = options.alphaThreshold ?? 10;
    this.notify = options.onInteractive;
    canvas.addEventListener("pointermove", this.receive);
  }
  pause(): void { this.suspended = true; this.dropFrame(); }
  resume(): void {
    if (this.ended) return;
    this.suspended = false;
    this.lastHit = null;
  }
  dispose(): void {
    if (this.ended) return;
    this.ended = true;
    this.dropFrame();
    this.surface.removeEventListener("pointermove", this.receive);
  }
  private receive = (pointer: PointerEvent): void => {
    if (this.ended || this.suspended) return;
    this.cursor = { x: pointer.clientX, y: pointer.clientY };
    if (this.frame === null) this.frame = requestAnimationFrame(this.sample);
  };
  private sample = (): void => {
    this.frame = null;
    if (this.ended || this.suspended) return;
    const location = this.cursor;
    this.cursor = null;
    if (!location) return;
    const hit = this.hitTestAlpha(location.x, location.y);
    if (hit === this.lastHit) return;
    this.lastHit = hit;
    this.notify?.(hit);
  };
  private hitTestAlpha(cssX: number, cssY: number): boolean {
    const context = this.renderer.getGL();
    if (!context) return true;
    const bounds = this.surface.getBoundingClientRect();
    const density = window.devicePixelRatio || 1;
    const pixelX = Math.floor((cssX - bounds.left) * density);
    const pixelY = Math.floor((cssY - bounds.top) * density);
    if (pixelX < 0 || pixelY < 0 || pixelX >= context.drawingBufferWidth || pixelY >= context.drawingBufferHeight) return false;
    const row = context.drawingBufferHeight - 1 - pixelY;
    const rgba = new Uint8Array(4);
    context.readPixels(pixelX, row, 1, 1, context.RGBA, context.UNSIGNED_BYTE, rgba);
    return rgba[3] >= this.cutoff;
  }
  private dropFrame(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.cursor = null;
  }
}
