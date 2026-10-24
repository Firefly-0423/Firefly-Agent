import * as path from "path";
import type { WorkReadReport, WorkReadScope } from "../../shared/chat-types";
import type { TranscriptEntry } from "../orchestrator/conversation-transcript-types";

export function evaluateWorkFileEvidence(input: {
  runId: string;
  scopes: WorkReadScope[];
  entries: TranscriptEntry[];
  isCurrent: (scope: WorkReadScope) => boolean;
}): WorkReadReport {
  const declared = new Map<string, Map<string, string>>();
  for (const entry of input.entries) {
    if (entry.kind !== "assistant" || entry.runId !== input.runId) continue;
    const calls = new Map<string, string>();
    for (const call of entry.payload.toolCalls ?? []) {
      if (call.name !== "read_file") continue;
      try {
        const args = JSON.parse(call.arguments) as Record<string, unknown>;
        if (typeof args.path === "string") calls.set(call.id, path.normalize(args.path));
      } catch {
        continue;
      }
    }
    declared.set(entry.id, calls);
  }

  const files = input.scopes.map((scope) => {
    if (!input.isCurrent(scope)) {
      return { name: scope.name, status: "changed" as const, coveredLines: 0, requiredLines: scope.endLine, totalLines: scope.totalLines };
    }
    const intervals: Array<[number, number]> = [];
    for (const entry of input.entries) {
      if (entry.kind !== "tool_result" || entry.runId !== input.runId || entry.payload.outcome !== "success") continue;
      const read = entry.payload.fileRead;
      if (!read || read.canonicalPath !== scope.path || read.sha256 !== scope.sha256
        || read.totalLines !== scope.totalLines || read.startLine < 1
        || read.endLine < read.startLine || read.endLine > read.totalLines) continue;
      const requestedPath = declared.get(entry.payload.assistantEntryId)?.get(entry.payload.toolCallId);
      if (requestedPath !== read.path) continue;
      intervals.push([read.startLine, Math.min(read.endLine, scope.endLine)]);
    }
    intervals.sort((left, right) => left[0] - right[0]);
    let coveredLines = 0;
    let coveredThrough = 0;
    for (const [start, end] of intervals) {
      if (start > end) continue;
      coveredLines += Math.max(0, end - Math.max(start, coveredThrough + 1) + 1);
      coveredThrough = Math.max(coveredThrough, end);
    }
    const status = coveredLines === 0 ? "missing" as const
      : coveredLines < scope.endLine || scope.partialAccepted ? "partial" as const : "complete" as const;
    return { name: scope.name, status, coveredLines, requiredLines: scope.endLine, totalLines: scope.totalLines };
  });
  const status = files.some((file) => file.status === "changed") ? "changed" as const
    : files.some((file) => file.status === "missing") ? "missing" as const
      : files.some((file) => file.status === "partial") ? "partial" as const : "complete" as const;
  return { status, files };
}
