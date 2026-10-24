// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../../../i18n", () => ({ t: (key: string) => key, useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./ChatMessageList", () => ({ MarkdownContent: ({ content }: { content: string }) => React.createElement("div", { "data-markdown": true }, content) }));
import { PlanContent, PlanReviewEntry, planTabDotClass, planTabLabel } from "./PlanReviewPanel";
const phases = ["review", "executing", "completed", "failed", "cancelled"] as const;
let root: ReturnType<typeof createRoot>, host: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it.each(phases)("maps %s labels, notes, dot and entry interaction", phase => {
  const key = phase[0].toUpperCase() + phase.slice(1), open = vi.fn(); expect(planTabLabel(phase)).toBe(`planReview.tab${key}`); expect(planTabDotClass(phase)).toBe(`is-${phase}`);
  act(() => root.render(React.createElement(React.Fragment, null, React.createElement(PlanContent, { content: "# Plan", phase }), React.createElement(PlanReviewEntry, { phase, onOpen: open }))));
  expect(host.querySelector(".ff-plan-content__note")?.textContent).toBe(`planReview.note${key}`); expect(host.querySelector("[data-markdown]")?.textContent).toBe("# Plan"); const button = host.querySelector("button")!; expect(button.textContent).toBe(`planReview.entry${key}`); expect(button.type).toBe("button"); expect(button.querySelector("span")?.getAttribute("aria-hidden")).toBe("true"); act(() => button.click()); expect(open).toHaveBeenCalledOnce();
});
it("defaults content to review and passes empty Markdown through", () => { act(() => root.render(React.createElement(PlanContent, { content: "" }))); expect(host.querySelector(".ff-plan-content__note")?.textContent).toBe("planReview.noteReview"); expect(host.querySelector("[data-markdown]")?.textContent).toBe(""); });
