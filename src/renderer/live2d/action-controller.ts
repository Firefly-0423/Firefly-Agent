import type { Live2DExpressionTarget } from "../../shared/live2d-actions";
import type { Live2DManager } from "./manager";
import type { FireflyExpressionState } from "./expression-state";

/**
 * 播放双击触发的临时表情。播放期间拒绝新的请求；表情结束后恢复到当前基础表情。
 */
export class FireflyActionController {
  private readonly manager: Pick<Live2DManager, "hasAction" | "playAction">;
  private readonly expressions: Pick<FireflyExpressionState, "trigger" | "suspend" | "resume">;
  private busy = false;
  private disposed = false;

  constructor(
    manager: Pick<Live2DManager, "hasAction" | "playAction">,
    expressions: Pick<FireflyExpressionState, "trigger" | "suspend" | "resume">,
  ) {
    this.manager = manager;
    this.expressions = expressions;
  }

  isBusy(): boolean {
    return this.busy;
  }

  /** 返回表情是否已确认开始播放。 */
  async play(target: Live2DExpressionTarget, durationMs: number): Promise<boolean> {
    if (this.disposed || this.busy) return false;
    if (!this.manager.hasAction(target)) return false;
    this.busy = true;
    this.expressions.suspend();
    const started = await this.manager.playAction(target);
    if (this.disposed) return false;
    if (!started) {
      await this.expressions.resume();
      this.busy = false;
      return false;
    }
    this.expressions.trigger(durationMs, () => {
      this.busy = false;
    });
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.busy = false;
  }
}
