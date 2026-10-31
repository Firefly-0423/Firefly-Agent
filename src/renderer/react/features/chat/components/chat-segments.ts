// Segmented output for Chat mode: one reply shown as a few message bubbles, the way a person sends several short
// messages. Display only; the reply itself, its copy and its history stay one message.

const MAX_SEGMENTS = 6;
/** A paragraph shorter than this ("嗯。") reads as an afterthought and stays in the bubble before it. */
const MIN_STANDALONE_CHARS = 3;

type BlockKind = "prose" | "heading" | "list" | "rich" | "continuation";
interface Block { kind: BlockKind; text: string }

const FENCE = /^\s*(`{3,}|~{3,})/;
function kindOf(first: string): BlockKind {
  // Indentation first: an indented fence, table or quote belongs to the list item above it.
  if (/^( {2,}|\t)/.test(first)) return "continuation";
  if (FENCE.test(first) || /^\s*\$\$/.test(first) || /^\s*\|/.test(first) || /^\s*>/.test(first)) return "rich";
  if (/^\s*([-*+]|\d+[.)])\s/.test(first)) return "list";
  if (/^#{1,6}\s/.test(first)) return "heading";
  return "prose";
}

/** An open code fence: its marker ("```", "~~~~") and indentation, or display math. */
type OpenFence = { marker: string; indent: number } | "math";

/** Indentation width, a tab counting as four spaces. */
const width = (indent: string) => indent.replace(/\t/g, "    ").length;

/** A line that closes `fence`: the same character, at least as long, nothing after it, and indented at most three
 *  spaces more than the opener, so a deeper fence-like line is code content, not the end. */
function closes(fence: Exclude<OpenFence, "math">, line: string): boolean {
  const match = /^([ \t]*)(`{3,}|~{3,})\s*$/.exec(line);
  return !!match && match[2][0] === fence.marker[0] && match[2].length >= fence.marker.length && width(match[1]) <= fence.indent + 3;
}

/** Blank-line separated blocks. A code fence or a $$ block is one block however many blank lines it holds,
 *  and an unclosed one (still streaming) runs to the end. */
function blocks(markdown: string): Block[] {
  const found: Block[] = [];
  let lines: string[] = [], fence: OpenFence | null = null;
  const flush = () => { if (lines.length) found.push({ kind: kindOf(lines[0]), text: lines.join("\n") }); lines = []; };
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence) {
      lines.push(line);
      if (fence === "math" ? line.trim().endsWith("$$") : closes(fence, line)) fence = null;
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    // A fence can open right under a paragraph, with no blank line between them. Display math opens on a line
    // starting with $$ that does not also close it ("$$x = 1" opens; "$$x$$" is one line).
    const opener = /^([ \t]*)(`{3,}|~{3,})/.exec(line);
    const math = line.trim();
    if (opener) fence = { marker: opener[2], indent: width(opener[1]) };
    else if (math.startsWith("$$") && (math === "$$" || !math.slice(2).endsWith("$$"))) fence = "math";
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
