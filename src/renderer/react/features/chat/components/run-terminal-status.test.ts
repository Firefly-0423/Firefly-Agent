import { it, expect, describe } from "vitest";
import { resolveTerminalContent, resolveRunFinishedStage } from "./run-presentation";

describe("Finished run display contract", () => {
  it.each(["success", "cancelled", "timeout"])("keeps only actual answer text for %s", (status) => {
    for (const blank of ["", "   ", "\t\n"]) expect(resolveTerminalContent(blank, status)).toBe("");
    expect(resolveTerminalContent("流萤正在整理资料", status)).toBe("流萤正在整理资料");
    expect(resolveTerminalContent("  draft response\n", status)).toBe("draft response");
  });
  it("accepts legacy results and successful completion", () => {
    for (const payload of [undefined, {}, null, { status: "success" }])
      expect(resolveRunFinishedStage(payload)).toStrictEqual({ kind: "completed" });
  });
  it.each([["runtime_error", "failed"], ["timeout", "timeout"], ["cancelled", "cancelled"]])(
    "shows %s as %s without claiming completion", (status, kind) => {
      const presentation = resolveRunFinishedStage({ status });
      expect(presentation).toStrictEqual({ kind });
      expect(presentation.kind).not.toEqual("completed");
    });
});
