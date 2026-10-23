import { describe, expect, it } from "vitest";
import {
  AgentExecutionError,
  snapshotRunExecutionStatus,
  type RunExecutionStatus,
} from "./run-execution-status";

function status(): RunExecutionStatus {
  return {
    phase: "tool_execute",
    successfulTools: [
      { capabilityId: "document.write", actionLabel: "写文档", completionClaims: ["已写入 a.docx"] },
    ],
    createdArtifacts: [{ path: "C:\\work\\a.docx", kind: "docx", capabilityId: "document.write" }],
    taskCompletionConfirmed: false,
  };
}

describe("snapshotRunExecutionStatus", () => {
  it("copies every field and keeps empty collections empty", () => {
    const source = status();
    const snapshot = snapshotRunExecutionStatus(source);
    expect(snapshot).toEqual(source);
    expect(snapshot).not.toBe(source);
    expect(snapshot.successfulTools[0]).not.toBe(source.successfulTools[0]);
    expect(snapshot.createdArtifacts[0]).not.toBe(source.createdArtifacts[0]);

    const empty = snapshotRunExecutionStatus({
      phase: "unknown",
      successfulTools: [],
      createdArtifacts: [],
      taskCompletionConfirmed: true,
    });
    expect(empty).toEqual({
      phase: "unknown",
      successfulTools: [],
      createdArtifacts: [],
      taskCompletionConfirmed: true,
    });
  });

  it("deep-copies mutable arrays so later source changes cannot leak into the snapshot", () => {
    const source = status();
    const snapshot = snapshotRunExecutionStatus(source);

    source.successfulTools[0].completionClaims.push("mutated");
    source.successfulTools.push({ capabilityId: "x", actionLabel: "x", completionClaims: [] });
    source.createdArtifacts[0].path = "mutated.docx";
    source.phase = "soul";

    expect(snapshot.successfulTools).toHaveLength(1);
    expect(snapshot.successfulTools[0].completionClaims).toEqual(["已写入 a.docx"]);
    expect(snapshot.createdArtifacts[0].path).toBe("C:\\work\\a.docx");
    expect(snapshot.phase).toBe("tool_execute");
  });

  it("does not let callers mutate the source through the snapshot", () => {
    const source = status();
    const snapshot = snapshotRunExecutionStatus(source);
    snapshot.successfulTools[0].completionClaims.push("snapshot-only");
    snapshot.createdArtifacts[0].kind = "pdf";
    expect(source.successfulTools[0].completionClaims).toEqual(["已写入 a.docx"]);
    expect(source.createdArtifacts[0].kind).toBe("docx");
  });
});

describe("AgentExecutionError", () => {
  it("carries the execution status, name and message", () => {
    const executionStatus = status();
    const error = new AgentExecutionError("run failed", executionStatus);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AgentExecutionError);
    expect(error.name).toBe("AgentExecutionError");
    expect(error.message).toBe("run failed");
    expect(error.executionStatus).toBe(executionStatus);
  });

  it("preserves the original cause", () => {
    const cause = new Error("socket closed");
    const error = new AgentExecutionError("run failed", status(), { cause });
    expect(error.cause).toBe(cause);
  });
});
