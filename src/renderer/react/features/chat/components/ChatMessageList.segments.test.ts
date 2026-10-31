// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@ant-design/x", () => ({ Bubble: { List: () => null }, CodeHighlighter: () => null, Think: () => null, ThoughtChain: () => null }));
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (asset: string) => asset }));
vi.mock("./MermaidBlock", () => ({ MermaidBlock: () => null }));
vi.mock("./SvgCardBlock", () => ({ SvgCardBlock: () => null }));
import { SegmentedReply } from "./ChatMessageList";
import { useSegmentedChat } from "../../../hooks/useSegmentedChat";

let root: Root, container: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.body.appendChild(document.createElement("section"));
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  delete document.documentElement.dataset.segmentedChat;
});
const bubbles = () => [...container.querySelectorAll(".ff-chat-segment")].map((bubble) => bubble.textContent?.trim());

test("shows a reply as one bubble per paragraph, adding bubbles as it streams", async () => {
  await act(async () => root.render(createElement(SegmentedReply, { content: "《Weightless》吧。\n\n写代码累的往往不是手。", streaming: true })));
  expect(bubbles()).toEqual(["《Weightless》吧。", "写代码累的往往不是手。"]);
  await act(async () => root.render(createElement(SegmentedReply, { content: "《Weightless》吧。\n\n写代码累的往往不是手。\n\n今天写的是哪部分？", streaming: false })));
  expect(bubbles()).toEqual(["《Weightless》吧。", "写代码累的往往不是手。", "今天写的是哪部分？"]);
});

test("follows the switch on the root element as settings change", async () => {
  const seen: boolean[] = [];
  function Probe() { seen.push(useSegmentedChat()); return null; }
  await act(async () => root.render(createElement(Probe)));
  await act(async () => { document.documentElement.dataset.segmentedChat = ""; });
  await act(async () => { delete document.documentElement.dataset.segmentedChat; });
  expect(seen.at(0)).toBe(false);
  expect(seen).toContain(true);
  expect(seen.at(-1)).toBe(false);
});
