export const WINDOW_COORDINATE_LIMIT = 1_000_000;

export type WindowPosition = { x: number; y: number };

/** 非有限数字返回 null，否则四舍五入并夹在 ±WINDOW_COORDINATE_LIMIT 之间 */
export function normalizeWindowCoordinate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const clipped = Math.min(Math.round(value), WINDOW_COORDINATE_LIMIT);
  return Math.max(clipped, -WINDOW_COORDINATE_LIMIT);
}

export function normalizeWindowPosition(x: unknown, y: unknown): WindowPosition | null {
  const [nx, ny] = [normalizeWindowCoordinate(x), normalizeWindowCoordinate(y)];
  if (nx === null || ny === null) return null;
  return { x: nx, y: ny };
}
