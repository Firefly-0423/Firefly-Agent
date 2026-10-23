import type { CSSProperties } from "react";

/**
 * Prism token colours in the shape react-syntax-highlighter expects. Each colour reads a --ff-code-* variable that
 * ui/appearance-prefs.ts sets from the code theme chosen for the current light or dark theme, so a new choice or a
 * theme switch repaints code blocks without re-rendering them. The block surface is painted by the container, so
 * both backgrounds stay transparent.
 */
const v = (name: string) => `var(--ff-code-${name})`;

const base: CSSProperties = {
  color: v("text"),
  background: "transparent",
  textShadow: "none",
  fontFamily: 'Consolas, "Cascadia Code", "Cascadia Mono", monospace',
  fontSize: "13px",
  lineHeight: 1.7,
  textAlign: "left",
  whiteSpace: "pre",
  wordSpacing: "normal",
  wordBreak: "normal",
  tabSize: 2,
};

export const codeHighlightTheme: Record<string, CSSProperties> = {
  'code[class*="language-"]': base,
  'pre[class*="language-"]': { ...base, margin: 0, padding: "12px 14px", overflow: "auto" },
  comment: { color: v("comment"), fontStyle: "italic" },
  prolog: { color: v("comment") },
  doctype: { color: v("comment") },
  cdata: { color: v("comment") },
  punctuation: { color: v("punctuation") },
  namespace: { opacity: 0.7 },
  property: { color: v("property") },
  tag: { color: v("tag") },
  boolean: { color: v("number") },
  number: { color: v("number") },
  constant: { color: v("number") },
  symbol: { color: v("number") },
  deleted: { color: v("deleted") },
  selector: { color: v("string") },
  "attr-name": { color: v("type") },
  string: { color: v("string") },
  char: { color: v("string") },
  builtin: { color: v("type") },
  inserted: { color: v("inserted") },
  operator: { color: v("punctuation") },
  entity: { color: v("function"), cursor: "help" },
  url: { color: v("function") },
  variable: { color: v("text") },
  atrule: { color: v("keyword") },
  "attr-value": { color: v("string") },
  function: { color: v("function") },
  "class-name": { color: v("type") },
  keyword: { color: v("keyword") },
  regex: { color: v("tag") },
  important: { color: v("tag"), fontWeight: "bold" },
  bold: { fontWeight: "bold" },
  italic: { fontStyle: "italic" },
};
