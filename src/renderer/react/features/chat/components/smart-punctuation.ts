// 智能标点: as the user types at the end of the draft, turn plain ASCII punctuation into its typographic form.
// Only the character just typed (and the one or two before it) is considered, nothing inside `code` is touched, and
// pasting or editing in the middle of the text is left alone.

const PAIRS: Array<[string, string]> = [["--", "—"], ["...", "…"], ["->", "→"], ["<-", "←"], ["=>", "⇒"], ["<=", "≤"], [">=", "≥"], ["!=", "≠"]];

function insideCode(text: string): boolean {
  const fences = text.split("```").length - 1;
  if (fences % 2 === 1) return true;
  const fence = text.lastIndexOf("```");
  const afterFences = fence < 0 ? text : text.slice(fence + 3);
  return (afterFences.split("`").length - 1) % 2 === 1;
}

export function smartPunctuate(previous: string, next: string): string {
  // Only a single character typed at the very end.
  if (next.length !== previous.length + 1 || !next.startsWith(previous)) return next;
  const typed = next.slice(-1);
  if (insideCode(previous)) return next;
  for (const [plain, pretty] of PAIRS) {
    if (next.endsWith(plain)) return next.slice(0, -plain.length) + pretty;
  }
  if (typed === '"' || typed === "'") {
    const before = previous.slice(-1);
    const opening = !before || /[\s(\[{“‘—]/.test(before);
    const mark = typed === '"' ? (opening ? "“" : "”") : (opening ? "‘" : "’");
    return previous + mark;
  }
  return next;
}
