import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(resolve(__dirname, "react-root.css"), "utf8");

describe("chat workspace surface", () => {
  it("uses the Codex-reference neutral light reading surface", () => {
    const dom = new JSDOM(`
      <style>${stylesheet}</style>
      <main class="ff-page">
        <section class="ff-workspace is-empty"></section>
      </main>
    `, { pretendToBeVisual: true });
    const { document } = dom.window;
    const rootStyle = dom.window.getComputedStyle(document.documentElement);
    const rules = Array.from(document.styleSheets[0].cssRules) as CSSStyleRule[];
    const emptyPattern = rules.find((rule) => rule.selectorText === ".ff-workspace::before");
    const filledPattern = rules.find((rule) => rule.selectorText === ".ff-workspace.has-messages::before");

    expect(rootStyle.getPropertyValue("--ff-bg-page").trim()).toBe("#eff1f5");
    expect(rootStyle.getPropertyValue("--ff-bg-workspace").trim()).toBe("#f5f6f9");
    expect(emptyPattern).toBeUndefined();
    expect(filledPattern).toBeUndefined();
  });
});

 it("overlaps both edges of the eight-pixel sidebar gap with its owned pointer corridor", () => {
  const dom = new JSDOM(`<style>${stylesheet}</style>`);
  const rules = Array.from(dom.window.document.styleSheets[0].cssRules) as CSSStyleRule[];
  const corridor = rules.find(rule => rule.selectorText === ".ff-sidebar-hover-corridor");
  expect(corridor?.style.position).toBe("absolute");
  expect(corridor?.style.left).toBe("-10px");
  expect(corridor?.style.width).toBe("10px");
  expect(corridor?.style.top).toBe("0px");
  expect(corridor?.style.bottom).toBe("0px");
 });
