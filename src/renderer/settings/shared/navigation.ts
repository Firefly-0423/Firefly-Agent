export function resolveSettingsSection(section: string, buttons: readonly HTMLButtonElement[], panelSections: readonly string[] = []): string {
  return buttons.some(button => button.dataset.section === section) || panelSections.includes(section) ? section : "general";
}

export function updateSettingsNavigation(buttons: readonly HTMLButtonElement[], section: string): void {
  for (const button of buttons) {
    const active = button.dataset.section === section;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
}

export function bindSettingsNavigation(buttons: readonly HTMLButtonElement[], select: (section: string) => void): void {
  for (const button of buttons) {
    button.addEventListener("click", () => select(button.dataset.section ?? "general"));
    button.addEventListener("keydown", event => {
      const available = buttons.filter(item => !item.disabled && !item.hidden);
      const index = available.indexOf(button);
      let next: number;
      switch (event.key) {
        case "ArrowDown": next = (index + 1) % available.length; break;
        case "ArrowUp": next = (index - 1 + available.length) % available.length; break;
        case "Home": next = 0; break;
        case "End": next = available.length - 1; break;
        default: return;
      }
      event.preventDefault();
      const target = available[next];
      if (!target) return;
      target.focus();
      select(target.dataset.section ?? "general");
      target.scrollIntoView?.({ block: "nearest" });
    });
  }
}
