import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, expect, test, vi } from "vitest";

vi.mock("./ChatMessageList", () => ({
  MarkdownContent: ({ content }: { content: string }) => React.createElement("article", null, content),
}));
import { FilePreviewContent } from "./FileTreePanel";

vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());

test("can render a file preview before its contents have loaded", () => {
  let markup = "";
  expect(() => {
    markup = renderToStaticMarkup(React.createElement(FilePreviewContent,
      { relPath: "docs/manual.md", sessionId: "preview-session" }));
  }).not.toThrow();
  expect(markup).toContain("正在读取文件…");
});
