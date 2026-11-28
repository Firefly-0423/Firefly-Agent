export interface StrReplaceEdit { old_string: string; new_string: string; }
export interface StrReplaceFailureDiagnostic {
  kind: "not_found" | "multiple_matches";
  editIndex?: number; oldStringLength: number; fileEol: "CRLF" | "LF";
  nearestMatch?: { line: number; similarity: number; context: string } | null;
  matchCount?: number;
  positions?: Array<{ line: number; context: string }>;
}
export type StrReplaceFailure = {
  ok: false; errorCode: "INVALID_INPUT" | "OLD_STRING_NOT_FOUND" | "MULTIPLE_MATCHES";
  error: string; diagnostic?: StrReplaceFailureDiagnostic;
};
export type StrReplaceSuccess = {
  ok: true; newContent: string; eolNormalized: boolean; whitespaceNormalized: boolean;
  appliedEdits: number; segments: Array<{ beforeLines: string[]; afterLines: string[] }>;
};
export type StrReplaceResult = StrReplaceSuccess | StrReplaceFailure;

const foldLine = (value: string): string => value.replace(/\s+/g, " ").trim();
const lfText = (value: string): string => value.replace(/\r\n/g, "\n");
const indentation = (value: string): string => value.match(/^[ \t]*/)?.[0] ?? "";

function matchingRows(haystack: string[], needle: string[]): number[] {
  const starts: number[] = [];
  if (!needle.length || needle.length > haystack.length) return starts;
  for (let row = 0; row <= haystack.length - needle.length; row++) {
    if (needle.every((value, offset) => haystack[row + offset] === value)) starts.push(row);
  }
  return starts;
}

function contextFor(rows: string[], offset: number, length: number): string {
  const first = Math.max(0, offset - 2);
  return rows.slice(first, Math.min(rows.length, offset + length + 2)).map((value, index) => {
    const number = first + index + 1;
    return `${number >= offset + 1 && number <= offset + length ? ">" : " "} ${String(number).padStart(4)} | ${value}`;
  }).join("\n");
}

function similarity(left: string, right: string): number {
  if (left === right) return 1;
  if (!left || !right) return 0;
  const a = new Set(left), b = new Set(right);
  let shared = 0;
  a.forEach((letter) => { if (b.has(letter)) shared++; });
  return shared / Math.max(a.size, b.size);
}

function nearby(rows: string[], old: string): { line: number; similarity: number; context: string } | null {
  const anchor = foldLine(lfText(old).split("\n")[0] || "");
  if (!anchor) return null;
  let selected: { index: number; score: number } | undefined;
  for (let index = 0; index < rows.length; index++) {
    const score = similarity(anchor, foldLine(rows[index]));
    if (score > 0.5 && (!selected || score > selected.score)) selected = { index, score };
  }
  if (!selected) return null;
  return { line: selected.index + 1, similarity: selected.score, context: contextFor(rows, selected.index, 1) };
}

function adjustedIndent(value: string, from: string, to: string): string {
  if (from === to) return value;
  return lfText(value).split("\n").map((row) => {
    if (!row) return row;
    if (row.startsWith(from)) return to + row.slice(from.length);
    return /^[ \t]/.test(row) ? row : to + row;
  }).join("\n");
}

function oneReplacement(text: string, instruction: StrReplaceEdit, index: number | undefined): StrReplaceResult {
  const old = instruction.old_string, next = instruction.new_string;
  if (!old) {
    if (text.length !== 0) return { ok: false, errorCode: "INVALID_INPUT", error: "old_string 不能为空（文件非空）。文件为空时可传空 old_string 播种写入完整内容。" };
    return { ok: true, newContent: next, eolNormalized: false, whitespaceNormalized: false, appliedEdits: 1,
      segments: [{ beforeLines: [], afterLines: lfText(next).split("\n") }] };
  }
  const style: "CRLF" | "LF" = text.includes("\r\n") ? "CRLF" : "LF";
  const rows = text.split("\n");
  let target = old, replacement = next;
  if (style === "CRLF" && !old.includes("\r")) {
    target = old.replaceAll("\n", "\r\n");
    replacement = next.replaceAll("\n", "\r\n");
  } else if (style === "LF" && old.includes("\r\n")) {
    target = old.replaceAll("\r\n", "\n");
    replacement = next.replaceAll("\r\n", "\n");
  }
  const normalizedEol = target !== old;
  const count = text.split(target).length - 1;
  if (count === 1) return { ok: true, newContent: text.replace(target, replacement), eolNormalized: normalizedEol,
    whitespaceNormalized: false, appliedEdits: 1,
    segments: [{ beforeLines: lfText(target).split("\n"), afterLines: lfText(replacement).split("\n") }] };
  const multiple = (amount: number, positions: Array<{ line: number; context: string }>, relaxed: boolean): StrReplaceFailure => ({
    ok: false, errorCode: "MULTIPLE_MATCHES",
    error: relaxed ? `old_string 空白归一化后在文件中匹配 ${amount} 处，需要更长的上下文使其唯一。` : `old_string 在文件中匹配 ${amount} 处，需要更长的上下文使其唯一。`,
    diagnostic: { kind: "multiple_matches", editIndex: index, oldStringLength: old.length, fileEol: style, matchCount: amount, positions },
  });
  if (count > 1) {
    const width = target.split("\n").length;
    const locations: Array<{ line: number; context: string }> = [];
    for (let offset = 0; offset + width <= rows.length; offset++) {
      if (rows.slice(offset, offset + width).join("\n") !== target) continue;
      locations.push({ line: offset + 1, context: contextFor(rows, offset, width) });
      if (locations.length >= 5) break;
    }
    return multiple(count, locations, false);
  }
  const sourceRows = (style === "CRLF" ? text.replaceAll("\r\n", "\n") : text).split("\n");
  const patternRows = lfText(old).split("\n").map(foldLine);
  const hits = matchingRows(sourceRows.map(foldLine), patternRows);
  if (hits.length === 1) {
    const offset = hits[0], width = patternRows.length;
    const slice = sourceRows.slice(offset, offset + width).join("\n");
    const rewritten = adjustedIndent(next, indentation(lfText(old).split("\n")[0] || ""), indentation(sourceRows[offset] ?? ""));
    const joined = [...sourceRows.slice(0, offset), ...rewritten.split("\n"), ...sourceRows.slice(offset + width)].join("\n");
    return { ok: true, newContent: style === "CRLF" ? joined.replaceAll("\n", "\r\n") : joined,
      eolNormalized: normalizedEol, whitespaceNormalized: true, appliedEdits: 1,
      segments: [{ beforeLines: slice.split("\n"), afterLines: rewritten.split("\n") }] };
  }
  if (hits.length > 1) return multiple(hits.length, hits.slice(0, 5).map((offset) => ({
    line: offset + 1, context: contextFor(sourceRows, offset, patternRows.length),
  })), true);
  const nearest = nearby(rows, old);
  return { ok: false, errorCode: "OLD_STRING_NOT_FOUND",
    error: "old_string 在文件中未找到。已自动尝试 CRLF/LF 归一化与空白/缩进归一化仍未匹配，" + "请用 read_file 核对实际内容（缩进、空格、标点）后重试。",
    diagnostic: { kind: "not_found", editIndex: index, oldStringLength: old.length, fileEol: style,
      nearestMatch: nearest ? { line: nearest.line, similarity: nearest.similarity, context: nearest.context } : null } };
}

export function applyStrReplaceEdits(content: string, edits: StrReplaceEdit[]): StrReplaceResult {
  if (!edits.length) return { ok: false, errorCode: "INVALID_INPUT", error: "edits 不能为空数组" };
  let text = content, eol = false, whitespace = false;
  const pieces: StrReplaceSuccess["segments"] = [];
  for (let index = 0; index < edits.length; index++) {
    const applied = oneReplacement(text, edits[index], edits.length > 1 ? index : undefined);
    if (!applied.ok) return applied;
    text = applied.newContent;
    eol = eol || applied.eolNormalized;
    whitespace = whitespace || applied.whitespaceNormalized;
    pieces.push(...applied.segments);
  }
  return { ok: true, newContent: text, eolNormalized: eol, whitespaceNormalized: whitespace, appliedEdits: edits.length, segments: pieces };
}
