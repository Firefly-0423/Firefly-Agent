// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
vi.mock("../../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { BROWSER_START_SITES, BrowserNewTab, BrowserNewTabToolsContext, clearRecentSites, recentSites, rememberVisitedSite, type BrowserNewTabTool } from "./BrowserNewTab";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clearRecentSites();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

function render(props: { available?: boolean; onOpen?: (url: string) => void } = {}) {
  act(() => root.render(createElement(BrowserNewTab, { onOpen: props.onOpen ?? (() => {}), available: props.available })));
}
function renderWithTools(tools: BrowserNewTabTool[]) {
  act(() => root.render(createElement(BrowserNewTabToolsContext.Provider, { value: tools }, createElement(BrowserNewTab, { onOpen: () => {} }))));
}
const toolButtons = () => Array.from(host.querySelectorAll<HTMLButtonElement>("[data-browser-tool]"));
const tiles = () => Array.from(host.querySelectorAll<HTMLButtonElement>("[data-browser-site]"));

describe("browser new-tab page", () => {
  it("recommends only Bing, Wikipedia and Bilibili, each with its own icon", () => {
    expect(BROWSER_START_SITES.map(site => site.url)).toEqual(["https://www.bing.com/", "https://zh.wikipedia.org/", "https://www.bilibili.com/"]);
    expect(BROWSER_START_SITES.every(site => site.icon.length > 0)).toBe(true);
  });

  it("lays the start sites out as icon tiles with names beneath, each carrying its address", () => {
    render();
    expect(host.querySelector("[data-browser-newtab]")).not.toBeNull();
    expect(tiles().map(tile => tile.dataset.browserSite)).toEqual(BROWSER_START_SITES.map(site => site.url));
    const first = tiles()[0]!;
    expect(first.querySelector(".ff-browser-newtab__icon img")?.getAttribute("src")).toBe(BROWSER_START_SITES[0]!.icon);
    expect(first.querySelector(".ff-browser-newtab__name")?.textContent).toBe(BROWSER_START_SITES[0]!.title);
    expect(first.getAttribute("title")).toBe(BROWSER_START_SITES[0]!.url);
  });

  it("shows no Tools group when the host offers none", () => {
    render();
    expect(host.querySelector("[data-browser-tool]")).toBeNull();
    expect(host.querySelector('[aria-label="browserWorkspace.newTabTools"]')).toBeNull();
  });

  it("lists the offered workspace tools above the recommended sites and runs the chosen one", () => {
    const openFiles = vi.fn();
    const openTasks = vi.fn();
    renderWithTools([
      { id: "files", label: "Files", icon: null, onSelect: openFiles },
      { id: "tasks", label: "Tasks", icon: null, onSelect: openTasks },
    ]);

    const headings = Array.from(host.querySelectorAll("h3")).map(heading => heading.textContent);
    expect(headings).toEqual(["browserWorkspace.newTabTools", "browserWorkspace.newTabSites"]);
    expect(toolButtons().map(button => button.dataset.browserTool)).toEqual(["files", "tasks"]);
    act(() => toolButtons()[1]!.click());
    expect(openTasks).toHaveBeenCalledTimes(1);
    expect(openFiles).not.toHaveBeenCalled();
  });

  it("headings the start sites as recommended and omits the recent group until a site was visited", () => {
    render();
    const headings = Array.from(host.querySelectorAll("h3")).map(heading => heading.textContent);
    expect(headings).toEqual(["browserWorkspace.newTabSites"]);
    expect(host.querySelector('[aria-label="browserWorkspace.newTabRecent"]')).toBeNull();
  });

  it("places recently visited sites first, newest first, under their own heading", () => {
    rememberVisitedSite("https://news.example/path?q=1");
    rememberVisitedSite("https://docs.example/start");
    expect(recentSites().map(site => site.url)).toEqual(["https://docs.example/", "https://news.example/"]);
    render();
    const headings = Array.from(host.querySelectorAll("h3")).map(heading => heading.textContent);
    expect(headings).toEqual(["browserWorkspace.newTabRecent", "browserWorkspace.newTabSites"]);
    expect(tiles().slice(0, 2).map(tile => tile.dataset.browserSite)).toEqual(["https://docs.example/", "https://news.example/"]);
  });

  it("remembers only https origins, moves a repeat visit to the front, and keeps eight sites", () => {
    rememberVisitedSite("http://plain.example/");
    rememberVisitedSite("not a url");
    for (let index = 0; index < 9; index++) rememberVisitedSite(`https://site${index}.example/`);
    rememberVisitedSite("https://site1.example/again");
    const urls = recentSites().map(site => site.url);
    expect(urls).toHaveLength(8);
    expect(urls[0]).toBe("https://site1.example/");
    expect(urls.some(url => url.startsWith("http://"))).toBe(false);
  });

  it("opens a tile through the address path with its own address", () => {
    const onOpen = vi.fn();
    render({ onOpen });
    act(() => tiles()[1]!.click());
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(BROWSER_START_SITES[1]!.url);
  });

  it("has no footnote and disables every tile while the browser is unavailable", () => {
    render({ available: false });
    expect(host.querySelector("[data-browser-newtab]")!.hasAttribute("data-disabled")).toBe(true);
    expect(host.querySelector(".ff-browser-newtab__hint")).toBeNull();
  });
});

describe("browser new-tab page styling", () => {
  const css = readFileSync(resolve(__dirname, "./BrowserNewTab.css"), "utf8");
  function declaration(selector: string, property: string): string {
    const dom = new JSDOM(`<style>${css}</style>`);
    const rules = [...dom.window.document.styleSheets[0].cssRules] as CSSStyleRule[];
    const value = rules.filter(rule => rule.selectorText?.split(",").map(part => part.trim()).includes(selector))
      .map(rule => rule.style.getPropertyValue(property)).filter(Boolean).at(-1) ?? "";
    dom.window.close(); return value;
  }
  it("wraps the tile row and keeps each tile a fixed, round-cornered target", () => {
    expect(declaration(".ff-browser-newtab__row", "flex-wrap")).toBe("wrap");
    expect(declaration(".ff-browser-newtab__tile", "border-radius")).toBe("14px");
    expect(declaration(".ff-browser-newtab__tile", "width")).toBe("84px");
  });
  it("gives hover, keyboard focus and press states a short transition", () => {
    expect(declaration(".ff-browser-newtab__tile:hover", "background")).toBe("var(--ff-bg-hover)");
    expect(declaration(".ff-browser-newtab__tile:focus-visible", "outline")).toContain("var(--ff-accent");
    expect(declaration(".ff-browser-newtab__tile:active", "transform")).toBe("scale(0.97)");
    expect(declaration(".ff-browser-newtab__tile", "transition")).toContain("150ms");
  });
  it("takes its surfaces and text from the theme tokens rather than fixed colours", () => {
    expect(declaration(".ff-browser-newtab", "background")).toBe("var(--ff-bg-workspace, var(--ff-surface))");
    expect(css).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
  it("removes the tile motion under reduced motion", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.ff-browser-newtab__tile \{ transition: none; \}/);
  });
});
