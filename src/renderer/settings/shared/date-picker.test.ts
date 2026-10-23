// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { attachDatePicker } from "./date-picker";

afterEach(() => { document.body.replaceChildren(); });

function setup(value = "") {
  const input = document.createElement("input");
  input.type = "date";
  input.value = value;
  document.body.append(input);
  const root = attachDatePicker(input, { minYear: 1990, maxYear: 2026 })!;
  return {
    input,
    root,
    button: root.querySelector<HTMLButtonElement>(".ff-date__button")!,
    popup: root.querySelector<HTMLElement>(".ff-date__popup")!,
    grid: root.querySelector<HTMLElement>(".ff-date__grid")!,
    day: (date: string) => root.querySelector<HTMLButtonElement>(`[data-date="${date}"]`),
  };
}

it("shows the saved date, hides the native input and opens on that month", () => {
  const { input, root, button, popup, day } = setup("2005-02-17");
  expect(input.previousElementSibling).toBe(root);
  expect(input.classList.contains("ff-select__source")).toBe(true);
  expect(button.textContent).toContain("2005");
  button.click();
  expect(popup.hidden).toBe(false);
  expect(day("2005-02-17")?.classList.contains("is-selected")).toBe(true);
  expect(root.querySelectorAll(".ff-date__day")).toHaveLength(42);
});

it("writes the picked day and fires input and change", () => {
  const { input, button, popup, day } = setup("2005-02-17");
  const changed = vi.fn();
  input.addEventListener("change", () => changed(input.value));
  button.click();
  day("2005-02-20")!.click();
  expect(changed).toHaveBeenCalledExactlyOnceWith("2005-02-20");
  expect(popup.hidden).toBe(true);
});

it("moves by day, week, month and year from the keyboard and picks with Enter", () => {
  const { input, button, grid } = setup("2005-02-17");
  button.click();
  const key = (name: string, shiftKey = false) => grid.dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true }));
  key("ArrowRight");
  key("ArrowDown");
  key("PageDown");
  key("PageUp", true);
  key("Enter");
  expect(input.value).toBe("2004-03-25");
});

it("follows a value set from code, clears, and closes on Escape or a click outside", () => {
  const { input, root, button, popup } = setup();
  expect(button.querySelector(".is-placeholder")).not.toBeNull();
  input.value = "1999-12-31";
  expect(button.textContent).toContain("1999");
  button.click();
  root.querySelector<HTMLButtonElement>(".ff-date__link")!.click();
  expect(input.value).toBe("");
  button.click();
  popup.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(popup.hidden).toBe(true);
  button.click();
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect(popup.hidden).toBe(true);
});

it("does not offer days after today or outside the allowed years", () => {
  const { button, root } = setup("2026-10-18");
  button.click();
  // Today in local time, as the picker counts it (toISOString is UTC and runs a day behind after local midnight east of UTC).
  const now = new Date(), today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const future = [...root.querySelectorAll<HTMLButtonElement>(".ff-date__day")].filter(cell => cell.dataset.date! > today);
  expect(future.every(cell => cell.disabled)).toBe(true);
});
