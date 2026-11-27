// @vitest-environment jsdom
import * as React from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Streamdown, defaultRehypePlugins } from "streamdown";
import { createMathPlugin } from "@streamdown/math";
import { it, expect, vi, describe } from "vitest";

const retiredModule = vi.hoisted(() => ({ loaded: vi.fn() }));
vi.mock("@ant-design/x-markdown", () => {
  retiredModule.loaded();
  throw new Error("The renderer must not load the retired Markdown dependency");
});

vi.mock("@ant-design/x", () => ({
  CodeHighlighter: (props: { children?: React.ReactNode }) => React.createElement("code", { "data-highlighted": "true" }, props.children),
  Bubble: { List: () => null }, Think: () => null, ThoughtChain: () => null,
}));
vi.mock("./SvgCardBlock", () => ({ SvgCardBlock: () => null }));
vi.mock("./MermaidBlock", () => ({
  MermaidBlock: ({ code, streaming }: { code: string; streaming?: boolean }) =>
    React.createElement("div", { "data-mermaid": streaming ? "pending" : "ready" }, code),
}));
vi.mock("./StreamdownMessageContent.css", () => ({}));
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (asset: string) => asset }));

import { MarkdownContent } from "./ChatMessageList";
import { StreamdownMessageContent } from "./StreamdownMessageContent";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
function withMessage(check: (host: HTMLDivElement, render: (text: string, live: boolean) => void) => void) {
  const host = document.body.appendChild(document.createElement("div"));
  const view = createRoot(host);
  const render = (text: string, live: boolean) => React.act(() => view.render(React.createElement(MarkdownContent, { content: text, streaming: live })));
  try { check(host, render); }
  finally { React.act(() => view.unmount()); host.remove(); }
}

const staticPlugins = { math: createMathPlugin({ singleDollarTextMath: true }) };
const staticRehype = [defaultRehypePlugins.raw, defaultRehypePlugins.sanitize, defaultRehypePlugins.harden];
function renderStaticBaseline(content: string): string {
  return renderToStaticMarkup(React.createElement(Streamdown, {
    className: "ff-message-markdown ff-streamdown-message",
    mode: "static", parseIncompleteMarkdown: false, controls: { table: false },
    tableMaxHeight: 0, rehypePlugins: staticRehype, plugins: staticPlugins,
    components: {
      a: ({ href, children }: { href?: string; children?: React.ReactNode }) =>
        React.createElement("a", { rel: "noreferrer", target: "_blank", href }, children),
      pre: ({ children }: { children?: React.ReactNode }) => {
        const first = React.Children.toArray(children)[0];
        if (React.isValidElement<{ className?: string; children?: React.ReactNode }>(first)) {
          const lang = /language-([\S]+)/.exec(first.props.className ?? "")?.[1] ?? "";
          const code = String(first.props.children ?? "").replace(/\n$/, "");
          if (lang === "mermaid") return React.createElement("div", { "data-mermaid": "ready" }, code);
          return React.createElement("code", { "data-highlighted": "true" }, code);
        }
        return React.createElement("pre", null, children);
      },
    },
  }, content));
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

  it("retains DOM element identity for completed paragraphs and code nodes across appends and completion", () => withMessage((host, render) => {
    const p1 = "First settled paragraph.";
    const code1 = "```ts\nconst stable = 1;\n```";
    render(`${p1}\n\n${code1}\n\nSecond `, true);
    const firstParagraph = host.querySelector("p");
    const firstCode = host.querySelector('code[data-highlighted="true"]');
    expect(firstParagraph?.textContent).toBe("First settled paragraph.");
    expect(firstCode?.textContent).toBe("const stable = 1;");
    expect(host.querySelector("[data-sd-animate]")).toBeNull();

    render(`${p1}\n\n${code1}\n\nSecond paragraph complete.\n\nThird trailing`, true);
    expect(host.querySelectorAll("p")[0]).toBe(firstParagraph);
    expect(host.querySelector('code[data-highlighted="true"]')).toBe(firstCode);
    expect(host.querySelector("[data-sd-animate]")).toBeNull();

    render(`${p1}\n\n${code1}\n\nSecond paragraph complete.\n\nThird trailing`, false);
    expect(host.querySelectorAll("p")[0]).toBe(firstParagraph);
    expect(host.querySelector('code[data-highlighted="true"]')).toBe(firstCode);
  }));

  it("renders unclosed code and mermaid fences as monospace plain text until closed", () => withMessage((host, render) => {
    render("Intro\n\n```ts\nconst x = 1;", true);
    expect(host.querySelector("pre.ff-code-plain")?.textContent).toBe("const x = 1;");
    expect(host.querySelector('code[data-highlighted="true"]')).toBeNull();

    render("Intro\n\n```ts\nconst x = 1;\n```", true);
    expect(host.querySelector("pre.ff-code-plain")).toBeNull();
    const highlighted = host.querySelector('code[data-highlighted="true"]');
    expect(highlighted?.textContent).toBe("const x = 1;");

    render("Intro\n\n```ts\nconst x = 1;\n```\n\n```mermaid\ngraph LR\nA-->B", true);
    expect(host.querySelector('code[data-highlighted="true"]')).toBe(highlighted);
    expect(host.querySelector("pre.ff-code-plain")?.textContent).toBe("graph LR\nA-->B");
    expect(host.querySelector('[data-mermaid="ready"]')).toBeNull();

    render("Intro\n\n```ts\nconst x = 1;\n```\n\n```mermaid\ngraph LR\nA-->B\n```", true);
    expect(host.querySelector("pre.ff-code-plain")).toBeNull();
    expect(host.querySelector('[data-mermaid="ready"]')?.textContent).toBe("graph LR\nA-->B");
    expect(host.querySelector('code[data-highlighted="true"]')).toBe(highlighted);
  }));

  it("waits for a valid table separator row and keeps fixed table layout", () => withMessage((host, render) => {
    render("| Key | Value |\n| ---", true);
    expect(host.querySelector("table")).toBeNull();
    render("| Key | Value |\n| --- | --- |\n| A | 1 |", true);
    expect(host.querySelectorAll("thead th").length).toBe(2);
    expect(host.querySelectorAll("tbody tr").length).toBe(1);
    const css = readFileSync(resolve(__dirname, "ChatMessageList.css"), "utf8");
    expect(css).toMatch(/\.ff-message-markdown \[data-streamdown="table"\]\s*\{[^}]*table-layout:\s*fixed/);
  }));

  it("keeps nested lists with blank lines as one list and matches static semantics", () => {
    const samples = [
      {
        name: "reference links across paragraphs",
        md: "See [Guide][dest] for details.\n\nSecond paragraph.\n\n[dest]: https://docs.invalid/guide",
      },
      {
        name: "tables",
        md: "| Name | Role |\n| --- | --- |\n| Firefly | Assistant |\n| Trailblazer | User |",
      },
      {
        name: "fenced code and mermaid",
        md: "```ts\nexport const n = 42;\n```\n\n```mermaid\ngraph LR\nA-->B\n```",
      },
      {
        name: "nested lists across blank lines",
        md: "- outer one\n  - inner one\n\n  - inner two\n\n- outer two",
      },
    ];

    for (const sample of samples) {
      const actual = renderToStaticMarkup(React.createElement(StreamdownMessageContent, {
        content: sample.md,
        streaming: false,
      })).replace(/>\s+</g, "><");
      const baseline = renderStaticBaseline(sample.md).replace(/>\s+</g, "><");
      expect(actual, sample.name).toBe(baseline);
    }

    const host = document.body.appendChild(document.createElement("div"));
    const view = createRoot(host);
    try {
      React.act(() => view.render(React.createElement(StreamdownMessageContent, {
        content: samples[3].md,
        streaming: true,
      })));
      const topLists = host.querySelectorAll('.ff-streamdown-message > ul');
      expect(topLists).toHaveLength(1);
    } finally {
      React.act(() => view.unmount());
      host.remove();
    }
  });
});
