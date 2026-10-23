import { describe, expect, it } from "vitest";
import {
  BANNER_LINES,
  DEFAULT_BANNER_WIDTH,
  FIREFLY_LOGO,
  MIN_BANNER_WIDTH,
  renderBanner,
} from "../shared/banner";

const widthOf = (line: string) => Array.from(line).length;

describe("renderBanner", () => {
  it("renders the logo, a blank separator and the framed lines in order", () => {
    const lines = renderBanner().split("\n");
    expect(lines.slice(0, FIREFLY_LOGO.length)).toEqual([...FIREFLY_LOGO]);
    expect(lines[FIREFLY_LOGO.length]).toBe("");
    expect(lines[FIREFLY_LOGO.length + 1]!.startsWith("╭")).toBe(true);
    expect(lines.at(-1)).toMatch(/^╰─+╯$/);
  });

  it("frames every banner line at the default width", () => {
    const rows = renderBanner()
      .split("\n")
      .filter((line) => line.startsWith("│"));
    expect(rows).toHaveLength(BANNER_LINES.length);
    for (const row of rows) {
      expect(widthOf(row)).toBe(DEFAULT_BANNER_WIDTH);
      expect(row.endsWith(" │")).toBe(true);
      expect(row.startsWith("│ ")).toBe(true);
    }
  });

  it("centers each banner line within one character of perfect alignment", () => {
    const rows = renderBanner()
      .split("\n")
      .filter((line) => line.startsWith("│"))
      .map((row) => row.slice(2, -2));
    BANNER_LINES.forEach((text, index) => {
      const cell = rows[index]!;
      expect(cell.trim()).toBe(text);
      const leading = cell.length - cell.trimStart().length;
      const trailing = cell.length - cell.trimEnd().length;
      expect(Math.abs(leading - trailing)).toBeLessThanOrEqual(1);
    });
  });

  it("emits plain text without ANSI color escapes", () => {
    expect(renderBanner()).not.toMatch(/\u001b\[/);
  });

  it("keeps the documented width constants", () => {
    expect(DEFAULT_BANNER_WIDTH).toBe(64);
    expect(MIN_BANNER_WIDTH).toBe(60);
    expect(FIREFLY_LOGO.length).toBeGreaterThan(0);
    expect(BANNER_LINES).toContain("♡ Firefly_Agent ♡");
  });
});
