export function releaseFocusedDescendant(container: HTMLElement | null): boolean {
  const focused = document.activeElement;
  if (container && focused instanceof HTMLElement && container.contains(focused)) {
    focused.blur();
    return true;
  }
  return false;
}
