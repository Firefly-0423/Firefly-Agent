import { ChevronsUpDown } from "lucide-react";
import type { ToolDiffLine } from "../../../../../shared/chat-types";
import type { ReviewHunk } from "../../../../../shared/review-types";
import { useTranslation } from "../../../i18n";
import "./CodeDiff.css";

type Row =
  | { kind: "line"; type: "add" | "remove" | "context"; number?: number; text: string }
  | { kind: "gap"; count?: number };

/** Hunks with line numbers: one row per line, and the stretch of untouched lines between two hunks becomes a quiet "N unmodified lines" bar. */
function rowsFromHunks(hunks: readonly ReviewHunk[]): Row[] {
  const rows: Row[] = [];
  let nextNew = 1;
  for (const hunk of hunks) {
    const skipped = hunk.newStart - nextNew;
    if (skipped > 0) rows.push({ kind: "gap", count: skipped });
    for (const line of hunk.lines) rows.push({ kind: "line", type: line.type, number: (line.type === "remove" ? line.oldLine : line.newLine) ?? undefined, text: line.text });
    nextNew = hunk.newStart + hunk.newLines;
  }
  return rows;
}

/** Tool evidence has no line numbers; its "@@" markers still separate the changed regions. */
function rowsFromToolLines(lines: readonly ToolDiffLine[]): Row[] {
  return lines.map(line => line.type === "hunk" ? { kind: "gap" } : { kind: "line", type: line.type, text: line.text });
}

/**
 * A diff read like a code review: line number, +/− and the code, the whole line tinted green or red with a darker
 * edge on the left; long lines wrap under their own text instead of widening the panel.
 */
export function CodeDiff({ hunks, lines }: { hunks?: readonly ReviewHunk[]; lines?: readonly ToolDiffLine[] }) {
  const { t } = useTranslation();
  const rows = hunks ? rowsFromHunks(hunks) : rowsFromToolLines(lines ?? []);
  const numbered = Boolean(hunks);
  return <div className={`ff-code-diff${numbered ? "" : " ff-code-diff--plain"}`} role="table">
    {rows.map((row, index) => row.kind === "gap"
      ? <div key={index} className="ff-code-diff__gap" role="row">
          <ChevronsUpDown size={12} aria-hidden="true" />
          <span role="cell">{row.count ? t("workspace.unmodifiedLines", { count: row.count }) : "⋯"}</span>
        </div>
      : <div key={index} className={`ff-code-diff__line is-${row.type}`} role="row">
          {numbered && <span className="ff-code-diff__number" role="cell">{row.number ?? ""}</span>}
          <span className="ff-code-diff__sign" role="cell" aria-hidden="true">{row.type === "add" ? "+" : row.type === "remove" ? "−" : ""}</span>
          <span className="ff-code-diff__text" role="cell">{row.text || " "}</span>
        </div>)}
  </div>;
}
