import { describe, expect, it } from "vitest";
import { renderAbout, renderBanner, resolveWidth } from "./render";
import { FIREFLY_LOGO_TEXT, FIREFLY_LOGO } from "./ascii";
import { ABOUT_LINES, BANNER_LINES, MIN_BANNER_WIDTH } from "./text";

describe("terminal presentation contract", () => {
  it("exports six populated logo rows separated by single newlines", () => {
    expect(FIREFLY_LOGO.length).toEqual(6);
    expect(FIREFLY_LOGO_TEXT.split("\n").length).toEqual(6);
    expect(FIREFLY_LOGO_TEXT).toEqual(FIREFLY_LOGO.join("\n"));
    FIREFLY_LOGO.forEach(row => expect(row.length).toBeGreaterThan(0));
  });

  it("places a rounded frame after the logo and its separator", () => {
    const rows = renderBanner({ width: 64 }).split("\n");
    expect(rows.slice(0, 6)).toStrictEqual([...FIREFLY_LOGO]);
    expect(rows[6]).toEqual("");
    expect(rows[7]).toMatch(/^╭.*╮$/);
    expect(rows.at(-1)).toMatch(/^╰.*╯$/);
    const content = rows.join("\n");
    expect(content).toContain("Chat · Work · Code");
    BANNER_LINES.forEach(text => expect(content).toContain(text));
    rows.forEach(row => expect([...row].length).toBeLessThanOrEqual(64));
  });

  it("keeps every row within the minimum when the requested width is too small", () => {
    renderBanner({ width: 18 }).split("\n").forEach(row => {
      expect([...row].length).toBeLessThanOrEqual(MIN_BANNER_WIDTH);
    });
    expect(resolveWidth({ width: 9 })).toEqual(MIN_BANNER_WIDTH);
    expect(resolveWidth({ width: 82 })).toEqual(82);
  });

  it("includes the project link and all metadata in the extended banner", () => {
    const about = renderAbout({ width: 64 });
    ABOUT_LINES.forEach(text => expect(about).toContain(text));
    expect(about).toContain("https://github.com/Firefly-0423/Firefly-Agent");
  });
});
