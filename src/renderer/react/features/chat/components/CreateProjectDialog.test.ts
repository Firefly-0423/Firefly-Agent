import { describe, expect, it } from "vitest";
import { projectDraftResult } from "./CreateProjectDialog";

describe("create project dialog", () => {
  it("cannot create until a source folder is chosen", () => {
    expect(projectDraftResult({ name: "旅行计划" })).toBeNull();
  });

  it("uses the typed name, trimmed", () => {
    expect(projectDraftResult({ name: "  旅行计划 ", folder: { path: "D:\\work\\trip", displayName: "trip" } }))
      .toEqual({ path: "D:\\work\\trip", displayName: "旅行计划" });
  });

  it("falls back to the folder name when no name is typed", () => {
    expect(projectDraftResult({ name: "   ", folder: { path: "D:\\work\\trip", displayName: "trip" } }))
      .toEqual({ path: "D:\\work\\trip", displayName: "trip" });
    expect(projectDraftResult({ name: "", folder: { path: "D:\\work\\trip\\" } }))
      .toEqual({ path: "D:\\work\\trip\\", displayName: "trip" });
  });

  it("caps the name at 120 characters like project rename", () => {
    const result = projectDraftResult({ name: "名".repeat(200), folder: { path: "D:\\x" } });
    expect(result?.displayName).toHaveLength(120);
  });
});
