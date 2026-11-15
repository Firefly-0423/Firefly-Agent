export function markChoice(button: HTMLButtonElement, selected: boolean, radio = false): void {
  button.classList.toggle("is-active", selected);
  if (radio) button.setAttribute("aria-checked", String(selected));
  button.setAttribute("aria-pressed", String(selected));
}

export function selectButtons(root: HTMLElement, selector: string, matches: (button: HTMLButtonElement) => boolean, radio = false): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>(selector)) {
    markChoice(button, matches(button), radio);
  }
}

export function applyOptionGroupValue(group: HTMLElement, value: string): void {
  selectButtons(group, ".option-block", option => option.dataset.value === value);
}

export function getOptionGroupValue(group: HTMLElement, fallback: string): string {
  const selected = group.querySelector<HTMLButtonElement>(".option-block.is-active");
  return selected?.dataset.value ?? fallback;
}

export function onChoice(root: HTMLElement, selector: string, choose: (button: HTMLButtonElement) => void): void {
  root.querySelectorAll<HTMLButtonElement>(selector).forEach(option => {
    option.addEventListener("click", () => choose(option));
  });
}
