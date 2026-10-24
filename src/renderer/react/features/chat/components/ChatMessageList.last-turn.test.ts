// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@ant-design/x", () => ({ Bubble: { List: () => null }, CodeHighlighter: () => null, Think: () => null, ThoughtChain: () => null }));
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (asset: string) => asset }));
vi.mock("./MermaidBlock", () => ({ MermaidBlock: () => null }));
vi.mock("./SvgCardBlock", () => ({ SvgCardBlock: () => null }));
import { AssistantMessageFooter, LastTurnEditAction, LastTurnIdsContext, type LastTurnIds } from "./ChatMessageList";

let root: Root, container: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.body.appendChild(document.createElement("section"));
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const settled: LastTurnIds = { userMessageId: "question-latest", assistantMessageId: "reply-latest" };
const inProgress: LastTurnIds = { userMessageId: null, assistantMessageId: null };
const draw = async (ids: LastTurnIds, child: ReactElement) => {
  await act(async () => root.render(createElement(LastTurnIdsContext.Provider, { value: ids }, child)));
};
const footer = (callback: ReturnType<typeof vi.fn>, messageId = "reply-latest", streaming = false) =>
  createElement(AssistantMessageFooter, { messageId, streaming, content: streaming ? "Live reply" : "",
    mode: "chat", preferredAddress: "", revisionBusy: false, onRegenerateLastResponse: callback });
const action = (kind: string) => container.querySelector<HTMLButtonElement>(".ff-last-turn-action--" + kind);

test("targets the settled reply even in the reasoning-to-text gap and removes it during streaming", async () => {
  const regenerate = vi.fn().mockResolvedValue(true);
  await draw(settled, footer(regenerate));
  expect(action("regenerate")).not.toBeNull();
  await act(async () => action("regenerate")!.click());
  expect(regenerate.mock.calls).toStrictEqual([["question-latest", "reply-latest"]]);
  await draw(inProgress, footer(regenerate, "reply-latest", true));
  expect(action("regenerate")).toBeNull();
});

test("retargets footer controls when the next turn becomes revisable", async () => {
  const regenerate = vi.fn().mockResolvedValue(true);
  await draw(settled, footer(regenerate));
  expect(action("regenerate")).not.toBeNull();
  const next = { userMessageId: "question-next", assistantMessageId: "reply-next" };
  await draw(next, footer(regenerate));
  expect(action("regenerate")).toBeNull();
  await draw(next, footer(regenerate, "reply-next"));
  expect(action("regenerate")).not.toBeNull();
  await act(async () => action("regenerate")!.click());
  expect(regenerate.mock.calls).toStrictEqual([["question-next", "reply-next"]]);
});

test("edits the original user content and hides stale or streaming edit controls", async () => {
  const edit = vi.fn();
  const element = createElement(LastTurnEditAction, { messageId: "question-latest",
    content: "Please inspect the guide", disabled: false, onBeginEdit: edit });
  await draw(settled, element);
  expect(action("edit")).not.toBeNull();
  await act(async () => action("edit")!.click());
  expect(edit.mock.calls).toStrictEqual([["question-latest", "Please inspect the guide"]]);
  await draw(inProgress, element);
  expect(action("edit")).toBeNull();
  await draw({ userMessageId: "question-next", assistantMessageId: "reply-next" }, element);
  expect(action("edit")).toBeNull();
});
