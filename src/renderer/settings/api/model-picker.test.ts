// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createModelPicker, filterPickerModels } from "./model-picker";

const models = [{ id: "gpt-5" }, { id: "claude-x", name: "Claude Ex" }, { id: "deepseek-chat" }];

describe("filterPickerModels", () => {
  it("matches the id or the display name, ignoring case and surrounding spaces", () => {
    expect(filterPickerModels(models, " CLAUDE ").map((m) => m.id)).toEqual(["claude-x"]);
    expect(filterPickerModels(models, "ex").map((m) => m.id)).toEqual(["claude-x"]);
    expect(filterPickerModels(models, "").length).toBe(3);
    expect(filterPickerModels(models, "zzz")).toEqual([]);
  });
});

describe("model picker", () => {
  let onPick: ReturnType<typeof vi.fn>;
  const els = () => ({
    root: document.querySelector<HTMLElement>("#picker")!,
    search: document.querySelector<HTMLInputElement>("#search")!,
    list: document.querySelector<HTMLElement>("#list")!,
    empty: document.querySelector<HTMLElement>("#empty")!,
    trigger: document.querySelector<HTMLButtonElement>("#trigger")!,
  });
  const ids = () => [...document.querySelectorAll<HTMLElement>("[data-model-id]")].map((el) => el.dataset.modelId);

  beforeEach(() => {
    document.body.innerHTML = `<div id="editor"><button id="trigger" type="button">Fetch</button><div id="picker" hidden><input id="search" /><div id="list"></div><p id="empty" hidden></p></div></div>`;
    onPick = vi.fn();
  });

  it("opens with every model, marks the current one and shows the display name", () => {
    const picker = createModelPicker(els(), onPick);
    picker.open(models, "claude-x");
    expect(els().root.hidden).toBe(false);
    expect(ids()).toEqual(["gpt-5", "claude-x", "deepseek-chat"]);
    const current = document.querySelector<HTMLElement>(".is-current")!;
    expect(current.dataset.modelId).toBe("claude-x");
    expect(current.getAttribute("aria-selected")).toBe("true");
    expect(current.textContent).toContain("Claude Ex");
  });

  it("filters as you type and reports an empty result", () => {
    const picker = createModelPicker(els(), onPick);
    picker.open(models, "");
    els().search.value = "deep";
    els().search.dispatchEvent(new Event("input"));
    expect(ids()).toEqual(["deepseek-chat"]);
    els().search.value = "nothing";
    els().search.dispatchEvent(new Event("input"));
    expect(ids()).toEqual([]);
    expect(els().empty.hidden).toBe(false);
  });

  it("picks on click and on Enter (first match)", () => {
    const picker = createModelPicker(els(), onPick);
    picker.open(models, "");
    document.querySelector<HTMLElement>('[data-model-id="gpt-5"]')!.click();
    expect(onPick).toHaveBeenLastCalledWith("gpt-5");
    els().search.value = "deep";
    els().search.dispatchEvent(new Event("input"));
    els().search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    expect(onPick).toHaveBeenLastCalledWith("deepseek-chat");
  });

  it("follows the model field and can be closed", () => {
    const picker = createModelPicker(els(), onPick);
    picker.open(models, "gpt-5");
    picker.syncCurrent("deepseek-chat");
    expect(document.querySelector<HTMLElement>(".is-current")!.dataset.modelId).toBe("deepseek-chat");
    els().search.focus();
    picker.close();
    expect(els().root.hidden).toBe(true);
    expect(document.activeElement).toBe(els().search);
  });

  it("closes on Escape from search or option, stops propagation, and returns focus to trigger", () => {
    const editorKeydown = vi.fn();
    document.getElementById("editor")!.addEventListener("keydown", editorKeydown);
    const picker = createModelPicker(els(), onPick);

    picker.open(models, "");
    els().search.focus();
    const fromSearch = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    els().search.dispatchEvent(fromSearch);
    expect(els().root.hidden).toBe(true);
    expect(fromSearch.defaultPrevented).toBe(true);
    expect(editorKeydown).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(els().trigger);
    expect(onPick).not.toHaveBeenCalled();

    picker.open(models, "");
    const firstOption = document.querySelector<HTMLButtonElement>('[data-model-id="gpt-5"]')!;
    firstOption.focus();
    const fromOption = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    firstOption.dispatchEvent(fromOption);
    expect(els().root.hidden).toBe(true);
    expect(fromOption.defaultPrevented).toBe(true);
    expect(editorKeydown).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(els().trigger);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("ignores Escape when already closed without stealing focus or preventing default", () => {
    const picker = createModelPicker(els(), onPick);
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();

    const closedEsc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    els().search.dispatchEvent(closedEsc);
    expect(closedEsc.defaultPrevented).toBe(false);
    expect(els().root.hidden).toBe(true);
    expect(document.activeElement).toBe(other);
  });
});
