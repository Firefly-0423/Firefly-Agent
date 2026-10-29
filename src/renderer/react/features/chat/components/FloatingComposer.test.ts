import React, { createElement, useContext } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { clampFloatingOffset, FloatingComposer, FloatingComposerControls, parseFloatingComposerState } from "./FloatingComposer";

/** Stands in for the composer, which shows the controls it is handed in the row under the capsule. */
function Composer() { return createElement("div", null, "composer", useContext(FloatingComposerControls)); }
function render(floating: boolean, attention = false): string {
  return renderToStaticMarkup(createElement(FloatingComposer, {
    floating, attention,
    children: createElement(Composer),
  }));
}

describe("FloatingComposer", () => {
  beforeAll(() => {
    vi.stubGlobal("React", React);
  });

  it("hands the collapse and move controls to the composer only while floating", () => {
    const floating = render(true);
    expect(floating).toContain("ff-floating-composer is-floating");
    expect(floating).toMatch(/<div>composer<div class="ff-floating-composer__controls">/);
    expect(floating).toContain("is-handle");

    const docked = render(false);
    expect(docked).not.toContain("ff-floating-composer__controls");
    expect(docked).not.toContain("transform");
    expect(docked).toContain("<div>composer</div>");
  });

  it("keeps the composer mounted but hidden while collapsed, and opens it for a pending card", () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => '{"x":0,"y":0,"collapsed":true}', setItem: () => undefined } });
    try {
      const collapsed = render(true);
      expect(collapsed).toContain("ff-floating-composer__restore");
      expect(collapsed).toMatch(/<div class="ff-floating-composer__body" hidden="">/);
      expect(collapsed).toContain("<div>composer</div>");

      const waiting = render(true, true);
      expect(waiting).not.toContain("ff-floating-composer__restore");
      expect(waiting).not.toContain('hidden=""');
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal("React", React);
    }
  });

  it("keeps the card inside the workspace with a margin", () => {
    const base = { left: 100, top: 500, right: 700, bottom: 600 };
    const area = { left: 0, top: 0, right: 800, bottom: 620 };
    expect(clampFloatingOffset({ x: 0, y: 0 }, base, area, 8)).toEqual({ x: 0, y: 0 });
    expect(clampFloatingOffset({ x: -500, y: -900 }, base, area, 8)).toEqual({ x: -92, y: -492 });
    expect(clampFloatingOffset({ x: 500, y: 300 }, base, area, 8)).toEqual({ x: 92, y: 12 });
  });

  it("pins the card in place when the workspace is narrower than the card", () => {
    const base = { left: 0, top: 0, right: 900, bottom: 100 };
    const area = { left: 0, top: 0, right: 800, bottom: 600 };
    expect(clampFloatingOffset({ x: 40, y: 0 }, base, area, 8).x).toBe(0);
  });

  it("restores a saved position and ignores malformed storage", () => {
    expect(parseFloatingComposerState('{"x":-40,"y":-120,"collapsed":true}')).toEqual({ x: -40, y: -120, collapsed: true });
    expect(parseFloatingComposerState('{"x":"far","y":null}')).toEqual({ x: 0, y: 0, collapsed: false });
    expect(parseFloatingComposerState("not json")).toEqual({ x: 0, y: 0, collapsed: false });
    expect(parseFloatingComposerState(null)).toEqual({ x: 0, y: 0, collapsed: false });
  });
});
