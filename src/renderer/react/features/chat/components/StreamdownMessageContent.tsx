import React, { createContext, isValidElement, useContext, type ReactNode } from "react";
import { CodeHighlighter } from "@ant-design/x";
import { createMathPlugin } from "@streamdown/math";
import { Streamdown, defaultRehypePlugins, parseMarkdownIntoBlocks, useIsCodeFenceIncomplete, type Components, type ControlsConfig } from "streamdown";
import type { PluggableList } from "unified";
import { FileLinkContext, MessageStreamingContext } from "./message-contexts";
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

/**
 * Set only when the whole reply is parsed as one block: the length of the reply without trailing whitespace.
 * Streamdown's fence state is per block, so in that mode it would mark every code node in the reply as unclosed; only
 * the code node that runs to the end of the reply can be the open one (a fence closed explicitly, or implicitly by
 * leaving its quote or list, ends earlier).
 */
/** Reply length without trailing whitespace, and whether a fence in it is still open. */
const WholeDocumentEndContext = createContext<{ end: number; fenceOpen: boolean } | undefined>(undefined);

// A fence may open inside block quotes or list items ("> ```mermaid", "- ```ts").
const FENCE_LINE = /^(?:[ \t]*(?:>|[-*+]|\d{1,9}[.)])[ \t]*)*[ \t]*(`{3,}|~{3,})(.*)$/;

/** True when a fence opened in `content` has no explicit closing fence (it may still be closed by leaving its container). */
export function hasUnclosedFence(content: string): boolean {
  let open: { char: string; length: number } | undefined;
  for (const line of content.split("\n")) {
    const match = FENCE_LINE.exec(line);
    if (!match) continue;
    const fence = match[1]!;
    if (!open) open = { char: fence[0]!, length: fence.length };
    else if (fence[0] === open.char && fence.length >= open.length && !match[2]!.trim()) open = undefined;
  }
  return open !== undefined;
}

type HastPosition = { end?: { offset?: number } };

function StreamdownPre({ children, node }: { children?: ReactNode; node?: { position?: HastPosition } }) {
  const blockIncomplete = useIsCodeFenceIncomplete();
  const wholeDocumentEnd = useContext(WholeDocumentEndContext);
  const end = node?.position?.end?.offset;
  const incomplete = wholeDocumentEnd === undefined || end === undefined
    ? blockIncomplete
    : (blockIncomplete || wholeDocumentEnd.fenceOpen) && end >= wholeDocumentEnd.end;
  const block = extractCodeBlock(children);
  if (block === null) return <pre>{children}</pre>;
  if (incomplete) {
    return <pre className="ff-code-plain" data-incomplete="true" data-language={block.lang || "text"}>
      <code>{block.code}</code>
    </pre>;
  }
  switch (block.lang) {
    case "mermaid": return <MermaidBlock streaming={false} code={block.code} />;
    case "svg": return <SvgCardBlock streaming={false} code={block.code} />;
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

// A definition may sit inside block quotes or list items ("> [dest]: …", "- [dest]: …"), and its destination may sit on
// the next line. Over-matching only costs whole-document parsing, so the container prefix is loose.
const REFERENCE_DEFINITION = /^(?:[ \t]*(?:>|[-*+]|\d{1,9}[.)])[ \t]*)*[ \t]*\[[^\]\n]+\]:[ \t]*(?:\n[ \t>]*)?\S/m;
const WHOLE_DOCUMENT_BLOCKS = (markdown: string): string[] => (markdown ? [markdown] : []);

function stripMarkdownCode(content: string): string {
  const fences = /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?\n[ \t]{0,3}\2[ \t]*(?=\n|$)|$)/g;
  const withoutFences = content.replace(fences, "$1");
  return withoutFences.replace(/(`+)[^\n]*?\1/g, "");
}

function hasReferenceDefinitions(content: string): boolean {
  return REFERENCE_DEFINITION.test(stripMarkdownCode(content));
}

export function StreamdownMessageContent({ content, streaming }: StreamdownMessageContentProps) {
  const wholeDocument = hasReferenceDefinitions(content);
  const blockParser = wholeDocument ? WHOLE_DOCUMENT_BLOCKS : parseMarkdownIntoBlocks;
  const documentEnd = wholeDocument ? { end: content.trimEnd().length, fenceOpen: streaming && hasUnclosedFence(content) } : undefined;
  // Keep a single streaming block tree from start through completion so finished blocks retain DOM identity;
  // per-character blurIn stays off so text renders crisply as frames reveal it.
  return <WholeDocumentEndContext.Provider value={documentEnd}><Streamdown className="ff-message-markdown ff-streamdown-message" controls={chatControls}
    rehypePlugins={rehypePlugins} components={messageComponents} plugins={messagePlugins}
    animated={false} isAnimating={streaming} parseIncompleteMarkdown={streaming}
    parseMarkdownIntoBlocksFn={blockParser} tableMaxHeight={0} mode="streaming">
    {content}
  </Streamdown></WholeDocumentEndContext.Provider>;
}
