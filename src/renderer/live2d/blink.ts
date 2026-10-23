import type { Live2DModel } from "pixi-live2d-display/cubism4";

type EyeParameters = { setParameterValueById?: (id: string, value: number) => void };
type BlinkHooks = {
  coreModel?: EyeParameters;
  off?: (event: string, cb: () => void) => unknown;
  on?: (event: string, cb: () => void) => unknown;
};
const blinkDelay = (): number => 2500 + Math.random() * (6000 - 2500);
export class BlinkController {
  private readonly avatar: Live2DModel;
  private detachCallback: (() => void) | null = null;
  private ended = false;
  private deadline = 0;
  private startedAt = 0;

  constructor(model: Live2DModel) {
    this.avatar = model;
    this.deadline = performance.now() + blinkDelay();
    const hooks = model.internalModel as unknown as BlinkHooks;
    if (typeof hooks.on !== "function" || typeof hooks.off !== "function") return;
    this.detachCallback = () => this.advance();
    hooks.on("beforeModelUpdate", this.detachCallback);
  }
  dispose(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.detachCallback === null) return;
    const hooks = this.avatar.internalModel as unknown as BlinkHooks;
    try { hooks.off?.("beforeModelUpdate", this.detachCallback); }
    catch { /* 失败时维持现有流程。 */ }
    this.detachCallback = null;
  }
  private advance(): void {
    const timestamp = performance.now();
    if (timestamp < this.deadline) { this.writeEyes(1); return; }
    if (this.startedAt === 0) this.startedAt = timestamp;
    const age = timestamp - this.startedAt;
    if (age >= 70 + 140) {
      this.startedAt = 0;
      this.deadline = timestamp + blinkDelay();
      this.writeEyes(1);
      return;
    }
    const openness = age < 70 ? 1 - age / 70 : (age - 70) / 140;
    this.writeEyes(openness * openness * (3 - 2 * openness));
  }
  private writeEyes(value: number): void {
    try {
      const parameters = (this.avatar.internalModel as unknown as { coreModel?: EyeParameters }).coreModel;
      if (!parameters || typeof parameters.setParameterValueById !== "function") return;
      for (const parameter of ["ParamEyeLOpen", "ParamEyeROpen"] as const) {
        parameters.setParameterValueById(parameter, value);
      }
    } catch { /* 失败时维持现有流程。 */ }
  }
}
