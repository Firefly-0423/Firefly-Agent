// Layout of the right-hand panels: columns side by side, each column a vertical stack.
// Pure helpers, so moving and resizing can be tested without a DOM.

/** A column of stacked panels. `heights` holds each panel's share of the column (any unit); a missing one gets the column's average. */
export interface PanelColumn { ids: string[]; weight: number; heights?: Record<string, number> }
export type DropZone = "left" | "right" | "top" | "bottom";

/** No column is squeezed below this width (px) by the separators. */
export const MIN_COLUMN_WIDTH = 160;
/** No stacked panel is squeezed below this height (px) by the handle between two of them. */
export const MIN_PANE_HEIGHT = 96;

/** Each panel's share of its column, filling in the average for panels that have none yet. */
export function rowWeights(column: PanelColumn): number[] {
  const known = column.ids.map(id => column.heights?.[id]).filter((value): value is number => value !== undefined && value > 0);
  const fallback = known.length > 0 ? known.reduce((sum, value) => sum + value, 0) / known.length : 1;
  return column.ids.map(id => column.heights?.[id] && column.heights[id]! > 0 ? column.heights[id]! : fallback);
}

/** Drops closed panels, removes empty columns, and puts newly opened panels in a column of their own at the end. */
export function reconcileColumns(columns: readonly PanelColumn[], ids: readonly string[]): PanelColumn[] {
  const alive = columns.map(column => ({ ...column, ids: column.ids.filter(id => ids.includes(id)) })).filter(column => column.ids.length > 0);
  const known = new Set(alive.flatMap(column => column.ids));
  const weight = alive.length > 0 ? alive.reduce((sum, column) => sum + column.weight, 0) / alive.length : 1;
  return [...alive, ...ids.filter(id => !known.has(id)).map(id => ({ ids: [id], weight }))];
}

/** Moves a panel next to another one: a new column on its left or right, or into its column above or below it. */
export function movePanel(columns: readonly PanelColumn[], id: string, targetId: string, zone: DropZone): PanelColumn[] {
  if (id === targetId) return columns.map(column => ({ ...column, ids: [...column.ids] }));
  const weight = columns.find(column => column.ids.includes(targetId))?.weight ?? 1;
  const next = columns.map(column => {
    if (!column.ids.includes(id)) return { ...column, ids: [...column.ids] };
    const { [id]: _left, ...heights } = column.heights ?? {};
    return { ...column, ids: column.ids.filter(item => item !== id), heights };
  });
  const targetIndex = next.findIndex(column => column.ids.includes(targetId));
  if (targetIndex < 0) return columns.map(column => ({ ...column, ids: [...column.ids] }));
  if (zone === "left" || zone === "right") {
    next.splice(zone === "left" ? targetIndex : targetIndex + 1, 0, { ids: [id], weight });
  } else {
    const column = next[targetIndex]!;
    column.ids.splice(column.ids.indexOf(targetId) + (zone === "top" ? 0 : 1), 0, id);
  }
  return next.filter(column => column.ids.length > 0);
}

/** The keyboard move: one step left/right/up/down. Returns the same layout when there is nowhere to go. */
export function shiftPanel(columns: readonly PanelColumn[], id: string, direction: "left" | "right" | "up" | "down"): PanelColumn[] {
  const index = columns.findIndex(column => column.ids.includes(id));
  if (index < 0) return columns.map(column => ({ ...column, ids: [...column.ids] }));
  const column = columns[index]!;
  const at = column.ids.indexOf(id);
  if (direction === "up" || direction === "down") {
    const neighbour = column.ids[at + (direction === "up" ? -1 : 1)];
    return neighbour === undefined ? columns.map(item => ({ ...item, ids: [...item.ids] })) : movePanel(columns, id, neighbour, direction === "up" ? "top" : "bottom");
  }
  if (column.ids.length > 1) return movePanel(columns, id, column.ids.find(item => item !== id)!, direction);
  const beside = columns[index + (direction === "left" ? -1 : 1)];
  return beside === undefined ? columns.map(item => ({ ...item, ids: [...item.ids] })) : movePanel(columns, id, beside.ids[0]!, direction);
}

/** Moves the separator after column `index` so the column on its left is `leftPx` wide, keeping both at least the minimum. */
export function resizeColumns(columns: readonly PanelColumn[], index: number, widthsPx: readonly number[], leftPx: number): PanelColumn[] {
  const pair = (widthsPx[index] ?? 0) + (widthsPx[index + 1] ?? 0);
  const left = Math.max(MIN_COLUMN_WIDTH, Math.min(leftPx, pair - MIN_COLUMN_WIDTH));
  return columns.map((column, position) => ({
    ...column,
    // Weights become pixel widths: flex-grow then splits the row in exactly those proportions.
    weight: position === index ? left : position === index + 1 ? pair - left : (widthsPx[position] ?? column.weight),
  }));
}

/** Where a pointer over a panel would drop it: the outer thirds make a side-by-side column, the middle stacks. */
export function dropZoneAt(rect: { left: number; top: number; width: number; height: number }, x: number, y: number): DropZone {
  const across = (x - rect.left) / Math.max(1, rect.width);
  if (across < 0.3) return "left";
  if (across > 0.7) return "right";
  return y < rect.top + rect.height / 2 ? "top" : "bottom";
}

/**
 * CSS grid placement for every panel, so a move never re-parents (and so never remounts) a panel.
 * Every column's own cut lines are gathered into one set of rows; a panel spans the rows between its cuts,
 * so each column keeps its own panel heights while all panels share one grid.
 */
export function gridPlacement(columns: readonly PanelColumn[]): { rows: number; tracks: number[]; byId: Map<string, { column: number; row: number; span: number }> } {
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  const cutsByColumn = columns.map(column => {
    const weights = rowWeights(column);
    const total = weights.reduce((sum, value) => sum + value, 0) || 1;
    let at = 0;
    return [0, ...weights.map(value => round((at += value) / total))];
  });
  const cuts = [...new Set(cutsByColumn.flat())].sort((x, y) => x - y);
  const tracks = cuts.slice(1).map((cut, index) => round(cut - cuts[index]!));
  const byId = new Map<string, { column: number; row: number; span: number }>();
  columns.forEach((column, index) => {
    const own = cutsByColumn[index]!;
    // Tracks alternate panel column / 8px separator, so panel column n sits on track 2n + 1.
    column.ids.forEach((id, at) => {
      const start = cuts.indexOf(own[at]!), end = cuts.indexOf(own[at + 1]!);
      byId.set(id, { column: index * 2 + 1, row: start + 1, span: end - start });
    });
  });
  return { rows: tracks.length, tracks, byId };
}

/** Moves the handle under panel `index` of column `columnIndex` so that panel is `topPx` tall, keeping both at least the minimum. */
export function resizeRows(columns: readonly PanelColumn[], columnIndex: number, index: number, heightsPx: readonly number[], topPx: number): PanelColumn[] {
  return columns.map((column, position) => {
    if (position !== columnIndex) return column;
    const pair = (heightsPx[index] ?? 0) + (heightsPx[index + 1] ?? 0);
    const top = Math.max(MIN_PANE_HEIGHT, Math.min(topPx, pair - MIN_PANE_HEIGHT));
    // Heights become pixels, so the grid splits the column in exactly those proportions.
    const heights = Object.fromEntries(column.ids.map((id, at) => [id, at === index ? top : at === index + 1 ? pair - top : (heightsPx[at] ?? 1)]));
    return { ...column, heights };
  });
}

/**
 * The outer side of the whole panel area a drop would dock to, or null when the drop only lands between panels.
 * The lifted panel is taken out first: a panel next to its own slot becomes the outermost one once it has left.
 */
export function dockEdge(columns: readonly PanelColumn[], dragId: string, targetId: string, zone: DropZone): DropZone | null {
  const rest = columns.map(column => ({ ...column, ids: column.ids.filter(id => id !== dragId) })).filter(column => column.ids.length > 0);
  const index = rest.findIndex(column => column.ids.includes(targetId));
  if (index < 0) return null;
  const ids = rest[index]!.ids;
  if (zone === "left") return index === 0 ? "left" : null;
  if (zone === "right") return index === rest.length - 1 ? "right" : null;
  if (zone === "top") return ids[0] === targetId ? "top" : null;
  return ids[ids.length - 1] === targetId ? "bottom" : null;
}

/**
 * The thin guide line for a dock edge, drawn just inside the border of the panel area: a vertical line along the whole
 * left or right side, or a horizontal line along the top or bottom side as wide as the column that panel sits in.
 * `area` is the panel area itself, `column` the horizontal extent of the target's column, in the same coordinates.
 */
export function edgeGuideBox(
  edge: DropZone,
  area: { left: number; top: number; width: number; height: number },
  column: { left: number; width: number },
  inset = 3,
  thickness = 2,
): { left: number; top: number; width: number; height: number } {
  if (edge === "left" || edge === "right") {
    const left = edge === "left" ? area.left + inset : area.left + area.width - inset - thickness;
    return { left, top: area.top + inset, width: thickness, height: Math.max(0, area.height - inset * 2) };
  }
  const top = edge === "top" ? area.top + inset : area.top + area.height - inset - thickness;
  return { left: column.left, top, width: column.width, height: thickness };
}
