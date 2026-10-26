import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.stubGlobal("React", React);
import { RunStageIndicator } from "./RunStageIndicator";

it("drops its dot while the run header already spins, and keeps it once the run settles", () => {
  const live = renderToStaticMarkup(createElement(RunStageIndicator, { stage: { kind: "understanding" } as never, dot: false }));
  const settled = renderToStaticMarkup(createElement(RunStageIndicator, { stage: { kind: "completed" } as never }));
  expect(live).not.toContain("ff-run-stage__pulse");
  expect(settled).toContain("ff-run-stage__pulse");
});
