// Firefly 网格隐藏与命中区域解析（桌宠窗口）。
//
// - HIDDEN_DRAWABLE_IDS：按网格隐藏的场景物（饮料、蛋糕盘、桌子）。不修改模型文件，
//   通过覆盖 coreModel.getDrawableOpacity 让这些网格的不透明度恒为 0；渲染与命中都读取该值。
// - NON_BODY_DRAWABLE_IDS：不属于角色的场景网格（隐藏的桌子三件、椅子、脚下影子）。
//   ArtMesh23（脸部中间的一小块）是角色网格，不在此列。
// - 命中区域（按位置划分）：先找到点击处可见、非场景的角色网格；有命中后，
//   用点击点的模型坐标 y 划分：y >= HEAD_MIN_Y 为 Head，否则为 Body。

/** 按网格隐藏的场景物：饮料、蛋糕盘、桌子。 */
export const HIDDEN_DRAWABLE_IDS: readonly string[] = ["ArtMesh153", "ArtMesh154", "ArtMesh155"];

/**
 * 不属于角色、不参与命中的场景网格。
 * - ArtMesh153 / 154 / 155：饮料、蛋糕盘、桌子（被隐藏，不可见，也不可命中）。
 * - ArtMesh156：椅子，保持可见但不触发身体或头部。
 * - ArtMesh157：脚下影子，保持可见但不触发身体或头部。
 */
export const NON_BODY_DRAWABLE_IDS: ReadonlySet<string> = new Set([
  "ArtMesh153",
  "ArtMesh154",
  "ArtMesh155",
  "ArtMesh156",
  "ArtMesh157",
]);

/**
 * Head / Body 的纵向分界（Cubism 模型单位，y 向上）。点击点 y >= HEAD_MIN_Y 为 Head，否则为 Body。
 * 依据（预览页标定）：嘴部网格 ArtMesh57 在 y≈0~0.01，下巴约 -0.05，领口/脖子约 -0.06；
 * 头发最高到 y≈0.39；躯干与腿的网格都在 y < -0.06。用户可按体感调整这个常量。
 */
export const HEAD_MIN_Y = -0.06;

/** 本模块用到的 Cubism 核心模型方法（运行时即 CubismModel；pixi-live2d-display 的类型对 coreModel 收窄为 object）。 */
export interface FireflyCoreModel {
  getDrawableIndex(drawableId: string): number;
  getDrawableOpacity(drawableIndex: number): number;
  /** 模型单位（y 向上）的顶点坐标，x、y 交替排列。 */
  getDrawableVertices(drawableIndex: number): Float32Array;
  getDrawableVertexIndices(drawableIndex: number): Uint16Array;
}

/** 画布坐标与模型坐标的换算参数（pixi-live2d-display InternalModel 的字段）。 */
export interface CanvasModelSpace {
  pixelsPerUnit: number;
  originalWidth: number;
  originalHeight: number;
}

/**
 * 把 InternalModel 的画布像素坐标换回模型单位。与库内 getDrawableVertices 的正变换互逆：
 *   px = mx * pixelsPerUnit + originalWidth / 2
 *   py = -my * pixelsPerUnit + originalHeight / 2
 */
export function canvasToModelPoint(
  px: number,
  py: number,
  space: CanvasModelSpace,
): { x: number; y: number } {
  return {
    x: (px - space.originalWidth / 2) / space.pixelsPerUnit,
    y: (space.originalHeight / 2 - py) / space.pixelsPerUnit,
  };
}

/**
 * 覆盖 coreModel.getDrawableOpacity：hidden 网格返回 0，其它网格调用原函数。
 * 渲染器与命中判定都经由 core 实例读取不透明度，因此覆盖对二者同时生效。
 * 返回恢复函数（dispose 时调用）。
 */
export function installHiddenDrawableGuard(
  core: Pick<FireflyCoreModel, "getDrawableIndex" | "getDrawableOpacity">,
  drawableIds: readonly string[] = HIDDEN_DRAWABLE_IDS,
): () => void {
  const hidden = new Set(
    drawableIds.map((id) => core.getDrawableIndex(id)).filter((index) => index >= 0),
  );
  const original = core.getDrawableOpacity;
  core.getDrawableOpacity = function (this: unknown, index: number): number {
    return hidden.has(index) ? 0 : original.call(this, index);
  };
  return () => {
    core.getDrawableOpacity = original;
  };
}

/** 点 (px, py) 是否落在三角形 abc 内（含边界）。 */
export function pointInTriangle(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

export interface HitRegionDrawable {
  index: number;
  id: string;
  /** 当前不透明度（已包含隐藏覆盖）。 */
  opacity: number;
}

export interface ResolveHitRegionsInput {
  drawables: readonly HitRegionDrawable[];
  /** 不参与命中的场景网格 ID（见 NON_BODY_DRAWABLE_IDS）。 */
  excludedDrawableIds: ReadonlySet<string>;
  /** 指定网格（按 index）是否包含该点（点为模型单位）。 */
  isPointInDrawable: (index: number) => boolean;
  /** 点击点的模型坐标 y（模型单位，y 向上）。 */
  pointModelY: number;
  /** Head / Body 的纵向分界，默认 HEAD_MIN_Y。 */
  headMinY?: number;
}

/**
 * 解析点击命中的区域名：返回 ["Head"]、["Body"] 或 []。
 * 1. 在可见（opacity > 0）且不在排除集合中的角色网格里找命中点的网格；没有命中返回 []。
 * 2. 有命中后按点击点的模型坐标 y 划分：y >= headMinY 为 Head，否则为 Body。
 * 角色网格（包括脸部的 ArtMesh23 等）一视同仁；Head 与 Body 只由位置决定。
 */
export function resolveFireflyHitRegions(input: ResolveHitRegionsInput): string[] {
  const threshold = input.headMinY ?? HEAD_MIN_Y;
  const hit = input.drawables.some((drawable) => {
    if (input.excludedDrawableIds.has(drawable.id)) return false;
    if (!(drawable.opacity > 0)) return false;
    return input.isPointInDrawable(drawable.index);
  });
  if (!hit) return [];
  return [input.pointModelY >= threshold ? "Head" : "Body"];
}
