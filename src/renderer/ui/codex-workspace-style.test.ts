import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const sources = {
  root: readFileSync(new URL("../react/styles/react-root.css", import.meta.url), "utf8"),
  inspector: readFileSync(new URL("../react/features/chat/components/RightInspector.css", import.meta.url), "utf8"),
  theme: readFileSync(new URL("./theme.css", import.meta.url), "utf8"),
  messages: readFileSync(new URL("../react/features/chat/components/ChatMessageList.css", import.meta.url), "utf8"),
};
function value(file: keyof typeof sources, selector: string, property: string, media?: string): string {
  const dom = new JSDOM(`<style>${sources[file]}</style>`);
  const topLevel = [...dom.window.document.styleSheets[0].cssRules];
  const rules = (media
    ? topLevel.filter(rule => "conditionText" in rule && rule.conditionText === media)
      .flatMap(rule => [...(rule as CSSMediaRule).cssRules])
    : topLevel) as CSSStyleRule[];
  const result = rules.filter(rule => rule.selectorText?.split(",").map(text => text.trim()).includes(selector))
    .map(rule => rule.style.getPropertyValue(property)).filter(Boolean).at(-1) ?? "";
  dom.window.close(); return result;
}
function channels(hex: string) { return [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)); }

describe("Codex-reference workbench presentation", () => {
  it("defaults to a cool blue-grey light palette in both React and shared theme tokens", () => {
    // Tinted but restrained: no channel spread beyond a slate cast, and text stays dark on a light ground.
    for (const key of ["--ff-accent", "--ff-text", "--ff-text-muted", "--ff-border"]) {
      const rgb = channels(value("root", ":root", key));
      expect(Math.max(...rgb) - Math.min(...rgb), key).toBeLessThanOrEqual(40);
    }
    expect(Math.min(...channels(value("root", ":root", "--ff-bg-page")))).toBeGreaterThanOrEqual(232);
    expect(Math.max(...channels(value("root", ":root", "--ff-text")))).toBeLessThanOrEqual(100);
    expect(value("theme", '[data-ui-theme="pearl-white"]', "--rb-pink-500")).toBe(value("root", ":root", "--ff-accent"));
  });
  it("uses adjacent flat columns while retaining the 12px outer and content corners", () => {
    expect(value("root", ".ff-page", "gap")).toBe("0px");
    const padding = value("root", ".ff-page", "padding");
    expect(padding).toBe("var(--ff-app-titlebar-height) var(--ff-workspace-gutter) var(--ff-workspace-gutter) var(--ff-workspace-gutter)");
    expect(value("root", ":root", "--ff-app-titlebar-height")).toBe("50px");
    expect(value("root", ":root", "--ff-workspace-gutter")).toBe("8px");
    // CSSOM does not resolve var() in JSDOM. Check the actual referenced token
    // values too, so the geometry contract cannot pass with incorrect defaults.
    expect(padding.replace(/var\((--[\w-]+)\)/g, (_, token: string) => value("root", ":root", token)))
      .toBe("50px 8px 8px 8px");
    expect(value("root", ".ff-page", "border-radius")).toBe("12px");
    expect(value("root", ".ff-workspace", "border")).toBe("0px");
    expect(value("root", ".ff-workspace", "box-shadow")).toBe("none");
    expect(value("root", ".ff-workspace", "border-radius")).toBe("12px");
    // Inspector panels are rounded cards of the same 12px radius on the page ground.
    expect(value("inspector", ".ff-inspector-pane", "border-radius")).toBe("12px");
  });
  it("aligns conversation and inspector headers on the shared 48px row under the title bar", () => {
    expect(value("root", ":root", "--ff-workspace-header-height")).toBe("48px");
    expect(value("root", ".ff-workspace-header", "height")).toBe("var(--ff-workspace-header-height)");
    expect(value("root", ".ff-page-titlebar", "height")).toBe("var(--ff-app-titlebar-height)");
    // A panel header's bottom edge lands on the chat header's 48px line: 8px inset + 1px frame + 38px header + 1px rule.
    const px = (text: string) => Number.parseFloat(text);
    expect(px(value("inspector", ".ff-right-inspector", "padding")) + 1 + px(value("inspector", ".ff-inspector-pane__head", "height")) + 1)
      .toBe(px(value("root", ":root", "--ff-workspace-header-height")));
  });
  it("keeps the titlebar clear when the narrow sidebar floats over the workspace", () => {
    const media = "(max-width: 900px)";
    expect(value("root", ".ff-page.is-collapsed", "padding-left")).toBe("var(--ff-workspace-gutter)");
    expect(value("root", ".ff-page-sidebar.is-floating", "top")).toBe("var(--ff-app-titlebar-height)");
    expect(value("root", ".ff-page-sidebar", "position", media)).toBe("absolute");
    expect(value("root", ".ff-page-sidebar", "top", media)).toBe("var(--ff-app-titlebar-height)");
    // Right of the 48px activity rail, which must stay reachable.
    expect(value("root", ".ff-page-sidebar", "left", media)).toBe("calc(var(--ff-workspace-gutter) + 48px)");
    expect(value("root", ".ff-page-sidebar", "bottom", media)).toBe(value("root", ":root", "--ff-workspace-gutter"));
    expect(value("root", ".ff-page-sidebar", "border-radius", media)).toBe("12px");
    expect(value("root", ".ff-workspace-composer", "padding", media)).toBe("12px");
    expect(value("root", ".ff-workspace.has-messages .ff-workspace-composer", "padding", media)).toBe("12px");
  });
  it("draws thin neutral separators without a permanent accent stripe", () => {
    expect(value("root", ".ff-dock-separator::after", "width")).toBe("1px");
    expect(value("root", ".ff-dock-separator::after", "background")).toBe("var(--ff-border)");
    expect(value("root", ".ff-sidebar-resizer::after", "width")).toBe("1px");
    expect(value("root", ".ff-sidebar-resizer::after", "background")).toBe("var(--ff-border)");
  });
  it("uses rounded panel cards and keeps native browser bounds stable during entry", () => {
    expect(value("inspector", ".ff-inspector-pane", "border-radius")).toBe("12px");
    expect(value("inspector", ".ff-inspector-pane__action", "border-radius")).toBe("7px");
    expect(sources.inspector).not.toContain("transform: translateX");
  });
  it("centres the empty-state greeting in the free space and docks the composer at the bottom, without changing the composer's component lifetime", () => {
    expect(value("root", ".ff-workspace.is-empty .ff-workspace-composer", "flex")).toBe("0 0 auto");
    // the greeting takes the free space and centres itself; the composer keeps no auto margins, so it stays docked and does not jump on the first message
    expect(value("root", ".ff-workspace.is-empty .ff-workspace-greeting", "flex")).toBe("1 1 auto");
    expect(value("root", ".ff-workspace.is-empty .ff-workspace-greeting", "justify-content")).toBe("center");
    expect(value("root", ".ff-workspace.is-empty .ff-workspace-composer", "margin")).toBe("0px");
    expect(value("root", ".ff-workspace-greeting", "display")).toBe("none"); // hidden once the conversation has messages
  });
  it("does not paint an accent box behind a sticker-only user message", () => {
    expect(value("messages", ":root[data-ui-colors] .ff-message--user:has(.ff-message__sticker:only-child) .ant-bubble-content", "background")).toBe("transparent");
  });
  it("keeps default user bubbles light and retains chosen custom accent colors", () => {
    expect(value("messages", ".ff-message--user .ant-bubble-content", "background")).toBe("var(--ff-bg-active)");
    expect(value("messages", ".ff-message--user .ant-bubble-content", "color")).toBe("var(--ff-text)");
    expect(value("messages", ":root[data-ui-colors] .ff-message--user .ant-bubble-content", "background")).toBe("var(--ff-accent)");
    expect(value("messages", ":root[data-ui-colors] .ff-message--user .ant-bubble-content", "color")).toBe("var(--rb-text-on-pink)");
  });
});
