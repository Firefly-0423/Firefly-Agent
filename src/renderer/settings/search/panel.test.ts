// @vitest-environment jsdom
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const html = fs.readFileSync("src/renderer/settings/index.html", "utf8");
let settings: Record<string, unknown>;
let save: ReturnType<typeof vi.fn>;
function checkbox(): HTMLInputElement {
  return document.getElementById("plugin-search-enabled") as HTMLInputElement;
}
function engine(): HTMLSelectElement {
  return document.getElementById("search-engine") as HTMLSelectElement;
}
async function toggle(checked: boolean): Promise<void> {
  checkbox().checked = checked;
  checkbox().dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(checkbox().disabled).toBe(false));
}
async function load(): Promise<void> {
  await import("./panel");
  await vi.waitFor(() => expect((document.getElementById("search-tavily-key") as HTMLInputElement).value).toBe("synthetic-key"));
}

describe("search enable persistence", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = html;
    settings = { searchEngine: "tavily", searchTavilyKey: "synthetic-key", unrelated: "keep" };
    save = vi.fn(async (patch: Record<string, unknown>) => { Object.assign(settings, patch); });
    Object.defineProperty(window, "settings", {
      configurable: true,
      value: { getGeneral: vi.fn(async () => ({ ...settings })), saveGeneral: save },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("persists off without replacing the selected provider or other settings", async () => {
    await load();
    await toggle(false);
    expect(settings).toEqual({ searchEngine: "off", searchTavilyKey: "synthetic-key", unrelated: "keep" });
    expect(engine().value).toBe("tavily");
    expect(document.getElementById("plugin-search-config")?.style.display).toBe("none");
    await toggle(true);
    expect(settings.searchEngine).toBe("tavily");
  });

  it("reloads disabled and enables the first provider when no previous selection exists", async () => {
    settings.searchEngine = "off";
    await load();
    expect(checkbox().checked).toBe(false);
    await toggle(true);
    expect(settings.searchEngine).toBe("bocha");
    expect(engine().value).toBe("bocha");
  });

  it("restores the persisted switch and visible provider after a failed disable", async () => {
    await load();
    save.mockRejectedValueOnce(new Error("synthetic save failure"));
    await toggle(false);
    expect(checkbox().checked).toBe(true);
    expect(engine().value).toBe("tavily");
    expect(document.getElementById("plugin-search-config")?.style.display).toBe("block");
    expect(settings.searchEngine).toBe("tavily");
    await toggle(false);
    expect(settings.searchEngine).toBe("off");
  });

  it("restores disabled after a failed enable", async () => {
    settings.searchEngine = "off";
    await load();
    save.mockRejectedValueOnce(new Error("synthetic save failure"));
    await toggle(true);
    expect(checkbox().checked).toBe(false);
    expect(document.getElementById("plugin-search-config")?.style.display).toBe("none");
    expect(settings.searchEngine).toBe("off");
  });

  it("keeps controls disabled until the save settles", async () => {
    await load();
    let finish!: () => void;
    save.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    checkbox().checked = false;
    checkbox().dispatchEvent(new Event("change"));
    expect(checkbox().disabled).toBe(true);
    expect(engine().disabled).toBe(true);
    finish();
    await vi.waitFor(() => expect(checkbox().disabled).toBe(false));
    expect(engine().disabled).toBe(false);
  });

  it("restores the previous provider after its save fails", async () => {
    await load();
    save.mockRejectedValueOnce(new Error("synthetic save failure"));
    engine().value = "bocha";
    engine().dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(engine().value).toBe("tavily"));
    expect(settings.searchEngine).toBe("tavily");
    expect(document.getElementById("search-tavily-row")?.style.display).toBe("flex");
  });
});
