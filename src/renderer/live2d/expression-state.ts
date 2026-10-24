import type { Live2DModel } from "pixi-live2d-display/cubism4";
import { LIVE2D_DEFAULT_EXPRESSION } from "../../shared/live2d-actions";

export class FireflyExpressionState {
  private readonly model: Live2DModel;
  /** 当前基础表情：临时表情、手动动作结束后恢复到它。 */
  private baseExpression: string = LIVE2D_DEFAULT_EXPRESSION;
  private temporaryTimer: number | null = null;
  private resetTimer: number | null = null;
  private manualActive = false;
  private disposed = false;

  constructor(model: Live2DModel) {
    this.model = model;
    this.restart();
  }

  /** 当前基础表情名。 */
  getBase(): string {
    return this.baseExpression;
  }

  /**
   * 设置基础表情。空闲时立即应用；临时表情或手动动作在播时只记录，
   * 等它们结束后的恢复步骤再生效。
   */
  async setBase(name: string): Promise<boolean> {
    if (this.disposed) return false;
    this.baseExpression = name;
    return this.resetNow();
  }

  suspend(): void {
    this.manualActive = true;
  }

  async resume(): Promise<boolean> {
    this.manualActive = false;
    return this.resetNow();
  }

  trigger(durationMs: number, onFinished: (restored: boolean) => void): void {
    if (this.disposed) return;
    this.manualActive = true;
    if (this.temporaryTimer !== null) window.clearTimeout(this.temporaryTimer);
    this.temporaryTimer = window.setTimeout(() => {
      this.temporaryTimer = null;
      void this.resume().then(onFinished);
    }, durationMs);
    this.restart();
  }

  /** 恢复到当前基础表情；临时表情或手动动作在播时不做任何事。 */
  async resetNow(): Promise<boolean> {
    if (this.disposed || this.temporaryTimer !== null || this.manualActive) return false;
    try {
      return await this.model.expression(this.baseExpression);
    } catch (error) {
      console.warn("[Firefly] expression restore failed", error);
      return false;
    }
  }

  restart(): void {
    if (this.disposed) return;
    if (this.resetTimer !== null) window.clearInterval(this.resetTimer);
    this.resetTimer = window.setInterval(() => {
      if (this.temporaryTimer === null && !this.manualActive) void this.resetNow();
    }, 3 * 60 * 1000);
  }

  dispose(): void {
    this.disposed = true;
    if (this.temporaryTimer !== null) window.clearTimeout(this.temporaryTimer);
    if (this.resetTimer !== null) window.clearInterval(this.resetTimer);
    this.temporaryTimer = null;
    this.resetTimer = null;
  }
}
