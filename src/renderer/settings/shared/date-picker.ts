/**
 * A calendar popover in front of a native date input (the native one has no smooth year/month picking). The input stays
 * in the page, hidden, as the form control: choosing a day sets its value (YYYY-MM-DD) and fires `input` + `change`,
 * and code that sets `input.value` directly is followed. Year and month change by arrows or by picking from a list;
 * keyboard: arrows move a day/week, PageUp/PageDown a month (with Shift a year), Home/End the week, Enter picks.
 */
import { t } from "../i18n";

const pad = (value: number) => String(value).padStart(2, "0");
const iso = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
function parse(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return iso(date) === value ? date : null;
}
const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
function addMonths(date: Date, months: number): Date {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), last));
}

let seq = 0;

export function attachDatePicker(input: HTMLInputElement, options: { minYear?: number; maxYear?: number } = {}): HTMLElement | null {
  if (input.dataset.ffDatePicker) return null;
  input.dataset.ffDatePicker = "true";
  const id = `ff-date-${(seq += 1)}`;
  const now = new Date();
  const minYear = options.minYear ?? 1900;
  const maxYear = options.maxYear ?? now.getFullYear();
  const locale = document.documentElement.lang || "zh-CN";
  const fullFormat = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric" });
  const monthFormat = new Intl.DateTimeFormat(locale, { month: "long" });
  const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: "narrow" });

  const root = document.createElement("div");
  root.className = "ff-date";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ff-select__button ff-date__button";
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  const face = document.createElement("span");
  face.className = "ff-select__face";
  const icon = document.createElement("span");
  icon.className = "ff-date__icon";
  icon.setAttribute("aria-hidden", "true");
  button.append(face, icon);

  const popup = document.createElement("div");
  popup.className = "ff-date__popup";
  popup.setAttribute("role", "dialog");
  popup.id = `${id}-dialog`;
  popup.hidden = true;
  const head = document.createElement("div");
  head.className = "ff-date__head";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "ff-date__nav ff-date__nav--prev";
  prev.setAttribute("aria-label", t("settings.datePicker.prevMonth"));
  const next = document.createElement("button");
  next.type = "button";
  next.className = "ff-date__nav ff-date__nav--next";
  next.setAttribute("aria-label", t("settings.datePicker.nextMonth"));
  const yearSelect = document.createElement("select");
  yearSelect.className = "ff-date__year";
  yearSelect.setAttribute("aria-label", t("settings.datePicker.year"));
  for (let year = maxYear; year >= minYear; year -= 1) yearSelect.add(new Option(String(year), String(year)));
  const monthSelect = document.createElement("select");
  monthSelect.className = "ff-date__month";
  monthSelect.setAttribute("aria-label", t("settings.datePicker.month"));
  for (let month = 0; month < 12; month += 1) monthSelect.add(new Option(monthFormat.format(new Date(2000, month, 1)), String(month)));
  const pickers = document.createElement("div");
  pickers.className = "ff-date__pickers";
  pickers.append(yearSelect, monthSelect);
  head.append(prev, pickers, next);
  const grid = document.createElement("div");
  grid.className = "ff-date__grid";
  grid.setAttribute("role", "grid");
  grid.tabIndex = 0;
  const foot = document.createElement("div");
  foot.className = "ff-date__foot";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "ff-date__link";
  clear.textContent = t("settings.datePicker.clear");
  foot.append(clear);
  popup.append(head, grid, foot);
  root.append(button, popup);
  input.before(root);
  input.classList.add("ff-select__source");
  input.tabIndex = -1;
  input.setAttribute("aria-hidden", "true");

  let view = parse(input.value) ?? new Date(Math.min(now.getFullYear(), maxYear) - 20, 0, 1);
  let focus = view;

  function render() {
    yearSelect.value = String(view.getFullYear());
    monthSelect.value = String(view.getMonth());
    prev.disabled = view.getFullYear() <= minYear && view.getMonth() === 0;
    next.disabled = view.getFullYear() >= maxYear && view.getMonth() === 11;
    const selected = input.value;
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    // Weeks start on Monday.
    const start = addDays(first, -((first.getDay() + 6) % 7));
    const cells: HTMLElement[] = [];
    for (let i = 0; i < 7; i += 1) {
      const cell = document.createElement("span");
      cell.className = "ff-date__weekday";
      cell.setAttribute("role", "columnheader");
      cell.textContent = weekdayFormat.format(addDays(start, i));
      cells.push(cell);
    }
    for (let i = 0; i < 42; i += 1) {
      const day = addDays(start, i);
      const value = iso(day);
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "ff-date__day";
      cell.setAttribute("role", "gridcell");
      cell.tabIndex = -1;
      cell.dataset.date = value;
      cell.textContent = String(day.getDate());
      cell.setAttribute("aria-label", fullFormat.format(day));
      if (day.getMonth() !== view.getMonth()) cell.classList.add("is-outside");
      if (value === iso(now)) cell.classList.add("is-today");
      if (value === selected) { cell.classList.add("is-selected"); cell.setAttribute("aria-selected", "true"); }
      if (value === iso(focus)) cell.classList.add("is-focus");
      if (day.getFullYear() > maxYear || day.getFullYear() < minYear || day > now && maxYear === now.getFullYear()) cell.disabled = true;
      cells.push(cell);
    }
    grid.replaceChildren(...cells);
    grid.setAttribute("aria-label", `${yearSelect.value} ${monthSelect.selectedOptions[0]?.textContent ?? ""}`);
  }
  function showFace() {
    const date = parse(input.value);
    face.textContent = date ? fullFormat.format(date) : t("settings.datePicker.placeholder");
    face.classList.toggle("is-placeholder", !date);
    button.setAttribute("aria-label", date ? fullFormat.format(date) : t("settings.datePicker.placeholder"));
  }
  function moveFocus(date: Date) {
    if (date.getFullYear() < minYear || date.getFullYear() > maxYear) return;
    focus = date;
    view = new Date(date.getFullYear(), date.getMonth(), 1);
    render();
  }
  function commit(value: string) {
    if (input.value !== value) {
      setValue.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    showFace();
    close();
  }
  function open() {
    if (!popup.hidden) return;
    const date = parse(input.value);
    focus = date ?? view;
    view = new Date(focus.getFullYear(), focus.getMonth(), 1);
    render();
    popup.hidden = false;
    root.classList.add("is-open");
    const rect = button.getBoundingClientRect();
    root.classList.toggle("is-above", rect.bottom + 360 > window.innerHeight && rect.top > 360);
    button.setAttribute("aria-expanded", "true");
    grid.focus();
    document.addEventListener("pointerdown", outside, true);
  }
  function close(refocus = true) {
    if (popup.hidden) return;
    popup.hidden = true;
    root.classList.remove("is-open");
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    if (refocus) button.focus();
  }
  function outside(event: Event) {
    // The year and month lists open in their own popups inside this one.
    if (!root.contains(event.target as Node)) close(false);
  }

  // Follow code that sets the value directly (loading the saved profile).
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
  const setValue = descriptor.set!;
  Object.defineProperty(input, "value", {
    configurable: true,
    get() { return descriptor.get!.call(this); },
    set(value: string) { setValue.call(this, value); showFace(); if (!popup.hidden) render(); },
  });

  button.addEventListener("click", () => (popup.hidden ? open() : close()));
  prev.addEventListener("click", () => moveFocus(addMonths(focus, -1)));
  next.addEventListener("click", () => moveFocus(addMonths(focus, 1)));
  yearSelect.addEventListener("change", () => moveFocus(new Date(Number(yearSelect.value), focus.getMonth(), Math.min(focus.getDate(), 28))));
  monthSelect.addEventListener("change", () => moveFocus(new Date(focus.getFullYear(), Number(monthSelect.value), Math.min(focus.getDate(), 28))));
  grid.addEventListener("click", event => {
    const cell = (event.target as HTMLElement).closest<HTMLButtonElement>(".ff-date__day");
    if (cell && !cell.disabled && cell.dataset.date) commit(cell.dataset.date);
  });
  grid.addEventListener("keydown", event => {
    const moves: Record<string, () => Date> = {
      ArrowLeft: () => addDays(focus, -1),
      ArrowRight: () => addDays(focus, 1),
      ArrowUp: () => addDays(focus, -7),
      ArrowDown: () => addDays(focus, 7),
      PageUp: () => addMonths(focus, event.shiftKey ? -12 : -1),
      PageDown: () => addMonths(focus, event.shiftKey ? 12 : 1),
      Home: () => addDays(focus, -((focus.getDay() + 6) % 7)),
      End: () => addDays(focus, 6 - ((focus.getDay() + 6) % 7)),
    };
    if (moves[event.key]) { event.preventDefault(); moveFocus(moves[event.key]!()); return; }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const cell = grid.querySelector<HTMLButtonElement>(`[data-date="${iso(focus)}"]`);
      if (cell && !cell.disabled) commit(iso(focus));
    }
  });
  // Escape inside the year or month list closes only that list (it marks the event handled).
  popup.addEventListener("keydown", event => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); close(); } });
  clear.addEventListener("click", () => commit(""));
  showFace();
  return root;
}
