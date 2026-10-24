// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReasoningBlock } from "../../../../../shared/chat-types";

// Think is replaced by a probe that exposes its state and toggles like the real header row.
vi.mock("@ant-design/x", async () => {
  const ReactModule = await import("react");
  return {
    Bubble: { List: () => null },
    CodeHighlighter: () => null,
    Think: ({ expanded, onExpand, title, rootClassName }: { expanded?: boolean; onExpand?: (value: boolean) => void; title?: React.ReactNode; rootClassName?: string }) =>
      ReactModule.createElement("div", { "data-think": "", className: rootClassName, "data-expanded": String(Boolean(expanded)), onClick: () => onExpand?.(!expanded) }, title),
    ThoughtChain: () => null,
  };
});
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (path: string) => path }));
vi.mock("./StreamdownMessageContent.css", () => ({}));
vi.mock("./MermaidBlock", () => ({ MermaidBlock: () => null }));
vi.mock("./SvgCardBlock", () => ({ SvgCardBlock: () => null }));

import { RunActivityDetail, toQuote } from "./ChatMessageList";

let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

function render(block: ReasoningBlock) {
  act(() => root.render(React.createElement(RunActivityDetail, { live: true, reasoningBlocks: [block], processMessages: [], tools: [] })));
  return container.querySelector<HTMLElement>("[data-think]")!;
}
const think = () => container.querySelector<HTMLElement>("[data-think]")!;

it("locks reasoning open while it streams", () => {
  const live = render({ id: "r1", content: "思考中", streaming: true, seq: 1 });
  expect(live.dataset.expanded).toBe("true");
  expect(live.className).toContain("is-live");
  act(() => live.click());
  expect(think().dataset.expanded).toBe("true");
});

it("stays open after streaming and hands folding back to the user", () => {
  render({ id: "r1", content: "思考中", streaming: true, seq: 1 });
  const done = render({ id: "r1", content: "思考完", streaming: false, seq: 1 });
  expect(done.dataset.expanded).toBe("true");
  expect(done.className).not.toContain("is-live");
  act(() => done.click());
  expect(think().dataset.expanded).toBe("false");
  expect(render({ id: "r1", content: "思考完", streaming: false, seq: 1 }).dataset.expanded).toBe("false");
});

it("copies the reasoning as a quote without toggling the block", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render({ id: "r1", content: "第一行\n\n第二行", streaming: false, seq: 1 });
  const button = container.querySelector<HTMLButtonElement>(".ff-message-reasoning__quote")!;
  await act(async () => { button.click(); });
  expect(writeText).toHaveBeenCalledWith("> 第一行\n>\n> 第二行");
  expect(think().dataset.expanded).toBe("true");
  expect(button.textContent).toBe("已复制");
});

it("formats a blockquote line by line", () => {
  expect(toQuote("  a\nb  ")).toBe("> a\n> b");
});
