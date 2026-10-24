// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachCardSelect, enhanceSelect, enhanceSelects } from "./dropdown";

afterEach(() => { document.body.replaceChildren(); });

function cards(values: string[], active?: string) {
  const root = document.createElement("div");
  for (const value of values) {
    const card = document.createElement("button");
    card.className = "preset-card" + (value === active ? " is-active" : "");
    card.dataset.provider = value;
    const logo = document.createElement("span");
    logo.className = "preset-card__logo";
    const img = document.createElement("img");
    img.src = `${value}.svg`;
    logo.append(img);
    const name = document.createElement("span");
    name.className = "preset-card__name";
    name.textContent = value.toUpperCase();
    card.append(logo, name);
    root.append(card);
  }
  const host = document.createElement("div");
  host.append(root);
  document.body.append(host);
  return root;
}

const options = {
  label: "Provider",
  placeholder: "Choose",
  valueOf: (card: HTMLElement) => card.dataset.provider,
  textOf: (card: HTMLElement) => card.querySelector(".preset-card__name")?.textContent ?? "",
  isSelected: (card: HTMLElement) => card.classList.contains("is-active"),
  iconOf: (card: HTMLElement) => card.querySelector(".preset-card__logo")?.firstElementChild,
};
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const parts = (select: HTMLElement) => ({
  button: select.querySelector<HTMLButtonElement>(".ff-select__button")!,
  list: select.querySelector<HTMLElement>("[role=listbox]")!,
  popup: select.querySelector<HTMLElement>(".ff-select__popup")!,
  items: () => [...select.querySelectorAll<HTMLElement>("[role=option]")],
});

it("shows the selected card's logo and name, and lists every card with its logo", () => {
  const root = cards(["a", "b"], "b");
  const select = attachCardSelect(root, ".preset-card", options);
  const { button, list, popup, items } = parts(select);
  expect(root.previousElementSibling).toBe(select);
  expect(root.hidden).toBe(true);
  expect(button.textContent).toBe("B");
  expect(button.querySelector("img")?.getAttribute("src")).toBe("b.svg");
  expect(button.getAttribute("aria-label")).toBe("Provider: B");
  expect(popup.hidden).toBe(true);
  expect(items().map(item => [item.textContent, item.querySelector("img")?.getAttribute("src"), item.getAttribute("aria-selected")]))
    .toEqual([["A", "a.svg", "false"], ["B", "b.svg", "true"]]);
});

it("opens on click, picks with the keyboard and clicks that card so the existing handlers run", async () => {
  const root = cards(["a", "b", "c"]);
  const select = attachCardSelect(root, ".preset-card", options);
  const { button, list, popup, items } = parts(select);
  expect(button.textContent).toBe("Choose");
  const clicked = vi.fn((event: Event) => {
    const card = (event.target as HTMLElement).closest(".preset-card");
    root.querySelectorAll(".preset-card").forEach(item => item.classList.toggle("is-active", item === card));
  });
  root.addEventListener("click", clicked);
  button.click();
  expect(popup.hidden).toBe(false);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(list);
  list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
  expect(list.getAttribute("aria-activedescendant")).toBe(items()[1]!.id);
  list.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  expect(clicked).toHaveBeenCalledOnce();
  expect(popup.hidden).toBe(true);
  expect(document.activeElement).toBe(button);
  await settle();
  expect(button.textContent).toBe("B");
});

it("closes on Escape and on a click elsewhere without choosing", () => {
  const root = cards(["a", "b"], "a");
  const select = attachCardSelect(root, ".preset-card", options);
  const { button, list, popup } = parts(select);
  const clicked = vi.fn();
  root.addEventListener("click", clicked);
  button.click();
  list.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(popup.hidden).toBe(true);
  button.click();
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect(popup.hidden).toBe(true);
  expect(clicked).not.toHaveBeenCalled();
});

it("goes back to the selected card when a handler refuses the change", async () => {
  const root = cards(["a", "b"], "a");
  const select = attachCardSelect(root, ".preset-card", options);
  const { button, items } = parts(select);
  button.click();
  items()[1]!.click();
  await settle();
  expect(button.textContent).toBe("A");
});

it("rebuilds when the cards are replaced and disables itself when every card is disabled", async () => {
  const root = cards(["a"]);
  const select = attachCardSelect(root, ".preset-card", options);
  const replacement = cards(["c"], "c").firstElementChild!;
  root.replaceChildren(replacement);
  await settle();
  const { button, items } = parts(select);
  expect(items().map(item => item.dataset.optionValue)).toEqual(["c"]);
  expect(button.textContent).toBe("C");
  (replacement as HTMLButtonElement).disabled = true;
  await settle();
  expect(button.disabled).toBe(true);
});

describe("enhanceSelect", () => {
  function nativeSelect(count = 3) {
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Time zone");
    for (let i = 0; i < count; i += 1) select.add(new Option(`Zone ${i}`, `z${i}`));
    document.body.append(select);
    return select;
  }

  it("stands in for the select, hides it, and follows values set from code", () => {
    const select = nativeSelect();
    const root = enhanceSelect(select)!;
    const { button, items } = parts(root);
    expect(select.previousElementSibling).toBe(root);
    expect(select.classList.contains("ff-select__source")).toBe(true);
    expect(button.textContent).toBe("Zone 0");
    select.value = "z2";
    expect(button.textContent).toBe("Zone 2");
    expect(items()[2]!.getAttribute("aria-selected")).toBe("true");
    expect(enhanceSelect(select)).toBeNull();
  });

  it("sets the value and fires input and change when an option is chosen", () => {
    const select = nativeSelect();
    const root = enhanceSelect(select)!;
    const changed = vi.fn();
    select.addEventListener("change", () => changed(select.value));
    const { button, items } = parts(root);
    button.click();
    items()[1]!.click();
    expect(changed).toHaveBeenCalledExactlyOnceWith("z1");
    expect(button.textContent).toBe("Zone 1");
  });

  it("offers a filter box for long lists and narrows the options as you type", () => {
    const select = nativeSelect(20);
    const root = enhanceSelect(select)!;
    const { button } = parts(root);
    button.click();
    const filter = root.querySelector<HTMLInputElement>(".ff-select__filter")!;
    expect(filter.hidden).toBe(false);
    expect(document.activeElement).toBe(filter);
    filter.value = "zone 1";
    filter.dispatchEvent(new Event("input"));
    const shown = [...root.querySelectorAll<HTMLElement>("[role=option]")].filter(option => !option.hidden).map(option => option.textContent);
    expect(shown).toEqual(["Zone 1", "Zone 10", "Zone 11", "Zone 12", "Zone 13", "Zone 14", "Zone 15", "Zone 16", "Zone 17", "Zone 18", "Zone 19"]);
    filter.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(select.value).toBe("z1");
  });

  it("enhances selects added later under the watched root", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    enhanceSelects(host);
    const select = document.createElement("select");
    select.add(new Option("A", "a"));
    host.append(select);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(select.previousElementSibling?.classList.contains("ff-select")).toBe(true);
  });
});
