import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../../platform/permission/permission", () => ({ getCurrentLevel: () => "full" }));
vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }));
import { createWorkspaceHandleBridge, workspaceHelperPath } from "./workspace-handle";
import type { ToolContext } from "../../tooling/registry/tool-context";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-native-integration-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const context = (level: ToolContext["fileAccessLevel"]): ToolContext => ({
  userQuery: "three-level",
  resolvedWorkspaceRoot: root,
  fileAccessLevel: level,
});

it("does not route read-only, per-action, or full through the workspace helper", async () => {
  const b = createWorkspaceHandleBridge();
  const file = path.join(root, "file.txt");
  fs.writeFileSync(file, "original");
  for (const level of ["read-only", "per-action", "full"] as const) {
    expect(await b.readFile(file, context(level), 100)).toBeUndefined();
  }
  await expect(b.withWrite(file, context("read-only"), false, async () => "unreachable"))
    .rejects.toMatchObject({ code: "E_FILESYSTEM_READ_ONLY", category: "permission_denied" });
  expect(await b.withWrite(file, context("per-action"), false, async lease => lease ?? "direct")).toBe("direct");
  expect(await b.withWrite(file, context("full"), false, async lease => lease ?? "direct")).toBe("direct");
});

it("resolves the packaged resources/bin helper path without using an asar path", () => {
  const resources = path.join(root, "resources");
  const binary = workspaceHelperPath({ isPackaged: true, getAppPath: () => { throw Error("asar must not be used"); } }, resources);
  expect(binary).toBe(path.join(resources, "bin", "firefly-workspace.exe"));
});
