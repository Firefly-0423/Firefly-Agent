// @vitest-environment jsdom
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, expect, test, vi } from "vitest";

vi.mock("../../../i18n", () => ({ useTranslation: () => ({ t: (id: string) => id }) }));
import { MermaidBlock } from "./MermaidBlock";
import { SvgCardBlock } from "./SvgCardBlock";

vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());
const chart = "flowchart LR\nQueue --> Worker";
const drawing = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 90"><text x="12" y="30">Preview</text></svg>';

test.each([
  [MermaidBlock, chart, "ff-mermaid"],
  [SvgCardBlock, drawing, "ff-svg-card"],
] as const)("offers zoom on a settled %s illustration", (Component, code, prefix) => {
  const markup = renderToStaticMarkup(React.createElement(Component, { code }));
  expect(markup).toContain(prefix + "--zoomable");
  expect(markup).toContain('title="messageList.diagramZoomHint"');
  expect(markup).toContain("<svg");
});

test("uses an inert placeholder while diagram text is still arriving", () => {
  const markup = renderToStaticMarkup(React.createElement(MermaidBlock, { streaming: true, code: chart }));
  expect(markup).toContain("ff-mermaid--pending");
  for (const absent of ["ff-mermaid--zoomable", "<svg"]) expect(markup).not.toContain(absent);
});
