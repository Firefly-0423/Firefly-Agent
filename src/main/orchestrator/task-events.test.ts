import { it, expect, describe } from "vitest";
import { projectTaskTraceEvent as project } from "./task-events";

describe("Private task trace projection", () => {
  it("emits public tool identity without arguments or credentials", () => {
    const trace = project({ type: "tool_start", toolName: "read_file", toolCallId: "agenda-read", args: { path: "D:/confidential/agenda.md", token: "credential-canary" } }, 420, () => "trace-agenda");
    expect(trace).toStrictEqual({ id: "trace-agenda", at: 420, kind: "tool", phase: "start", label: "read_file" });
    expect(JSON.stringify(trace)).not.toContain("confidential");
    expect(JSON.stringify(trace)).not.toContain("token");
  });

  it("bounds progress while retaining the terminal error payload", () => {
    expect(project({ type: "error", message: "Calendar service disconnected" }, 840, () => "trace-failed")).toStrictEqual({
      at: 840, id: "trace-failed", kind: "terminal", status: "error", content: "Calendar service disconnected",
    });
    expect(project({ type: "progress_text", content: "p".repeat(2_240) }, 630, () => "trace-progress")).toMatchObject({ kind: "progress", content: "p".repeat(2_000) + "…" });
    expect(project({ type: "progress_text", content: "p".repeat(2_000) }, 630)).toMatchObject({ content: "p".repeat(2_000) });
  });

  it("does not turn user questions into child trace records", () => {
    expect(project({ type: "ask_user", card: {} }, 21, () => "unused-id")).toBeUndefined();
  });
});
