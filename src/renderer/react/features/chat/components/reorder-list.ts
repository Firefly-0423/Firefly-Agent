// Ordering helpers shared by the overview cards and their drag handle.

/** A press on a grip only becomes a drag after the pointer travels this far, so a click never reorders. */
export const DRAG_DEAD_ZONE = 4;

/** Keeps the saved order for ids still present and appends new ids at the end. */
export function reconcileOrder(order: readonly string[], ids: readonly string[]): string[] {
  return [...order.filter(id => ids.includes(id)), ...ids.filter(id => !order.includes(id))];
}

/** Moves one id to a new index among the others. */
export function moveId(order: readonly string[], id: string, toIndex: number): string[] {
  const rest = order.filter(item => item !== id);
  const index = Math.max(0, Math.min(toIndex, rest.length));
  return [...rest.slice(0, index), id, ...rest.slice(index)];
}
