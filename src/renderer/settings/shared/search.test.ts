// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectSettingsEntries, mountSettingsSearch, searchEntries, type SearchEntry } from "./search";

const html = fs.readFileSync(path.resolve("src/renderer/settings/index.html"), "utf8");
const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item"));
const entry = (title: string, description = "", extra: Partial<SearchEntry> = {}): SearchEntry => ({
  section: "general", pageTitle: "通用设置", title, description, text: `${title} ${description}`, element: document.createElement("div"), page: false, ...extra,
});

beforeEach(() => { document.body.innerHTML = html; });
afterEach(() => { vi.restoreAllMocks(); });

describe("settings navigation groups", () => {
  it("keeps all 15 pages, starting with General, in five labelled groups", () => {
    const layout = Array.from(document.querySelectorAll(".settings-nav__list > .settings-nav__group, .settings-nav__list > .nav-item"), node =>
      node.classList.contains("nav-item") ? (node as HTMLElement).dataset.section : `# ${node.getAttribute("data-i18n")}`);
    expect(layout).toEqual([
      "# settings.layout.basic", "general", "appearance", "preferences", "user",
      "# settings.layout.model", "api", "api-advanced",
      "# settings.layout.agent", "firefly", "subagents", "memory", "plugins", "mcp",
      "# settings.layout.connect", "channels", "asr",
      "# settings.layout.about", "usage", "disclaimer",
    ]);
    expect(buttons()).toHaveLength(15);
    expect(buttons()[0].classList.contains("is-active")).toBe(true);
    expect(buttons().filter(button => button.classList.contains("is-active"))).toHaveLength(1);
  });

  it("points every page button at a panel that exists", () => {
    for (const button of buttons()) expect(document.getElementById(button.getAttribute("aria-controls")!), button.dataset.section).not.toBeNull();
  });
});

describe("navigation without avatars", () => {
  it("has no avatar images in the navigation, and the Firefly and Memory entries use line icons", () => {
    expect(document.querySelector(".settings-nav img")).toBeNull();
    for (const section of ["firefly", "memory"]) {
      expect(document.querySelector(`.nav-item[data-section="${section}"] svg.nav-item__icon`), section).not.toBeNull();
    }
  });

  it("puts the 12 sub-agent cards on their own page, listed side by side", () => {
    const panel = document.getElementById("subagents-panel")!;
    expect(panel.dataset.panel).toBe("subagents");
    expect(panel.querySelector("#agent-routing-panel")).not.toBeNull();
    expect(document.querySelector('.nav-item[data-section="subagents"]')?.getAttribute("aria-controls")).toBe("subagents-panel");
  });
});

describe("collecting searchable settings", () => {
  it("lists every page, and the rows and group titles inside them with their page", () => {
    const entries = collectSettingsEntries(document, buttons());
    expect(entries.filter(item => item.page)).toHaveLength(15);
    const language = entries.find(item => item.title === "语言" && !item.page);
    expect(language).toMatchObject({ section: "general", pageTitle: "常规" });
    expect(entries.some(item => item.title === "本地文件" && item.section === "general")).toBe(true);
  });

  it("skips content hidden by its own conditional section but keeps whole pages that are not the active one", () => {
    const panel = document.getElementById("general-form")!;
    const hidden = document.createElement("div");
    hidden.className = "is-hidden";
    hidden.innerHTML = '<div class="setting-row"><div><strong>隐藏的条件项</strong><span>说明</span></div></div>';
    panel.append(hidden);
    const entries = collectSettingsEntries(document, buttons());
    expect(entries.some(item => item.title === "隐藏的条件项")).toBe(false);
    expect(entries.some(item => item.title === "语言")).toBe(true); // other panels are is-hidden themselves
  });

  it("shows only the line under the title as the description, not the whole card", () => {
    const entries = collectSettingsEntries(document, buttons());
    const row = entries.find(item => item.title === "文件访问权限")!;
    expect(row.description).toContain("流萤不会修改本地任何文件");
    expect(row.description).not.toContain("全只读");
    expect(row.text).toContain("全只读");
    const card = entries.find(item => item.title === "连接概览");
    if (card) expect(card.description.length).toBeLessThan(80);
  });

  it("picks up rows that are added to the page later", () => {
    const list = document.querySelector("#general-form .settings-list")!;
    const row = document.createElement("div");
    row.className = "setting-row";
    row.innerHTML = "<div><strong>动态新增的项</strong><span>运行时生成</span></div>";
    list.append(row);
    expect(collectSettingsEntries(document, buttons()).some(item => item.title === "动态新增的项")).toBe(true);
  });
});

describe("searching", () => {
  const all = [entry("字体大小", "调整界面文字"), entry("界面语言", "选择显示语言"), entry("通知", "字体提示音"), entry("Sound effects", "Play a chime")];

  it("ranks a title match above a description match", () => {
    expect(searchEntries(all, "字体").map(item => item.title)).toEqual(["字体大小", "通知"]);
  });

  it("requires every word and ignores case", () => {
    expect(searchEntries(all, "sound CHIME").map(item => item.title)).toEqual(["Sound effects"]);
    expect(searchEntries(all, "sound 字体")).toEqual([]);
  });

  it("returns nothing for a blank query and honours the limit", () => {
    expect(searchEntries(all, "   ")).toEqual([]);
    expect(searchEntries(Array.from({ length: 100 }, (_, index) => entry(`项 ${index}`)), "项", 5)).toHaveLength(5);
  });

  it("finds a setting by an option label that is not in its title or description", () => {
    const row = entry("文件访问权限", "只读：不修改文件", { text: "文件访问权限 只读：不修改文件 全只读 只读 审批 完全" });
    expect(searchEntries([row], "审批").map(item => item.title)).toEqual(["文件访问权限"]);
    expect(searchEntries([entry("别的", "不相关")], "审批")).toEqual([]);
  });

  it("also matches the page name", () => {
    expect(searchEntries([entry("语言", "", { pageTitle: "通用设置" })], "通用").map(item => item.title)).toEqual(["语言"]);
  });
});

describe("search box", () => {
  function mount() {
    const select = vi.fn();
    const nav = document.querySelector<HTMLElement>(".settings-nav")!;
    const input = document.getElementById("settings-search") as HTMLInputElement;
    const results = document.getElementById("settings-search-results")!;
    const status = document.getElementById("settings-search-status")!;
    const search = mountSettingsSearch({ root: document, nav, input, results, status, buttons: buttons(), select });
    const type = (value: string) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };
    return { select, nav, input, results, status, search, type };
  }
  const items = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".settings-search-result"));

  it("is hidden until something is typed, then replaces the navigation list with results", () => {
    const f = mount();
    expect(f.results.hidden).toBe(true);
    expect(f.nav.classList.contains("is-searching")).toBe(false);
    f.type("语言");
    expect(f.results.hidden).toBe(false);
    expect(f.nav.classList.contains("is-searching")).toBe(true);
    expect(items().some(item => item.textContent?.includes("语言"))).toBe(true);
    expect(f.status.textContent).toContain("找到");
    f.type("");
    expect(f.results.hidden).toBe(true);
    expect(f.nav.classList.contains("is-searching")).toBe(false);
  });

  it("opens the page of the chosen result, scrolls to the row and highlights it briefly", () => {
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    const f = mount();
    f.type("文件访问权限");
    const choice = items().find(item => item.querySelector(".settings-search-result__title")?.textContent === "文件访问权限")!;
    expect(choice).toBeDefined();
    choice.click();
    expect(f.select).toHaveBeenCalledWith("general");
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(document.getElementById("plugin-file-card")!.classList.contains("is-search-hit")).toBe(true);
    expect(f.input.value).toBe("");
    expect(f.results.hidden).toBe(true);
  });

  it("opens only the page when a page result is chosen", () => {
    const f = mount();
    f.type("MCP");
    items().find(item => item.dataset.section === "mcp")!.click();
    expect(f.select).toHaveBeenCalledWith("mcp");
    expect(document.querySelector(".is-search-hit")).toBeNull();
  });

  it("Enter takes the first result, ArrowDown moves into the list, Escape clears", () => {
    const f = mount();
    f.type("语言");
    f.input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(items()[0]);
    items()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(f.input);
    f.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(f.select).toHaveBeenCalledTimes(1);
    f.type("语言");
    f.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(f.input.value).toBe("");
    expect(f.results.hidden).toBe(true);
  });

  it("says so when nothing matches", () => {
    const f = mount();
    f.type("zzzz-not-a-setting");
    expect(items()).toHaveLength(0);
    expect(f.results.textContent).toContain("没有找到匹配的设置");
    expect(f.status.textContent).toContain("没有找到匹配的设置");
  });

  it("focuses the search box with Ctrl+F, but not while a dialog is open", () => {
    const f = mount();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(f.input);
    f.input.blur();
    const overlay = document.createElement("div");
    overlay.className = "ff-modal-overlay";
    overlay.innerHTML = '<div class="ff-modal"></div>';
    document.body.append(overlay);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).not.toBe(f.input);
  });

  it("still focuses the search box after a dialog was shown and closed again", () => {
    const f = mount();
    const overlay = document.createElement("div");
    overlay.className = "ff-modal-overlay is-hidden"; // how the shared dialogs rest in the DOM once closed
    overlay.innerHTML = '<div class="ff-modal"></div>';
    document.body.append(overlay);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(f.input);
  });

  it("stops reacting after dispose", () => {
    const f = mount();
    f.search.dispose();
    f.type("语言");
    expect(f.results.hidden).toBe(true);
  });

  it("builds results with text nodes, never HTML from the page content", () => {
    const row = document.createElement("div");
    row.className = "setting-row";
    row.innerHTML = '<div><strong>&lt;img src=x onerror=bad()&gt;</strong><span>desc</span></div>';
    document.querySelector("#general-form .settings-list")!.append(row);
    const f = mount();
    f.type("img src");
    expect(f.results.querySelector("img")).toBeNull();
    expect(f.results.textContent).toContain("<img src=x onerror=bad()>");
  });
});
