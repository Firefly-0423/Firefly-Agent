// Settings sliders show how far they have travelled: each range input carries --ff-range-fill (0–100%), which the
// theme paints as the filled part of its track. It follows the user's dragging and values set from code alike.

function paint(input: HTMLInputElement): void {
  const min = Number(input.min || 0), max = Number(input.max || 100), value = Number(input.value);
  const ratio = max > min && Number.isFinite(value) ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
  input.style.setProperty("--ff-range-fill", `${Math.round(ratio * 1000) / 10}%`);
}

function track(input: HTMLInputElement): void {
  if (input.dataset.ffRangeFill) return;
  input.dataset.ffRangeFill = "1";
  // Values written from code (loading saved settings) fire no event, so the instance setters repaint too.
  for (const key of ["value", "valueAsNumber"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, key);
    if (!descriptor?.get || !descriptor.set) continue;
    Object.defineProperty(input, key, {
      configurable: true,
      get() { return descriptor.get!.call(this); },
      set(next) { descriptor.set!.call(this, next); paint(input); },
    });
  }
  input.addEventListener("input", () => paint(input));
  paint(input);
}

export function trackRangeFills(root: ParentNode & Node): void {
  const scan = (node: ParentNode) => node.querySelectorAll?.<HTMLInputElement>('input[type="range"]').forEach(track);
  scan(root);
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node instanceof HTMLInputElement && node.type === "range") track(node);
      else if (node instanceof Element) scan(node);
    }
  }).observe(root, { childList: true, subtree: true });
}
