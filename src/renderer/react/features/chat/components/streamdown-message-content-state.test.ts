// @vitest-environment jsdom
import * as React from "react";
import { createRoot } from "react-dom/client";
import { it, expect, vi, describe } from "vitest";

const retiredModule = vi.hoisted(() => ({ loaded: vi.fn() }));
vi.mock("@ant-design/x-markdown", () => {
  retiredModule.loaded();
  throw new Error("The renderer must not load the retired Markdown dependency");
});

vi.mock("@ant-design/x", () => ({
  CodeHighlighter: (props: { children?: React.ReactNode }) => React.createElement("code", {}, props.children),
  Bubble: { List: () => null }, Think: () => null, ThoughtChain: () => null,
}));
vi.mock("./SvgCardBlock", () => ({ SvgCardBlock: () => null }));
vi.mock("./MermaidBlock", () => ({ MermaidBlock: () => null }));
vi.mock("./StreamdownMessageContent.css", () => ({}));
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (asset: string) => asset }));

import { MarkdownContent } from "./ChatMessageList";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
function withMessage(check: (host: HTMLDivElement, render: (text: string, live: boolean) => void) => void) {
  const host = document.body.appendChild(document.createElement("div"));
  const view = createRoot(host);
  const render = (text: string, live: boolean) => React.act(() => view.render(React.createElement(MarkdownContent, { content: text, streaming: live })));
  try { check(host, render); }
  finally { React.act(() => view.unmount()); host.remove(); }
}
describe("Markdown reply updates", () => {
  it("clears an unfinished code fence when the reply is replaced", () => withMessage((host, render) => {
    render("~~~js\nlet discardedDraft = 17;", true);
    expect(host.textContent).toContain("discardedDraft");
    render("新的答复已经就绪", false);
    expect(host.textContent).toContain("新的答复已经就绪");
    expect(host.textContent).not.toContain("discardedDraft");
  }));
  it("retains the existing math DOM across completion and repeated updates", () => withMessage((host, render) => {
    const formula = "内联 $v=at$\n\n$$x=\\frac{at^2}{2}$$";
    render(formula, true);
    const math = host.querySelector(".katex");
    expect(math).not.toEqual(null);
    for (let pass = 0; pass < 2; pass++) {
      render(formula, false);
      expect(host.querySelector(".katex")).toBe(math);
    }
  }));
  it("renders ordinary Markdown while the retired package is unavailable", () => withMessage((host, render) => {
    render("**Firefly render check**", false);
    expect(host.textContent).toContain("Firefly render check");
    expect(retiredModule.loaded).not.toHaveBeenCalled();
  }));
});
