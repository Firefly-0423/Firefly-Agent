// @vitest-environment jsdom
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { assistantRenderStages, resolveReasoningExpanded, updateReasoningExpanded } from "./message-visibility";

const observations = vi.hoisted(() => ({ markdown: [] as any[], math: vi.fn(), highlight: vi.fn() }));
vi.mock("@streamdown/math", () => ({ createMathPlugin: observations.math.mockReturnValue({}) }));
vi.mock("streamdown", () => ({
  defaultRehypePlugins: { raw: () => null, sanitize: () => null, harden: () => null },
  Streamdown: (props: any) => {
    observations.markdown.push(props);
    return React.createElement("article", { "data-markdown": true }, props.children);
  },
}));
vi.mock("@ant-design/x", () => ({
  Bubble: { List: ({ items, role }: any) => React.createElement(React.Fragment, null,
    items.map((item: any) => React.createElement(React.Fragment, { key: item.key },
      role[item.role].contentRender?.(item.content, { extraInfo: item.extraInfo }) ?? item.content))) },
  CodeHighlighter: (props: any) => { observations.highlight(props); return React.createElement("code", null, props.children); },
  Think: ({ expanded, onExpand, destroyOnHidden, children }: any) => React.createElement("section", null,
    React.createElement("button", { onClick: () => onExpand(!expanded), "data-fold-reasoning": true }, "Toggle"),
    expanded ? children : destroyOnHidden ? null : React.createElement("div", { hidden: true }, children)),
  ThoughtChain: () => null,
}));
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (asset: string) => asset }));
vi.mock("./MermaidBlock", () => ({ MermaidBlock: () => null }));
vi.mock("./SvgCardBlock", () => ({ SvgCardBlock: () => null }));
vi.mock("./useScrollPinning", () => ({
  useScrollPinning: () => ({ containerRef: React.useRef(null), onScroll: vi.fn(), scrollToBottom: vi.fn(), markUserScroll: vi.fn() }),
}));
import { ChatMessageList, createMessageItems, MarkdownContent } from "./ChatMessageList";
import { StreamdownMessageContent } from "./StreamdownMessageContent";

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

test.each([
  { message: { content: "", loading: true, responseStarted: false }, stages: [] },
  { message: { content: "", reasoningStreaming: true, responseStarted: false }, stages: ["reasoning"] },
  { message: { content: "", runActivity: { startedAt: 400, reasoningMs: 0 } }, stages: ["activity"] },
  { message: { content: "Settled reply", reasoning: "Analysis", responseStarted: true }, stages: ["reasoning", "assistant"] },
  { message: { content: "", transientText: "Draft preview", responseStarted: false }, stages: ["assistant"] },
])("exposes only supported stages for $message", ({ message, stages }) => expect(assistantRenderStages(message)).toStrictEqual(stages));

test("defaults reasoning open and keeps a user's fold choice without unnecessary replacement", () => {
  expect(resolveReasoningExpanded({}, "unseen-reply")).toBe(true);
  const folded = updateReasoningExpanded({}, "folded-reply", false);
  expect(resolveReasoningExpanded(folded, "folded-reply")).toBe(false);
  expect(updateReasoningExpanded(folded, "folded-reply", false)).toBe(folded);
});

test("groups run activity and gives legacy tool bubbles distinct ordered keys", () => {
  const tools = [{ id: "scan", name: "list_dir", status: "success" as const }, { id: "read", name: "read_file", status: "success" as const }];
  const grouped = createMessageItems([{ id: "run-reply", role: "assistant", content: "", toolExecutions: tools,
    reasoning: "Inspecting files", runActivity: { startedAt: 400, reasoningMs: 0 } }], []);
  expect(grouped.map(item => [item.role, item.key])).toStrictEqual([["activity", "run-reply-activity"]]);
  const legacy = createMessageItems([{ id: "legacy-reply", role: "assistant", content: "", toolExecutions: tools }], []);
  expect(legacy.map(item => item.key)).toStrictEqual(["legacy-reply-tool-scan", "legacy-reply-tool-read"]);
  expect(legacy.some(item => item.key === "legacy-reply-tools")).toBe(false);
});

test("unmounts folded reasoning Markdown and preserves folding after a message update", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("main")), root = createRoot(host);
  const show = async (reasoning: string) => React.act(async () => root.render(React.createElement(ChatMessageList, {
    messages: [{ id: "reasoned-reply", role: "assistant", content: "", reasoning }],
    mode: "chat", preferredAddress: "", conversationId: "visibility-session",
  })));
  try {
    await show("Detailed reasoning");
    expect(host.textContent).toContain("Detailed reasoning");
    await React.act(async () => (host.querySelector("[data-fold-reasoning]") as HTMLButtonElement).click());
    expect(host.querySelector("[data-markdown]")).toBeNull();
    await show("Detailed reasoning updated");
    expect(host.querySelector("[data-markdown]")).toBeNull();
  } finally { await React.act(async () => root.unmount()); }
});

test("passes normalized Markdown and reuses the renderer configuration across live updates", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  observations.markdown.length = 0;
  const root = createRoot(document.body.appendChild(document.createElement("main")));
  try {
    for (const content of ["##First heading", "##Second heading", "##Settled heading"]) {
      await React.act(async () => root.render(React.createElement(MarkdownContent, { content, streaming: true })));
    }
    const calls = observations.markdown;
    expect(calls.map(call => [call.children, call.parseIncompleteMarkdown])).toStrictEqual([
      ["## First heading", true], ["## Second heading", true], ["## Settled heading", true],
    ]);
    for (const call of calls) {
      expect(call.components).toBe(calls[0].components);
      expect(call.rehypePlugins).toBe(calls[0].rehypePlugins);
    }
    expect(observations.math).toHaveBeenCalledWith({ singleDollarTextMath: true });
    const pre = calls[0].components.pre;
    await React.act(async () => root.render(React.createElement(pre, null,
      React.createElement("code", { className: "language-ts" }, "const count = 7;"))));
    expect(observations.highlight).toHaveBeenCalledWith(expect.objectContaining({ prismLightMode: false }));
    await React.act(async () => root.render(React.createElement(StreamdownMessageContent, { content: "Settled", streaming: false })));
    expect(document.body.textContent).toContain("Settled");
    expect(document.querySelector(".ff-message-markdown-fallback")).toBeNull();
  } finally { await React.act(async () => root.unmount()); }
});
