// 键盘焦点在弹窗内循环，包含详情摘要与链接。
const keyboardStopSelector = [
  "button:not([disabled])", "input:not([disabled])", "textarea:not([disabled])",
  "select:not([disabled])", "summary", "a[href]", '[tabindex]:not([tabindex="-1"])',
].join(", ");

function collectAvailableStops(dialog: HTMLElement): HTMLElement[] {
  const candidates = [...dialog.querySelectorAll<HTMLElement>(keyboardStopSelector)];
  return candidates.filter((candidate) => candidate.closest('[hidden], [inert], [aria-hidden="true"]') === null);
}

export function activateDialogFocus(dialog: HTMLElement, initialFocus: HTMLElement, onEscape: () => void): () => void {
  const restoreTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  function handleDialogKey(keyboard: KeyboardEvent): void {
    switch (keyboard.key) {
      case "Escape":
        keyboard.preventDefault();
        onEscape();
        return;
      case "Tab": {
        const stops = collectAvailableStops(dialog);
        if (stops.length === 0) return;
        const start = stops[0];
        const end = stops[stops.length - 1];
        if (!keyboard.shiftKey && document.activeElement === end) {
          keyboard.preventDefault();
          start.focus();
        } else if (keyboard.shiftKey && document.activeElement === start) {
          keyboard.preventDefault();
          end.focus();
        }
        return;
      }
    }
  }
  dialog.addEventListener("keydown", handleDialogKey);
  initialFocus.focus();
  return function releaseDialogFocus(): void {
    dialog.removeEventListener("keydown", handleDialogKey);
    restoreTarget?.focus();
  };
}
