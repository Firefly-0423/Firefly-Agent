// @vitest-environment jsdom
import { it, expect, describe } from "vitest";
import { sanitizeSvg, stripFontImports, isOverSourceLimit, SVG_SOURCE_LIMIT } from "./svg-sanitize";

const wrap = (body: string, attributes = "") => `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body}</svg>`;
describe("SVG content accepted for display", () => {
  it("uses a strict greater-than cutoff for diagram source", () => {
    expect(SVG_SOURCE_LIMIT).toEqual(20_000);
    expect([SVG_SOURCE_LIMIT - 1, SVG_SOURCE_LIMIT, SVG_SOURCE_LIMIT + 1].map(n => isOverSourceLimit("z".repeat(n))))
      .toStrictEqual([false, false, true]);
  });
  it("removes multiple remote font imports without erasing the surrounding stylesheet", () => {
    const text = "<text>offline diagram</text>";
    const styles = "text { font-family: 'Noto Sans', sans-serif; }";
    const source = wrap(`<style>@import url('https://fonts.googleapis.com/css2?family=Noto+Sans');\n${styles}\n@import url('https://fonts.googleapis.com/css2?family=Roboto');</style>${text}`);
    const stripped = stripFontImports(source);
    expect(stripped.includes("fonts.googleapis.com")).toEqual(false);
    expect(stripped).toContain(styles);
    expect(stripped).toContain(text);
  });
  it("retains drawing nodes, localized labels, data attributes and theme variables", () => {
    const clean = sanitizeSvg(wrap('<style>.item{fill:var(--surface,#fafafa)}</style><g class="item"><rect data-id="entry" data-label="入口" width="24" height="18"/><text>入口</text></g>', 'viewBox="0 0 240 180" style="--bg:#fdfbff"'));
    for (const token of ["rect", "入口", "data-id", "--bg", "viewBox"]) expect(clean).toContain(token);
  });
  it("discards executable scripts while preserving the adjacent geometry", () => {
    const clean = sanitizeSvg(wrap('<script>window.compromised=42</script><rect width="24" height="18"/>'));
    expect(clean.includes("<script")).toEqual(false);
    expect(clean.includes("window.compromised=42")).toEqual(false);
    expect(clean).toContain("rect");
  });
  it.each([
    wrap('<rect onmouseover="steal()" onclick="steal()"/>', 'onload="steal()"'),
    wrap('<a href="javascript:steal()"><text>unsafe</text></a>'),
    wrap('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><script>steal()</script></div></foreignObject>'),
  ])("removes active attributes, protocols and foreign HTML from %s", (source) => {
    const clean = sanitizeSvg(source);
    expect(clean).not.toMatch(/\son[a-z]+\s*=/i);
    expect(clean).not.toMatch(/javascript\s*:/i);
    expect(clean.toLowerCase()).not.toContain("foreignobject");
  });
});
