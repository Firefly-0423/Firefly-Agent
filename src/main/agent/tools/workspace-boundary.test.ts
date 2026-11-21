import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ToolContext } from "../../tooling/registry/tool-context";
import type { ToolDefinition } from "../../tooling/registry/tool-registry";

const { registry, live } = vi.hoisted(() => ({
  registry: new Map<string, ToolDefinition>(),
  live: { level: "full" as import("../../platform/permission/permission-policy").AgentFileAccessLevel },
}));
vi.mock("../../platform/permission/permission", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../platform/permission/permission")>(),
  getCurrentLevel: () => live.level,
}));
vi.mock("../../tooling/registry/tool-registry", () => ({
  toolRegistry: { register: (tool: ToolDefinition) => registry.set(tool.id, tool) },
}));
vi.mock("electron", () => ({ app: { getPath: () => fixture, isPackaged: false, getAppPath: () => process.cwd() } }));
vi.mock("../../model/vision/vision-captioner", () => ({ captionImage: vi.fn() }));
vi.mock("./built-in-tools", () => ({ currentUserTimezone: () => "UTC" }));

import "./fs-tools";
import { registerLifeTools } from "./life-tools";
registerLifeTools();

let fixture: string;
let root: string;
let outside: string;
const context = (level: ToolContext["fileAccessLevel"]): ToolContext => ({
  userQuery: "boundary regression", resolvedWorkspaceRoot: root, fileAccessLevel: level,
});
const run = (id: string, args: Record<string, unknown>, ctx?: ToolContext) => registry.get(id)!.execute(args, ctx);
const replace = (file: string, ctx: ToolContext) => run("str_replace", {
  file_path: file, old_string: "original", new_string: "updated",
}, ctx);

beforeEach(() => {
  live.level = "full";
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-boundary-"));
  root = path.join(fixture, "project");
  outside = path.join(fixture, "project-other");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "original");
});
afterEach(() => {
  if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("native tools enforce the three-level permission boundary", () => {
  it.each(["read-only", "per-action", "full"] as const)("preserves outside reads for %s", async (level) => {
    const result = JSON.parse(await run("read_file", { path: path.join(outside, "secret.txt") }, context(level)));
    expect(result.content).toContain("original");
  });

  it.each(["per-action", "full"] as const)("preserves outside writes and replacement for %s", async (level) => {
    const file = path.join(outside, "secret.txt");
    expect(JSON.parse(await replace(file, context(level))).success).toBe(true);
    await run("write_file", { path: file, content: "tail", append: true }, context(level));
    expect(fs.readFileSync(file, "utf8")).toBe("updated\ntail");
  });

  it("tightens a full run snapshot when the live global level is downgraded to read-only", async () => {
    live.level = "read-only";
    const ctx = context("full");
    expect(JSON.parse(await run("read_file", { path: path.join(outside, "secret.txt"), workspaceRoot: outside }, ctx)).content)
      .toContain("original");
    await expect(run("write_file", { path: path.join(root, "new.txt"), content: "x" }, ctx))
      .rejects.toMatchObject({ code: "E_FILESYSTEM_READ_ONLY", category: "permission_denied" });
  });

  it("does not intersect the live level read-only for allow_all runs", async () => {
    live.level = "read-only";
    const ctx: ToolContext = { ...context("full"), permissionMode: "allow_all" };
    await run("write_file", { path: path.join(outside, "unattended.txt"), content: "ok" }, ctx);
    expect(fs.readFileSync(path.join(outside, "unattended.txt"), "utf8")).toBe("ok");
    expect(await run("read_file", { path: path.join(outside, "secret.txt"), workspaceRoot: outside }, ctx)).toBeDefined();
  });

  it("preserves write denial for read-only", async () => {
    const file = path.join(root, "note.txt");
    fs.writeFileSync(file, "original");
    await expect(run("write_file", { path: file, content: "updated" }, context("read-only"))).rejects.toMatchObject({
      code: "E_FILESYSTEM_READ_ONLY",
      category: "permission_denied",
    });
    await expect(replace(file, context("read-only"))).rejects.toMatchObject({
      code: "E_FILESYSTEM_READ_ONLY",
      category: "permission_denied",
    });
    expect(fs.readFileSync(file, "utf8")).toBe("original");
  });
});
