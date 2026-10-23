import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { expect, it } from "vitest";

const css = readFileSync(new URL("./BrowserWorkspacePanel.css", import.meta.url), "utf8");
function property(selector: string, name: string): string {
  const dom = new JSDOM(`<style>${css}</style>`);
  const rules = [...dom.window.document.styleSheets[0].cssRules] as CSSStyleRule[];
  const value = rules.filter(rule => rule.selectorText?.split(",").map(part => part.trim()).includes(selector))
    .map(rule => rule.style.getPropertyValue(name)).filter(Boolean).at(-1) ?? "";
  dom.window.close(); return value;
}

it("bounds the existing consent area without consuming the browser", () => {
  expect(property(".ff-browser-permission", "max-height")).toBe("min(40%, 240px)");
  expect(property(".ff-browser-permission", "overflow-y")).toBe("auto");
  expect(property(".ff-browser-permission", "min-height")).toBe("0px");
  expect(property(".ff-browser-permission", "box-sizing")).toBe("border-box");
});
it("keeps the address toolbar from shrinking while the viewport takes remaining space", () => {
  expect(property(".ff-browser-workspace__toolbar", "flex-shrink")).toBe("0");
  expect(property(".ff-browser-workspace__viewport", "min-height")).toBe("0px");
  expect(property(".ff-browser-workspace__viewport", "flex")).toBe("1 1 0%");
});
it("wraps the existing exact host scope in a narrow inspector", () => {
  expect(property(".ff-browser-permission__scope", "overflow-wrap")).toBe("anywhere");
});

it("bounds the consent area so the capped 16-domain list scrolls without consuming the browser", () => {
  expect(property(".ff-browser-permission", "max-height")).toBe("min(40%, 240px)");
  expect(property(".ff-browser-permission", "overflow-y")).toBe("auto");
  expect(property(".ff-browser-permission", "min-height")).toBe("0px");
  expect(property(".ff-browser-permission", "box-sizing")).toBe("border-box");
});

it("wraps long exact resource hosts and cross-site origins in a narrow inspector", () => {
  expect(property(".ff-browser-resource-consent", "min-width")).toBe("0px");
  expect(property(".ff-browser-resource-consent label", "overflow-wrap")).toBe("anywhere");
  expect(property(".ff-browser-site-consent", "overflow-wrap")).toBe("anywhere");
});

it("keeps the committed URL compact and long addresses inside the inspector", () => {
  expect(property(".ff-browser-workspace__location", "min-width")).toBe("0px");
  expect(property(".ff-browser-workspace__location [data-browser-committed-url]", "text-overflow")).toBe("ellipsis");
  expect(property(".ff-browser-workspace__location [data-browser-committed-url]", "overflow")).toBe("hidden");
  expect(property(".ff-browser-workspace__toolbar", "background")).toBe("var(--ff-bg-workspace, var(--ff-surface))");
});

const tabsCss = readFileSync(new URL("./BrowserWorkspaceTabs.css", import.meta.url), "utf8");
function tabsProperty(selector: string, name: string): string {
  const dom = new JSDOM(`<style>${tabsCss}</style>`);
  const rules = [...dom.window.document.styleSheets[0].cssRules] as CSSStyleRule[];
  const value = rules.filter(rule => rule.selectorText?.split(",").map(part => part.trim()).includes(selector))
    .map(rule => rule.style.getPropertyValue(name)).filter(Boolean).at(-1) ?? "";
  dom.window.close(); return value;
}
it("keeps tabs in one scrollable row and the close control reachable by hover, focus and selection", () => {
  expect(tabsProperty(".ff-browser-window__tabs", "flex-wrap")).toBe("nowrap");
  expect(tabsProperty(".ff-browser-window__tabs", "overflow-x")).toBe("auto");
  expect(tabsProperty(".ff-browser-window__tab > button[data-browser-close-tab]", "opacity")).toBe("0");
  expect(tabsProperty(".ff-browser-window__tab:focus-within > button[data-browser-close-tab]", "opacity")).toBe("1");
});
it("shows load progress without removing the committed address row", () => {
  expect(property(".ff-browser-workspace__toolbar[data-browser-busy]::after", "animation")).toContain("ff-browser-load");
  expect(property(".ff-browser-workspace__location", "display")).not.toBe("none");
  expect(property(".ff-browser-workspace__address:focus-within", "outline")).toContain("var(--ff-accent");
});

it("uses the user's contrast tokens for browser error and keyboard-focus surfaces", () => {
  expect(property(":root[data-ui-colors] .ff-browser-workspace__notice.is-error", "color")).toBe("var(--ff-text)");
  expect(property(":root[data-ui-colors] .ff-browser-workspace__notice.is-error", "background")).toBe("var(--ff-bg-hover)");
  expect(property(".ff-browser-permission button:focus-visible", "outline")).toContain("var(--ff-accent");
});

it("sets the toolbar as one 56px row whose address is a full pill", () => {
  expect(property(".ff-browser-workspace__toolbar", "height")).toBe("56px");
  expect(property(".ff-browser-workspace__address", "border-radius")).toBe("18px");
  expect(property(".ff-browser-workspace__address", "height")).toBe("36px");
  expect(property(".ff-browser-workspace__toolbar button", "border-radius")).toBe("8px");
});

it("groups back and forward in one outlined pill and draws reload, download and more as round buttons", () => {
  expect(property(".ff-browser-workspace__nav", "border-radius")).toBe("18px");
  expect(property(".ff-browser-workspace__nav", "height")).toBe("36px");
  for (const selector of [".ff-browser-workspace__toolbar .ff-browser-workspace__reload", ".ff-browser-workspace__toolbar .ff-browser-tools button"]) {
    expect(property(selector, "border-radius")).toBe("50%");
    expect(property(selector, "width")).toBe("36px");
  }
});

it("opens and closes a tab in about 150ms, collapsing its width and fading it", () => {
  expect(tabsProperty(".ff-browser-window__tab", "animation")).toContain("ff-browser-tab-in 150ms");
  expect(tabsProperty(".ff-browser-window__tab.is-closing", "opacity")).toBe("0");
  expect(tabsProperty(".ff-browser-window__tab.is-closing", "max-width")).toBe("0px");
  expect(tabsProperty(".ff-browser-window__tab", "transition")).toContain("150ms");
});

it("aligns the tab strip with the chat header's shared 48px row", () => {
  expect(tabsProperty(".ff-browser-window__strip", "height")).toBe("var(--ff-workspace-header-height, 48px)");
  expect(tabsProperty(".ff-browser-window__strip", "border-bottom")).toContain("var(--ff-border)");
  expect(tabsProperty(".ff-browser-window__tab > button[role=\"tab\"]", "border-radius")).toBe("16px");
});
