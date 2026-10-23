import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("@ant-design/x", () => ({
  Bubble: { List: () => null }, Think: () => null, ThoughtChain: () => null,
  CodeHighlighter: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("code", { "data-highlighted": true }, children),
}));
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (asset: string) => asset }));
vi.mock("./MermaidBlock", () => ({
  MermaidBlock: ({ streaming }: { streaming?: boolean }) =>
    React.createElement("div", { "data-chart": streaming ? "pending" : "ready" }),
}));
vi.mock("./SvgCardBlock", () => ({ SvgCardBlock: () => null }));
import { FileLinkContext, MessageStreamingContext } from "./ChatMessageList";
import { StreamdownMessageContent } from "./StreamdownMessageContent";

function display(content: string, streaming = false, workspaceRoot?: string) {
  return renderToStaticMarkup(React.createElement(FileLinkContext.Provider,
    { value: { workspaceRoot, openFile: vi.fn() } },
    React.createElement(MessageStreamingContext.Provider, { value: streaming },
      React.createElement(StreamdownMessageContent, { streaming, content }))));
}

test("renders prose and tables with unprefixed utilities and no table toolbar", () => {
  const html = display("| Key | Value |\n| --- | --- |\n| Queue | Ready |");
  expect(html).not.toContain("<button");
  expect(html).toContain("space-y-4");
  expect(html).not.toContain("sd:space-y-4");
});

test("supports inline and block math during streaming and after completion", () => {
  const live = display("Inline $x+1$ then display:\n\n$$y=2x$$", true);
  expect(live).toContain("katex");
  expect(live).toMatch(/<p><span class="katex">/);
  const settled = display("$x+1$\n\n[Guide][destination]\n\n[destination]: https://docs.invalid");
  expect(settled).toContain("katex");
  expect(settled).not.toContain('href="https://docs.invalid/"');
});

test.each(["Read this", "Cost: \\$12", "`$SHELL`", "```sh\necho $SHELL\n```"])(
  "resolves whole-document references when dollars are not math: %s", (prefix) => {
    const html = display(prefix + "\n\n[Guide][destination]\n\n[destination]: https://docs.invalid");
    expect(html).toContain('href="https://docs.invalid/"');
  });

test("preserves both GFM checkbox states", () => {
  const html = display("- [x] Reviewed\n- [ ] Published");
  expect(html).toMatch(/type="checkbox"[^>]*checked/);
  expect(html.match(/type="checkbox"/g)).toHaveLength(2);
});

test("keeps unfinished code visible while deferring Mermaid rendering", () => {
  const code = display("~~~ts\nconst answer = 42;", true);
  expect(code).toContain("data-highlighted");
  expect(code).toContain("const answer = 42;");
  expect(display("~~~mermaid\ngraph LR\nQueue-->Worker", true)).toContain('data-chart="pending"');
});

test("keeps workspace navigation usable and removes executable link or script content", () => {
  const file = display("[Open source](file:///D:/Studio/lib/main.ts#L8)", false, "D:/Studio");
  expect(file).toContain("ff-file-link");
  expect(file).not.toContain("is-plain");
  const hostile = display("[Run](javascript:alert(9))\n\n<script>alert(9)</script>");
  expect(hostile).not.toMatch(/href="javascript:/i);
  expect(hostile).not.toContain("<script");
});
