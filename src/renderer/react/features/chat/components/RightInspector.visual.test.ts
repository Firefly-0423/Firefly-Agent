import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(resolve(__dirname, "RightInspector.css"), "utf8");
function rule(selector: string): CSSStyleRule | undefined {
  const dom = new JSDOM(`<style>${stylesheet}</style>`);
  return (Array.from(dom.window.document.styleSheets[0].cssRules) as CSSStyleRule[]).find((item) => item.selectorText === selector);
}

describe("RightInspector surface", () => {
  it("lays panels on the page ground as flat rounded cards without a decorative image", () => {
    const inspector = rule(".ff-right-inspector");
    expect(inspector?.style.background).toBe("var(--ff-bg-page)");
    expect(inspector?.style.gap).toBe("8px");
    const pane = rule(".ff-inspector-pane");
    expect(pane?.style.background).toBe("var(--ff-bg-workspace)");
    expect(pane?.style.borderRadius).toBe("12px");
    expect(pane?.style.backgroundImage).toBe("");
  });

  it("fades panels in without moving them, so a native browser view keeps its bounds", () => {
    expect(stylesheet).toMatch(/@keyframes ff-right-inspector-slide-in \{\s*from \{ opacity: 0; \}\s*to \{ opacity: 1; \}\s*\}/);
    expect(rule(".ff-inspector-pane")?.style.animation).toContain("ff-right-inspector-slide-in");
  });

  it("hides only a loaded page while dragging, never the whole browser panel", () => {
    expect(stylesheet).toContain('[data-shielded] .ff-inspector-pane[data-inspector-kind="browser"] .ff-browser-workspace__viewport:not(:has(.ff-browser-newtab, .ff-browser-workspace__empty)) { display: none; }');
    expect(stylesheet).not.toMatch(/\[data-shielded\][^{]*\.ff-inspector-pane__body\s*\{\s*display:\s*none/);
  });
});
