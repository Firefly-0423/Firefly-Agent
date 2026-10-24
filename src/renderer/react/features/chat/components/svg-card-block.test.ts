// @vitest-environment jsdom
import { it, expect, describe } from "vitest";
import { renderSvgCardSafe } from "./SvgCardBlock";
import { HANDWRITTEN_SVG_SOURCE_LIMIT } from "./svg-sanitize";

const card = (inner: string, attributes = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" ${attributes}>${inner}</svg>`;
describe("Handwritten card display boundary", () => {
  it.each(["", "<div>ordinary markup</div>", '<rect width="24" height="18"/>'])("returns an error without an SVG document: %s", (source) => {
    expect(renderSvgCardSafe(source)).toStrictEqual({ kind: "error" });
  });
  it("renders a normal card and strips network font dependencies", () => {
    const result = renderSvgCardSafe(card('<style>@import url("https://fonts.googleapis.com/css2?family=Roboto");</style><rect fill="#4F8AC9" width="320" height="180"/><text>课程路线</text>'));
    expect(result.kind).toEqual("svg");
    if (result.kind !== "svg") throw new Error("Expected a displayable card");
    for (const retained of ["课程路线", "#4F8AC9", "viewBox"]) expect(result.svg).toContain(retained);
    expect(result.svg.includes("fonts.googleapis.com")).toEqual(false);
  });
  it("accepts thirty thousand characters and the exact handwritten limit, then fuses", () => {
    const overhead = card("").length;
    expect(HANDWRITTEN_SVG_SOURCE_LIMIT).toEqual(60_000);
    for (const size of [30_000, HANDWRITTEN_SVG_SOURCE_LIMIT])
      expect(renderSvgCardSafe(card("q".repeat(size - overhead))).kind).toEqual("svg");
    expect(renderSvgCardSafe(card("q".repeat(HANDWRITTEN_SVG_SOURCE_LIMIT + 1 - overhead))))
      .toStrictEqual({ kind: "fuse" });
  });
  it.each([
    '<script>window.cardAttack=true</script><circle r="7"/>',
    '<rect onclick="attack()" onload="attack()"/>',
    '<a href="javascript:attack()"><text>link</text></a>',
    '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><script>window.foreignAttack=true</script></div></foreignObject>',
  ])("never returns executable markup from %s", (body) => {
    const result = renderSvgCardSafe(card(body, 'onload="window.rootAttack=true"'));
    if (result.kind !== "svg") {
      expect(["fuse", "error"]).toContain(result.kind);
      return;
    }
    expect(result.svg).not.toMatch(/<script/i);
    expect(result.svg).not.toMatch(/\son[a-z]+\s*=/i);
    expect(result.svg).not.toMatch(/javascript\s*:/i);
    expect(result.svg.toLowerCase()).not.toContain("foreignobject");
  });
});
