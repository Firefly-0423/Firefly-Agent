import { describe, expect, it } from "vitest";
import * as path from "path";
import type { WorkReadScope } from "../../shared/chat-types";
import type { TranscriptEntry } from "../orchestrator/conversation-transcript-types";
import { evaluateWorkFileEvidence } from "./work-file-evidence";

const scope: WorkReadScope = {
  name: "public.txt",
  path: path.normalize("/workspace/public.txt"),
  sha256: "content-version",
  totalLines: 4,
  endLine: 4,
  partialAccepted: false,
};

function readEntries(input: {
  runId?: string;
  path?: string;
  outcome?: "success" | "failure" | "unknown" | "not_executed";
  startLine?: number;
  endLine?: number;
  sha256?: string;
} = {}): TranscriptEntry[] {
  const runId = input.runId ?? "current";
  const filePath = path.normalize(input.path ?? scope.path);
  return [
    {
      id: `${runId}-assistant`, seq: 1, at: 1, runId, kind: "assistant",
      payload: { role: "assistant", toolCalls: [{ id: `${runId}-read`, name: "read_file", arguments: JSON.stringify({ path: filePath }) }] },
    },
    {
      id: `${runId}-result`, seq: 2, at: 2, runId, kind: "tool_result",
      payload: {
        assistantEntryId: `${runId}-assistant`, toolCallId: `${runId}-read`, outcome: input.outcome ?? "success",
        message: { role: "tool", toolCallId: `${runId}-read`, name: "read_file", content: "model-facing text" },
        fileRead: {
          path: filePath, canonicalPath: filePath, sha256: input.sha256 ?? scope.sha256,
          startLine: input.startLine ?? 1, endLine: input.endLine ?? 4, totalLines: 4,
        },
      },
    },
  ];
}

function evaluate(entries: TranscriptEntry[], scopes = [scope], current = true) {
  return evaluateWorkFileEvidence({ runId: "current", scopes, entries, isCurrent: () => current });
}

describe("Work file evidence", () => {
  it("accepts only real success from the current run and exact file version", () => {
    expect(evaluate(readEntries()).status).toBe("complete");
    expect(evaluate(readEntries({ runId: "previous" })).status).toBe("missing");
    expect(evaluate([]).status).toBe("missing");
    expect(evaluate(readEntries({ path: "/workspace/other.txt" })).status).toBe("missing");
    expect(evaluate(readEntries({ sha256: "previous-version" })).status).toBe("missing");
    const unbound = readEntries();
    if (unbound[1].kind === "tool_result") unbound[1].payload.assistantEntryId = "unrelated-assistant";
    expect(evaluate(unbound).status).toBe("missing");
    expect(evaluate(readEntries(), [scope], false).status).toBe("changed");
  });

  it.each(["failure", "unknown", "not_executed"] as const)("rejects %s results", (outcome) => {
    expect(evaluate(readEntries({ outcome })).status).toBe("missing");
  });

  it("unions successful segments without filling gaps or allowing old results to overwrite success", () => {
    const first = readEntries({ endLine: 2 });
    const second = readEntries({ startLine: 4, endLine: 4 }).map((entry) => ({
      ...entry,
      id: `${entry.id}-second`,
      ...(entry.kind === "assistant" ? {
        payload: { ...entry.payload, toolCalls: [{ id: "read-second", name: "read_file", arguments: JSON.stringify({ path: scope.path }) }] },
      } : {}),
      ...(entry.kind === "tool_result" ? {
        payload: { ...entry.payload, assistantEntryId: "current-assistant-second", toolCallId: "read-second" },
      } : {}),
    })) as TranscriptEntry[];
    expect(evaluate([...first, ...second]).files[0]).toMatchObject({ status: "partial", coveredLines: 3 });
    expect(evaluate([...first, ...readEntries({ startLine: 3, endLine: 4 })]).status).toBe("complete");
    expect(evaluate([...readEntries(), ...readEntries({ outcome: "not_executed" })]).status).toBe("complete");
  });

  it("never labels an accepted smaller range as full-file completion", () => {
    expect(evaluate(readEntries({ endLine: 2 }), [{ ...scope, endLine: 2, partialAccepted: true }]).status).toBe("partial");
  });
});
