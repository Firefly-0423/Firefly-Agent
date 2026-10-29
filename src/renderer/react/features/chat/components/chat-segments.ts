// Segmented output for Chat mode: one reply shown as a few message bubbles, the way a person sends several short
// messages. Display only; the reply itself, its copy and its history stay one message.

const MAX_SEGMENTS = 6;
/** A paragraph shorter than this ("嗯。") reads as an afterthought and stays in the bubble before it. */
const MIN_STANDALONE_CHARS = 3;

type BlockKind = "prose" | "heading" | "list" | "rich" | "continuation";
interface Block { kind: BlockKind; text: string }

const FENCE = /^\s*(`{3,}|~{3,})/;
function kindOf(first: string): BlockKind {
  if (FENCE.test(first) || /^\s*\$\$/.test(first) || /^\s*\|/.test(first) || /^\s*>/.test(first)) return "rich";
  if (/^\s*([-*+]|\d+[.)])\s/.test(first)) return "list";
  if (/^#{1,6}\s/.test(first)) return "heading";
  if (/^( {2,}|\t)/.test(first)) return "continuation";
  return "prose";
}

/** Blank-line separated blocks. A code fence or a $$ block is one block however many blank lines it holds,
 *  and an unclosed one (still streaming) runs to the end. */
function blocks(markdown: string): Block[] {
  const found: Block[] = [];
  let lines: string[] = [], fence: string | null = null;
  const flush = () => { if (lines.length) found.push({ kind: kindOf(lines[0]), text: lines.join("\n") }); lines = []; };
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence) {
      lines.push(line);
      if (fence === "$$" ? line.trim().endsWith("$$") : line.trim().startsWith(fence) && line.trim().replace(/[`~]/g, "") === "") fence = null;
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    // A fence can open right under a paragraph, with no blank line between them. Display math opens on a line
    // starting with $$ that does not also close it ("$$x = 1" opens; "$$x$$" is one line).
    const opener = FENCE.exec(line)?.[1];
    const math = line.trim();
    if (opener) fence = opener;
    else if (math.startsWith("$$") && (math === "$$" || !math.slice(2).endsWith("$$"))) fence = "$$";
    lines.push(line);
  }
  flush();
  return found;
}

const introduces = (text: string) => /[:：]\s*$/.test(text);
/** A reference or footnote definition resolves across the whole document, so such a reply is rendered whole. */
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:/m;
/** Drops blank lines and trailing space at the edges, keeping the first line's indentation (an indented code block). */
const edges = (text: string) => text.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
const visibleLength = (text: string) => text.replace(/\s/g, "").length;

/** Splits a Chat reply into bubbles: one per paragraph, with lists, tables, quotes, code and math kept whole,
 *  a heading kept with what follows it, and a sentence ending in a colon kept with the block it introduces.
 *  Earlier bubbles do not change as more of a streaming reply arrives. */
export function splitChatSegments(markdown: string): string[] {
  if (DEFINITION.test(markdown)) { const whole = edges(markdown.replace(/\r\n?/g, "\n")); return whole ? [whole] : []; }
  const segments: Block[] = [];
  for (const block of blocks(markdown)) {
    const last = segments.at(-1);
    const joins = last && (
      block.kind === "continuation"
      || last.kind === "heading"
      || block.kind === "list" && last.kind === "list"
      || (block.kind === "list" || block.kind === "rich") && introduces(last.text)
      || block.kind === "prose" && visibleLength(block.text) < MIN_STANDALONE_CHARS
      || segments.length >= MAX_SEGMENTS);
    if (last && joins) {
      // The bubble now ends with this block, which decides what may follow it.
      last.text += "\n\n" + block.text;
      if (block.kind !== "continuation") last.kind = block.kind;
    } else {
      segments.push({ ...block, kind: block.kind === "continuation" ? "prose" : block.kind });
    }
  }
  return segments.map((segment) => edges(segment.text));
}
