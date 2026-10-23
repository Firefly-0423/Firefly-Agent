import { describe, expect, it } from "vitest";
import { displayWidth } from "./width";

describe("displayWidth", () => {
  it("counts ASCII characters as one cell each", () => {
    expect(displayWidth("hello")).toBe(5);
    expect(displayWidth("♡ Firefly_Agent ♡")).toBe(17);
  });

  it("returns zero for the empty string", () => {
    expect(displayWidth("")).toBe(0);
  });

  it("counts box-drawing characters as one cell each", () => {
    expect(displayWidth("╭─╮")).toBe(3);
    expect(displayWidth("│ ♡ │")).toBe(5);
  });

  it("counts astral characters as one code point, not two code units", () => {
    expect(displayWidth("😀")).toBe(1);
    expect(displayWidth("a😀b")).toBe(3);
  });

  it("counts combining marks separately (code points, not grapheme clusters)", () => {
    expect(displayWidth("e\u0301")).toBe(2);
  });

  it("counts CJK characters as one cell (documented v0.9 limitation)", () => {
    expect(displayWidth("中文")).toBe(2);
  });

  it("counts newlines and tabs as one cell each", () => {
    expect(displayWidth("a\nb\tc")).toBe(5);
  });
});
