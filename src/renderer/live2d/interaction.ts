import type { Live2DModel } from "pixi-live2d-display/cubism4";
import type { Live2DExpressionTarget } from "../../shared/live2d-actions";

/** 两次点击被视为双击的最长间隔（毫秒）。 */
const DOUBLE_CLICK_WINDOW_MS = 300;

/**
 * Resolved hit area of the Live2D model. Only the name matters for the
 * interaction rules: it selects which double-click expression table applies.
 */
export interface HitAreaDef {
  name: string;
  id: string;
}

interface WeightedExpression {
  name: string;
  weight: number;
}

/** 双击头部：expression2 占 75%，expression1 占 25%。 */
const HEAD_DOUBLE_CLICK: readonly WeightedExpression[] = [
  { name: "expression2", weight: 75 },
  { name: "expression1", weight: 25 },
];

/** 双击身体：expression9 与 expression10 各 50%。 */
const BODY_DOUBLE_CLICK: readonly WeightedExpression[] = [
  { name: "expression9", weight: 50 },
  { name: "expression10", weight: 50 },
];

function pickWeighted(entries: readonly WeightedExpression[], rand: () => number): string {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  const roll = rand() * total;
  let accumulated = 0;
  for (const entry of entries) {
    accumulated += entry.weight;
    if (roll < accumulated) return entry.name;
  }
  return entries[entries.length - 1].name;
}

/**
 * 按双击的命中区域选择临时表情。纯函数：随机源可注入，便于确定性单测。
 * - Head：expression2（75%）或 expression1（25%）
 * - Body：expression9 或 expression10（各 50%）
 * - 其它区域：无动作，返回 undefined
 */
export function pickDoubleClickTarget(areaName: string, rand: () => number = Math.random): Live2DExpressionTarget | undefined {
  const table = areaName === "Head" ? HEAD_DOUBLE_CLICK : areaName === "Body" ? BODY_DOUBLE_CLICK : null;
  if (!table) return undefined;
  return { kind: "expression", name: pickWeighted(table, rand) };
}

export type InteractionOptions = {
  playAction?: (target: Live2DExpressionTarget) => Promise<boolean>;
  onMiss?: (area: HitAreaDef, target: Live2DExpressionTarget) => void;
  onTrigger?: (area: HitAreaDef, target: Live2DExpressionTarget) => void;
  /**
   * 屏幕点 → 命中区域名。默认使用模型 HitAreas（model.hitTest）；桌宠窗口传入
   * 自定义解析（Head 沿用 HitAreas，Body 只取可见网格，见 manager.hitTestRegions）。
   */
  resolveRegions?: (x: number, y: number) => string[];
  /** 双击随机源，默认 Math.random。 */
  random?: () => number;
  /** 按下到抬起之间，指针最远能移动多少 CSS 像素，超过就不算一次点击。 */
  clickThreshold?: number;
};

/**
 * 把 Live2D 画布上的双击映射为表情播放；单击不做任何动作。
 */
export class InteractionController {
  private readonly model: Live2DModel;
  private readonly canvas: HTMLCanvasElement;
  private readonly hitAreaByName: Map<string, HitAreaDef>;
  private readonly clickThreshold: number;
  private readonly random: () => number;
  private readonly resolveRegions: (x: number, y: number) => string[];
  private readonly onTrigger?: (area: HitAreaDef, target: Live2DExpressionTarget) => void;
  private readonly onMiss?: (area: HitAreaDef, target: Live2DExpressionTarget) => void;
  private readonly playAction?: (target: Live2DExpressionTarget) => Promise<boolean>;

  private downHits: HitAreaDef[] = [];
  private downPointerId: number | null = null;
  private downScreenX = 0;
  private downScreenY = 0;
  private playing = false;
  private pendingClick: { hits: HitAreaDef[]; screenX: number; screenY: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, model: Live2DModel, hitAreaDefs: HitAreaDef[], options: InteractionOptions = {}) {
    this.canvas = canvas;
    this.model = model;
    this.clickThreshold = options.clickThreshold ?? 5;
    this.random = options.random ?? Math.random;
    this.resolveRegions = options.resolveRegions ?? ((x, y) => this.model.hitTest(x, y));
    this.onTrigger = options.onTrigger;
    this.onMiss = options.onMiss;
    this.playAction = options.playAction;
    this.hitAreaByName = new Map(hitAreaDefs.map((def): [string, HitAreaDef] => [def.name, def]));

    canvas.addEventListener("pointerdown", this.handleDown);
    canvas.addEventListener("pointerup", this.handleUp);
    canvas.addEventListener("pointercancel", this.handleCancel);
  }

  private handleDown = (e: PointerEvent): void => {
    if (this.disposed || e.button !== 0) return;
    this.downPointerId = e.pointerId;
    this.downScreenX = e.screenX;
    this.downScreenY = e.screenY;
    this.downHits = this.resolveHits(e.clientX, e.clientY);
  };

  private handleUp = (e: PointerEvent): void => {
    if (this.disposed || e.pointerId !== this.downPointerId) return;
    this.downPointerId = null;
    const dx = e.screenX - this.downScreenX;
    const dy = e.screenY - this.downScreenY;
    const dist = Math.hypot(dx, dy);
    const hits = this.downHits;
    this.downHits = [];
    if (dist > this.clickThreshold || this.resolveHits(e.clientX, e.clientY).every((area) => !hits.includes(area))) return;
    if (hits.length === 0) return;

    const pending = this.pendingClick;
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingClick = null;
    }
    const sameArea = pending
      ? hits.find((current) => pending.hits.some((previous) => previous.name === current.name))
      : undefined;
    if (pending && sameArea && Math.hypot(e.screenX - pending.screenX, e.screenY - pending.screenY) <= this.clickThreshold) {
      const target = pickDoubleClickTarget(sameArea.name, this.random);
      if (target) void this.fire(sameArea, target);
      return;
    }
    // 第一次点击：等待窗口内的第二次点击；超时则视为单击，不做任何动作。
    const timer = setTimeout(() => {
      this.pendingClick = null;
    }, DOUBLE_CLICK_WINDOW_MS);
    this.pendingClick = { hits, screenX: e.screenX, screenY: e.screenY, timer };
  };

  private handleCancel = (): void => {
    this.downPointerId = null;
    this.downHits = [];
  };

  private resolveHits(x: number, y: number): HitAreaDef[] {
    const names = this.resolveRegions(x, y) ?? [];
    return names
      .map((name) => this.hitAreaByName.get(name))
      .filter((def): def is HitAreaDef => def !== undefined);
  }

  private async fire(area: HitAreaDef, target: Live2DExpressionTarget): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    try {
      if (await this.playAction?.(target)) this.onTrigger?.(area, target);
      else this.onMiss?.(area, target);
    } finally {
      this.playing = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pendingClick) clearTimeout(this.pendingClick.timer);
    this.pendingClick = null;
    this.canvas.removeEventListener("pointerdown", this.handleDown);
    this.canvas.removeEventListener("pointerup", this.handleUp);
    this.canvas.removeEventListener("pointercancel", this.handleCancel);
  }
}
