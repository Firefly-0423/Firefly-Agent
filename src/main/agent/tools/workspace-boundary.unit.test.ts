import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertWorkspaceBoundary, assertWorkspacePathFallback } from "./workspace-boundary";
import type { ToolContext } from "../../tooling/registry/tool-context";
import type { AgentFileAccessLevel } from "../../platform/permission/permission-policy";

const live = vi.hoisted(() => ({ level: "full" as AgentFileAccessLevel }));
vi.mock("../../platform/permission/permission", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../platform/permission/permission")>(),
  getCurrentLevel: () => live.level,
}));

beforeEach(() => {
  live.level = "full";
});

describe("three-level workspace boundary check", () => {
  const ctx = (level?: AgentFileAccessLevel, extra: Partial<ToolContext> = {}): ToolContext => ({
    userQuery: "boundary",
    ...(level ? { fileAccessLevel: level } : {}),
    ...extra,
  });

  it("denies writes under read-only snapshot or live read-only level", () => {
    expect(() => assertWorkspaceBoundary("/tmp/a.txt", "write", ctx("read-only")))
      .toThrowError(expect.objectContaining({ code: "E_FILESYSTEM_READ_ONLY", category: "permission_denied" }));

    live.level = "read-only";
    expect(() => assertWorkspaceBoundary("/tmp/a.txt", "write", ctx("full")))
      .toThrowError(expect.objectContaining({ code: "E_FILESYSTEM_READ_ONLY", category: "permission_denied" }));
  });

  it("preserves unknown effectState when fallback catches read-only write denial", () => {
    expect(() => assertWorkspacePathFallback("/tmp/a.txt", "write", ctx("read-only"), "unknown"))
      .toThrowError(expect.objectContaining({ code: "E_FILESYSTEM_READ_ONLY", effectState: "unknown" }));
  });

  it("allows reads for all three levels and writes for per-action and full", () => {
    for (const level of ["read-only", "per-action", "full"] as const) {
      expect(assertWorkspaceBoundary("/tmp/a.txt", "read", ctx(level))).toBeUndefined();
    }
    for (const level of ["per-action", "full"] as const) {
      expect(assertWorkspaceBoundary("/tmp/a.txt", "write", ctx(level))).toBeUndefined();
    }
  });

  it("does not intersect live read-only for allow_all runs", () => {
    live.level = "read-only";
    expect(assertWorkspaceBoundary("/tmp/a.txt", "write", ctx("full", { permissionMode: "allow_all" }))).toBeUndefined();
  });
});
