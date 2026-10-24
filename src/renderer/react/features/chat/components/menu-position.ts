/** Keeps a fixed-position menu fully inside the window: flips above the anchor or slides left when it would overflow. */
export function placeMenu(
  anchor: { x: number; y: number; above?: number },
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
): { left: number; top: number } {
  const maxLeft = Math.max(margin, viewport.width - menu.width - margin);
  const left = Math.min(Math.max(margin, anchor.x), maxLeft);
  let top = anchor.y;
  if (top + menu.height + margin > viewport.height) {
    // Prefer opening upward from the anchor's top edge; otherwise pin to the bottom of the window.
    const upward = (anchor.above ?? anchor.y) - menu.height;
    top = upward >= margin ? upward : viewport.height - menu.height - margin;
  }
  return { left, top: Math.max(margin, top) };
}
