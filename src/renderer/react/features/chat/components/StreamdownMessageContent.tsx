import React, { isValidElement, useContext, type ReactNode } from "react";
import { CodeHighlighter } from "@ant-design/x";
import { createMathPlugin } from "@streamdown/math";
import { Streamdown, defaultRehypePlugins, type Components, type ControlsConfig } from "streamdown";
import type { PluggableList } from "unified";
import { FileLinkContext, MessageStreamingContext } from "./ChatMessageList";
import { codeHighlightTheme } from "./code-highlight-theme";
import { MermaidBlock } from "./MermaidBlock";
import { SvgCardBlock } from "./SvgCardBlock";
import { parseFileLinkHref, relativePathInsideWorkspace } from "./file-link";
import { decodeStreamdownFileHref, encodeStreamdownFileLinksInHast } from "./streamdown-file-link";
import "./StreamdownMessageContent.css";

interface StreamdownMessageContentProps { content: string; streaming: boolean }

function nodeText(node: ReactNode): string {
  switch (typeof node) {
    case "string": case "number": return String(node);
    case "boolean": case "undefined": return "";
  }
  if (node === null) return "";
  if (Array.isArray(node)) return node.map(part => nodeText(part)).join("");
  if (!isValidElement<{ children?: ReactNode }>(node)) return "";
  return nodeText(node.props.children);
}

function extractCodeBlock(children: ReactNode): { code: string; lang: string } | null {
  let block: { code: string; lang: string } | null = null;
  React.Children.forEach(children, child => {
    if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
      const match = /language-([\S]+)/.exec(child.props.className ?? "");
      block = { code: nodeText(child.props.children).replace(/\n$/, ""), lang: match?.[1] ?? "" };
    }
  });
  return block;
}

function StreamdownPre({ children }: { children?: ReactNode }) {
  const streaming = useContext(MessageStreamingContext);
  const block = extractCodeBlock(children);
  if (block === null) return <pre>{children}</pre>;
  switch (block.lang) {
    case "mermaid": return <MermaidBlock streaming={streaming} code={block.code} />;
    case "svg": return <SvgCardBlock streaming={streaming} code={block.code} />;
    default: return <CodeHighlighter highlightProps={{ style: codeHighlightTheme }} prismLightMode={false} lang={block.lang || "text"}>
      {block.code}
    </CodeHighlighter>;
  }
}

function FileGlyph() {
  return <svg aria-hidden="true" height="12" width="12" viewBox="0 0 16 16" className="ff-file-link__icon">
    <path strokeLinejoin="round" stroke="currentColor" fill="none"
      d="M4 1.5h5L12.5 5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5Z" />
    <path strokeLinejoin="round" stroke="currentColor" fill="none" d="M9 1.5V5h3.5" />
  </svg>;
}

function StreamdownAnchor({ href, children }: { href?: string; children?: ReactNode }) {
  const { workspaceRoot, openFile } = useContext(FileLinkContext);
  const decoded = href ? decodeStreamdownFileHref(href) : null;
  const file = decoded ? parseFileLinkHref(decoded) : null;
  if (file) {
    const relative = workspaceRoot ? relativePathInsideWorkspace(file.absPath, workspaceRoot) : null;
    if (relative && openFile) {
      return <button onClick={() => openFile(relative, file.lineStart)} title={file.absPath} className="ff-file-link" type="button">
        <FileGlyph /><span className="ff-file-link__text">{children}</span>
      </button>;
    }
    return <span className="ff-file-link is-plain">{children}</span>;
  }
  return <a rel="noreferrer" target="_blank" href={href}>{children}</a>;
}

const mathPlugin = createMathPlugin({ singleDollarTextMath: true });
const messagePlugins = { math: mathPlugin };
const chatControls: ControlsConfig = { table: false };
const messageComponents: Components = {
  a: props => <StreamdownAnchor {...props} />, pre: props => <StreamdownPre {...props} />,
};
const rehypePlugins: PluggableList = [defaultRehypePlugins.raw, encodeStreamdownFileLinksInHast,
  defaultRehypePlugins.sanitize, defaultRehypePlugins.harden];

function stripMarkdownCode(content: string): string {
  const fences = /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?\n[ \t]{0,3}\2[ \t]*(?=\n|$)|$)/g;
  const withoutFences = content.replace(fences, "$1");
  return withoutFences.replace(/(`+)[^\n]*?\1/g, "");
}

function isEscaped(content: string, index: number): boolean {
  let count = 0;
  let cursor = index - 1;
  while (cursor >= 0 && content[cursor] === "\\") {
    count += 1;
    cursor -= 1;
  }
  return count % 2 === 1;
}

function containsRenderedMath(content: string): boolean {
  const text = stripMarkdownCode(content);
  let inlineStart = -1;
  let displayStart = -1;
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    if (text[cursor] !== "$" || isEscaped(text, cursor)) continue;
    const display = text[cursor + 1] === "$" && !isEscaped(text, cursor + 1);
    if (display) {
      if (displayStart >= 0 && text.slice(displayStart, cursor).trim()) return true;
      displayStart = cursor + 2;
      cursor += 1;
      continue;
    }
    if (inlineStart >= 0 && text.slice(inlineStart, cursor).trim()) return true;
    inlineStart = cursor + 1;
  }
  return false;
}

export function StreamdownMessageContent({ content, streaming }: StreamdownMessageContentProps) {
  const blockMode = streaming || containsRenderedMath(content);
  return <Streamdown className="ff-message-markdown ff-streamdown-message" controls={chatControls}
    rehypePlugins={rehypePlugins} components={messageComponents} plugins={messagePlugins}
    parseIncompleteMarkdown={streaming} mode={blockMode ? "streaming" : "static"}>
    {content}
  </Streamdown>;
}
