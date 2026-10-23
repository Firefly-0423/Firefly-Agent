import type { ToolDiffLine, ToolFileChange } from "../../../../shared/chat-types";

function previewText(source: string): string {
  return source.length > 200 ? source.slice(0, 200) + "…" : source;
}

export function buildReplacedDiff(
  removed: string[], inserted: string[], leading: string[] = [], trailing: string[] = [],
): ToolDiffLine[] {
  const preview: ToolDiffLine[] = [];
  const sections: [ToolDiffLine["type"], string[]][] = [
    ["context", leading], ["remove", removed], ["add", inserted], ["context", trailing],
  ];
  for (const [kind, section] of sections) {
    for (const source of section) preview.push({ type: kind, text: previewText(source) });
  }
  return preview;
}

export function buildFullFileDiff(source: string[], operation: "add" | "remove"): ToolDiffLine[] {
  return source.map(line => ({ type: operation, text: previewText(line) }));
}

export function parseUnifiedPatch(source: string): ToolDiffLine[] {
  const preview: ToolDiffLine[] = [];
  for (const line of source.split("\n")) {
    if (line.startsWith("@@")) { preview.push({ type: "hunk", text: line }); continue; }
    if (["+++", "---", "diff ", "index "].some(prefix => line.startsWith(prefix))) continue;
    const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : "context";
    preview.push({ type: kind, text: previewText(line.slice(1)) });
  }
  return preview;
}

export function finalizeFileChanges(entries: ToolFileChange[]): ToolFileChange[] {
  let consumed = 0;
  return entries.map(entry => {
    if (!entry.diff || entry.diff.length === 0) return entry;
    if (consumed >= 200) return { ...entry, diff: undefined, truncated: true };
    const allowance = Math.min(60, 200 - consumed);
    if (entry.diff.length > allowance) {
      // 保持旧预算规则：任一截断都会耗尽本批次预算。
      consumed = 200;
      return { ...entry, diff: entry.diff.slice(0, allowance), truncated: true };
    }
    consumed += entry.diff.length;
    return entry;
  });
}

export function countLines(source: string): number {
  if (!source) return 0;
  const segments = source.split("\n");
  return segments.length - (segments[segments.length - 1] === "" ? 1 : 0);
}

function acceptsChange(value: unknown): value is ToolFileChange {
  const entry = value as Partial<ToolFileChange> | null;
  return typeof entry?.file === "string" && entry.file.length > 0
    && (entry.kind === "added" || entry.kind === "modified" || entry.kind === "deleted" || entry.kind === "renamed")
    && typeof entry.insertions === "number" && typeof entry.deletions === "number";
}

export function extractFileChangesFromOutput(serialized: string | undefined): ToolFileChange[] | undefined {
  if (!serialized) return undefined;
  try {
    const payload = JSON.parse(serialized) as { changes?: unknown } | null;
    const entries = payload?.changes;
    if (Array.isArray(entries) && entries.length !== 0 && entries.every(acceptsChange)) return entries;
  } catch { return undefined; }
  return undefined;
}
