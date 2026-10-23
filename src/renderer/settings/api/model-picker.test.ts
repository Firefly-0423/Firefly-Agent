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
  });
  const ids = () => [...document.querySelectorAll<HTMLElement>("[data-model-id]")].map((el) => el.dataset.modelId);

  beforeEach(() => {
    document.body.innerHTML = `<div id="picker" hidden><input id="search" /><div id="list"></div><p id="empty" hidden></p></div>`;
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
    picker.close();
    expect(els().root.hidden).toBe(true);
  });
});
