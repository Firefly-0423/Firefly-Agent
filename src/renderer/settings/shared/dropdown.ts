/**
 * One dropdown for the whole settings window, after open-claude-ui's listbox: a button showing the current choice and
 * a list that fades in under it, with keyboard support (arrows, Home/End, Enter, Escape, type a letter to jump) and a
 * filter box for long lists. The real control stays in the page and remains the only source of state and wiring:
 * - over picker cards (`attachCardSelect`): choosing an option clicks that card, and each option shows the card's logo;
 * - over a native <select> (`enhanceSelect`): choosing sets its value and fires `input` + `change`, and code that sets
 *   `select.value` directly is followed too.
 */
import { t } from "../i18n";

export interface DropdownSource<T> {
  /** Accessible name of the dropdown. */
  label: string;
  /** Shown while nothing is selected (for example a new draft that has not picked a provider yet). */
  placeholder?: string;
  items(): T[];
  valueOf(item: T): string | undefined;
  textOf(item: T): string;
  isSelected(item: T): boolean;
  isDisabled(item: T): boolean;
  iconOf?(item: T): Element | null | undefined;
  choose(item: T): void;
  /** Calls `sync` whenever the source changes. */
  watch(sync: () => void): void;
}

/** Lists this long get a filter box at the top. */
const FILTER_AT = 12;
let seq = 0;

export function createDropdown<T>(anchor: HTMLElement, source: DropdownSource<T>): HTMLElement {
  const id = `ff-dropdown-${(seq += 1)}`;
  const root = document.createElement("div");
  root.className = "ff-select";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ff-select__button";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", `${id}-list`);
  const face = document.createElement("span");
  face.className = "ff-select__face";
  const chevron = document.createElement("span");
  chevron.className = "ff-select__chevron";
  chevron.setAttribute("aria-hidden", "true");
  button.append(face, chevron);
  const popup = document.createElement("div");
  popup.className = "ff-select__popup";
  popup.hidden = true;
  const filter = document.createElement("input");
  filter.type = "search";
  filter.className = "ff-select__filter";
  filter.autocomplete = "off";
  filter.placeholder = t("settings.dropdown.filter");
  filter.setAttribute("aria-label", source.label);
  filter.setAttribute("aria-controls", `${id}-list`);
  const list = document.createElement("ul");
  list.className = "ff-select__list";
  list.id = `${id}-list`;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", source.label);
  list.tabIndex = -1;
  popup.append(filter, list);
  root.append(button, popup);
  anchor.before(root);

  const usable = () => source.items().filter(item => source.valueOf(item) !== undefined);
  const content = (item: T | undefined, text: string) => {
    const nodes: Node[] = [];
    const icon = item !== undefined ? source.iconOf?.(item) : undefined;
    if (icon) {
      const holder = document.createElement("span");
      holder.className = "ff-select__icon";
      holder.setAttribute("aria-hidden", "true");
      holder.append(icon.cloneNode(true));
      nodes.push(holder);
    }
    const label = document.createElement("span");
    label.className = "ff-select__text";
    label.textContent = text;
    nodes.push(label);
    return nodes;
  };
  const visibleOptions = () => [...list.querySelectorAll<HTMLLIElement>("[role=option]:not([hidden])")];
  let active = -1;
  const setActive = (index: number) => {
    const items = visibleOptions();
    list.querySelectorAll(".is-active").forEach(node => node.classList.remove("is-active"));
    if (!items.length) { active = -1; list.removeAttribute("aria-activedescendant"); return; }
    active = Math.max(0, Math.min(items.length - 1, index));
    items[active]!.classList.add("is-active");
    list.setAttribute("aria-activedescendant", items[active]!.id);
    filter.setAttribute("aria-activedescendant", items[active]!.id);
    items[active]!.scrollIntoView?.({ block: "nearest" });
  };

  let signature = "";
  function sync() {
    const current = usable();
    const selected = current.find(item => source.isSelected(item));
    const wanted = current.map(item => `${source.valueOf(item)}\u0000${source.textOf(item)}\u0000${source.isDisabled(item) ? 1 : 0}`).join("\u0001");
    if (signature !== wanted) {
      signature = wanted;
      list.replaceChildren(...current.map((item, index) => {
        const option = document.createElement("li");
        option.id = `${id}-option-${index}`;
        option.className = "ff-select__option";
        option.setAttribute("role", "option");
        option.dataset.optionValue = source.valueOf(item)!;
        if (source.isDisabled(item)) option.setAttribute("aria-disabled", "true");
        option.append(...content(item, source.textOf(item)));
        return option;
      }));
      filter.hidden = current.length < FILTER_AT;
    }
    for (const option of list.querySelectorAll<HTMLElement>("[role=option]")) {
      option.setAttribute("aria-selected", String(!!selected && option.dataset.optionValue === source.valueOf(selected)));
    }
    face.replaceChildren(...(selected ? content(selected, source.textOf(selected)) : content(undefined, source.placeholder ?? "")));
    face.classList.toggle("is-placeholder", !selected);
    button.setAttribute("aria-label", selected ? `${source.label}: ${source.textOf(selected)}` : source.label);
    button.disabled = current.length === 0 || current.every(item => source.isDisabled(item));
    if (button.disabled) close(false);
  }

  function applyFilter() {
    const needle = filter.value.trim().toLowerCase();
    for (const option of list.querySelectorAll<HTMLElement>("[role=option]")) {
      option.hidden = Boolean(needle) && !(option.textContent ?? "").toLowerCase().includes(needle);
    }
    setActive(0);
  }
  function open() {
    if (button.disabled || !popup.hidden) return;
    filter.value = "";
    applyFilter();
    popup.hidden = false;
    button.setAttribute("aria-expanded", "true");
    root.classList.add("is-open");
    // Open upwards when there is no room below.
    const rect = button.getBoundingClientRect();
    root.classList.toggle("is-above", rect.bottom + 320 > window.innerHeight && rect.top > 320);
    setActive(Math.max(0, visibleOptions().findIndex(option => option.getAttribute("aria-selected") === "true")));
    (filter.hidden ? list : filter).focus();
    document.addEventListener("pointerdown", outside, true);
  }
  function close(refocus = true) {
    if (popup.hidden) return;
    popup.hidden = true;
    button.setAttribute("aria-expanded", "false");
    root.classList.remove("is-open");
    list.removeAttribute("aria-activedescendant");
    document.removeEventListener("pointerdown", outside, true);
    if (refocus) button.focus();
  }
  function outside(event: Event) {
    if (!root.contains(event.target as Node)) close(false);
  }
  function pick(option: HTMLElement | undefined) {
    if (!option || option.getAttribute("aria-disabled") === "true") return;
    close();
    const item = usable().find(entry => source.valueOf(entry) === option.dataset.optionValue);
    if (item !== undefined) source.choose(item);
    // A handler may refuse the change (an unsaved draft it asked to keep); show what is really selected.
    queueMicrotask(sync);
  }
  const onKey = (event: KeyboardEvent, fromFilter: boolean) => {
    const items = visibleOptions();
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); setActive(active + 1); break;
      case "ArrowUp": event.preventDefault(); setActive(active - 1); break;
      case "Home": if (!fromFilter) { event.preventDefault(); setActive(0); } break;
      case "End": if (!fromFilter) { event.preventDefault(); setActive(items.length - 1); } break;
      case "Enter": event.preventDefault(); pick(items[active]); break;
      case " ": if (!fromFilter) { event.preventDefault(); pick(items[active]); } break;
      case "Escape": event.preventDefault(); close(); break;
      case "Tab": close(false); break;
      default:
        if (!fromFilter && event.key.length === 1) {
          const key = event.key.toLowerCase();
          const start = active + 1;
          const hit = [...items.slice(start), ...items.slice(0, start)].find(item => item.textContent?.trim().toLowerCase().startsWith(key));
          if (hit) setActive(items.indexOf(hit));
        }
    }
  };

  button.addEventListener("click", () => (popup.hidden ? open() : close()));
  button.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); open(); }
  });
  list.addEventListener("click", event => pick((event.target as HTMLElement).closest<HTMLElement>("[role=option]") ?? undefined));
  list.addEventListener("pointermove", event => {
    const option = (event.target as HTMLElement).closest<HTMLElement>("[role=option]");
    if (option) setActive(visibleOptions().indexOf(option as HTMLLIElement));
  });
  list.addEventListener("keydown", event => onKey(event, false));
  filter.addEventListener("keydown", event => onKey(event, true));
  filter.addEventListener("input", applyFilter);
  source.watch(sync);
  sync();
  return root;
}

export interface CardSelectOptions {
  label: string;
  placeholder?: string;
  valueOf(card: HTMLElement): string | undefined;
  textOf(card: HTMLElement): string;
  isSelected(card: HTMLElement): boolean;
  iconOf?(card: HTMLElement): Element | null | undefined;
}

/** A dropdown over a group of picker cards (the cards are hidden and keep their state and handlers). */
export function attachCardSelect(cards: HTMLElement, cardSelector: string, options: CardSelectOptions): HTMLElement {
  cards.classList.add("ff-select__source");
  cards.hidden = true;
  return createDropdown<HTMLElement>(cards, {
    ...options,
    items: () => [...cards.querySelectorAll<HTMLElement>(cardSelector)],
    isDisabled: card => (card as HTMLButtonElement).disabled === true,
    choose: card => card.click(),
    watch: sync => new MutationObserver(sync).observe(cards, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "aria-pressed", "disabled"] }),
  });
}

/** A dropdown over a native <select>; the select stays (hidden) as the form control everything else reads and writes. */
export function enhanceSelect(select: HTMLSelectElement): HTMLElement | null {
  // The mark lives on the element, so a second copy of this module (a reload) never wraps the same select twice.
  if (select.dataset.ffDropdown || select.multiple || select.size > 1) return null;
  select.dataset.ffDropdown = "true";
  const label = select.getAttribute("aria-label")
    ?? (select.id ? document.querySelector(`label[for="${select.id}"]`)?.textContent?.trim() : undefined)
    ?? select.closest("label")?.querySelector("span, strong")?.textContent?.trim()
    ?? select.name ?? "";
  let sync: () => void = () => undefined;
  // Code that sets the value directly (loading saved settings) fires no event; follow it through the property.
  const proto = HTMLSelectElement.prototype;
  for (const key of ["value", "selectedIndex"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, key);
    if (!descriptor?.get || !descriptor.set) continue;
    Object.defineProperty(select, key, {
      configurable: true,
      get() { return descriptor.get!.call(this); },
      set(next) { descriptor.set!.call(this, next); sync(); },
    });
  }
  const root = createDropdown<HTMLOptionElement>(select, {
    label,
    items: () => [...select.options],
    valueOf: option => option.value,
    textOf: option => option.textContent?.trim() ?? option.value,
    isSelected: option => option.selected,
    isDisabled: option => option.disabled || select.disabled,
    choose: option => {
      if (select.value === option.value) return;
      select.value = option.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    },
    watch: next => {
      sync = next;
      select.addEventListener("change", next);
      new MutationObserver(next).observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled", "selected", "label"] });
    },
  });
  root.classList.add("ff-select--native");
  for (const name of select.classList) if (!name.startsWith("is-")) root.classList.add(`ff-select--from-${name}`);
  select.classList.add("ff-select__source");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  return root;
}

/** Enhances every native <select> under `root` now and whenever one is added later (panels render some on the fly). */
export function enhanceSelects(root: ParentNode & Node): void {
  const scan = (node: ParentNode) => node.querySelectorAll?.("select").forEach(select => enhanceSelect(select));
  scan(root);
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node instanceof HTMLSelectElement) enhanceSelect(node);
      else if (node instanceof Element) scan(node);
    }
  }).observe(root, { childList: true, subtree: true });
}
