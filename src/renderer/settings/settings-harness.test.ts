// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSettingsPage, flushMicrotasks, mountSettingsPage } from "./settings-harness.test-support";

describe("settings harness isolation between mounts", () => {
  afterEach(() => {
    cleanupSettingsPage();
    vi.restoreAllMocks();
  });

  it("stops the select and range observers of a cleaned-up mount", async () => {
    await mountSettingsPage();
    cleanupSettingsPage();

    const select = document.createElement("select");
    select.append(new Option("a", "a"));
    const range = document.createElement("input");
    range.type = "range";
    document.body.append(select, range);
    await flushMicrotasks();

    expect(select.classList.contains("ff-select__source")).toBe(false);
    expect(range.dataset.ffRangeFill).toBeUndefined();
  });

  it("leaves only the current mount's search shortcut on the document", async () => {
    await mountSettingsPage();
    cleanupSettingsPage();
    await mountSettingsPage();

    const select = vi.spyOn(HTMLInputElement.prototype, "select");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));

    expect(select).toHaveBeenCalledTimes(1);
  });
});
