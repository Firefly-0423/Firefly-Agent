import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ToolContext } from "./registry/tool-context";
import type { ToolDefinition } from "./registry/tool-registry";

const { registry, live } = vi.hoisted(() => ({
  registry: new Map<string, ToolDefinition>(),
  live: { level: "full" as import("../../permission/permission-policy").AgentFileAccessLevel },
}));
vi.mock("../../permission/permission", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../permission/permission")>(),
  getCurrentLevel: () => live.level,
}));
vi.mock("./registry/tool-registry", () => ({
  toolRegistry: { register: (tool: ToolDefinition) => registry.set(tool.id, tool) },
}));
vi.mock("electron", () => ({ app: { getPath: () => fixture, isPackaged: false, getAppPath: () => process.cwd() } }));
vi.mock("../vision-captioner", () => ({ captionImage: vi.fn() }));
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
const linkDir = (target: string, link: string) => fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");

beforeEach((test) => {
  if (process.platform === "win32" && !fs.existsSync(path.join(process.cwd(), "native", "target", "release", "firefly-workspace.exe"))) {
    const message = "Windows workspace helper missing; run npm run build:workspace-helper (FIREFLY_REQUIRE_WORKSPACE_HELPER=1 makes this a failure)";
    if (process.env.FIREFLY_REQUIRE_WORKSPACE_HELPER === "1") throw new Error(message);
    console.warn(message);
    test.skip(message);
  }
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

describe("native tools enforce the session workspace boundary", () => {
  it("rejects absolute outside reads and prefix-collision directories in project-read-only", async () => {
    const ctx = context("project-read-only");
    await expect(run("read_file", { path: path.join(outside, "secret.txt"), workspaceRoot: outside }, ctx))
      .rejects.toMatchObject({ category: "permission_denied", effectState: "not_applied" });
    await expect(run("list_dir", { path: outside }, ctx)).rejects.toMatchObject({ category: "permission_denied" });
    await expect(run("read_image", { path: path.join(outside, "secret.txt") }, ctx)).rejects.toMatchObject({ category: "permission_denied" });
  });

  it("rejects outside create, overwrite, append and replacement before any side effect in scoped", async () => {
    const file = path.join(outside, "secret.txt");
    const ctx = context("scoped");
    for (const args of [
      { path: file, content: "updated" },
      { path: file, content: "updated", append: true },
      { path: path.join(outside, "new", "startup.txt"), content: "updated" },
    ]) {
      await expect(run("write_file", args, ctx)).rejects.toMatchObject({ category: "permission_denied", effectState: "not_applied" });
    }
    await expect(replace(file, ctx)).rejects.toMatchObject({ category: "permission_denied" });
    expect(fs.readFileSync(file, "utf8")).toBe("original");
    expect(fs.existsSync(path.join(outside, "new"))).toBe(false);
  });

  it("rejects reads, replacement and missing descendants through an escaping junction", async () => {
    const readContext = context("project-read-only"), writeContext = context("scoped");
    const ordinary = path.join(root, "ordinary.txt");
    await run("write_file", { path: ordinary, content: "original" }, writeContext);
    expect(JSON.parse(await run("read_file", { path: ordinary }, readContext)).content).toContain("original");
    const link = path.join(root, "escape");
    linkDir(outside, link);
    const file = path.join(link, "secret.txt");
    const rejection = { category: "permission_denied", ...(process.platform === "win32" ? { code: "E_WORKSPACE_BOUNDARY", reason: "reparse-point" } : {}) };
    await expect(run("read_file", { path: file }, readContext)).rejects.toMatchObject(rejection);
    await expect(replace(file, writeContext)).rejects.toMatchObject(rejection);
    await expect(run("write_file", { path: "escape/new/deep/file.txt", content: "updated" }, writeContext)).rejects.toMatchObject(rejection);
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("original");
    expect(fs.existsSync(path.join(outside, "new"))).toBe(false);
  });

  it.each(["project-read-only", "scoped"] as const)("fails closed without a trusted workspace for %s", async (level) => {
    const ctx = { ...context(level), resolvedWorkspaceRoot: undefined };
    const id = level === "scoped" ? "write_file" : "read_file";
    await expect(run(id, { path: path.join(outside, "secret.txt"), content: "updated", workspaceRoot: outside }, ctx))
      .rejects.toMatchObject({ category: "permission_denied" });
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("original");
  });

  it.each(["read-only", "scoped", "per-action", "full"] as const)("preserves outside reads for %s", async (level) => {
    const result = JSON.parse(await run("read_file", { path: path.join(outside, "secret.txt") }, context(level)));
    expect(result.content).toContain("original");
  });

  it.each(["per-action", "full"] as const)("preserves outside writes and replacement for %s", async (level) => {
    const file = path.join(outside, "secret.txt");
    expect(JSON.parse(await replace(file, context(level))).success).toBe(true);
    await run("write_file", { path: file, content: "tail", append: true }, context(level));
    expect(fs.readFileSync(file, "utf8")).toBe("updated\ntail");
  });

  it("allows project reads and scoped nested creation, overwrite, append and replacement", async () => {
    const ctx = context("scoped");
    const file = path.join(root, "new", "note.txt");
    await run("write_file", { path: "new/note.txt", content: "first" }, ctx);
    await run("write_file", { path: file, content: "original" }, ctx);
    expect(JSON.parse(await run("read_file", { path: file }, context("project-read-only"))).content).toContain("original");
    expect(JSON.parse(await replace(file, ctx)).success).toBe(true);
    await run("write_file", { path: file, content: "tail", append: true }, ctx);
    expect(fs.readFileSync(file, "utf8")).toBe("updated\ntail");
    expect(await run("list_dir", { path: root }, context("project-read-only"))).toContain("new/");
  });

  it("tightens a full run snapshot when the live global level is downgraded to scoped", async () => {
    live.level = "scoped";
    const ctx = context("full");
    await expect(run("write_file", { path: path.join(outside, "secret.txt"), content: "updated" }, ctx))
      .rejects.toMatchObject({ category: "permission_denied" });
    await expect(replace(path.join(outside, "secret.txt"), ctx)).rejects.toMatchObject({ category: "permission_denied" });
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("original");
  });

  it("tightens a full run snapshot when the live global level is downgraded to project-read-only", async () => {
    live.level = "project-read-only";
    const ctx = context("full");
    await expect(run("read_file", { path: path.join(outside, "secret.txt"), workspaceRoot: outside }, ctx))
      .rejects.toMatchObject({ category: "permission_denied" });
    await expect(run("write_file", { path: path.join(root, "new.txt"), content: "x" }, ctx))
      .rejects.toMatchObject({ category: "permission_denied" });
  });

  it.each(["read-only", "project-read-only", "scoped"] as const)("does not intersect the live level %s for allow_all runs", async (level) => {
    live.level = level;
    const ctx: ToolContext = { ...context("full"), permissionMode: "allow_all" };
    await run("write_file", { path: path.join(outside, "unattended.txt"), content: "ok" }, ctx);
    expect(fs.readFileSync(path.join(outside, "unattended.txt"), "utf8")).toBe("ok");
    expect(await run("read_file", { path: path.join(outside, "secret.txt"), workspaceRoot: outside }, ctx)).toBeDefined();
  });

  it("rejects an in-workspace hard link to a file outside the workspace in restricted modes", async () => {
    const writeContext = context("scoped"), readContext = context("project-read-only");
    const ordinary = path.join(root, "ordinary.txt");
    await run("write_file", { path: ordinary, content: "original" }, writeContext);
    expect(JSON.parse(await run("read_file", { path: ordinary }, readContext)).content).toContain("original");
    const link = path.join(root, "linked.txt");
    fs.linkSync(path.join(outside, "secret.txt"), link);
    const rejection = { category: "permission_denied", ...(process.platform === "win32" ? { code: "E_WORKSPACE_BOUNDARY", reason: "hard-link" } : {}) };
    await expect(run("read_file", { path: link }, readContext)).rejects.toMatchObject(rejection);
    await expect(run("write_file", { path: link, content: "updated" }, writeContext)).rejects.toMatchObject(rejection);
    await expect(replace(link, writeContext)).rejects.toMatchObject(rejection);
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("original");
  });

  it("rejects traversal for both write_file and str_replace", async () => {
    await expect(run("write_file", { path: "../project-other/secret.txt", content: "updated" }, context("scoped"))).rejects.toThrow();
    await expect(replace(path.join(root, "..", "project-other", "secret.txt"), context("scoped")))
      .rejects.toMatchObject({ category: "permission_denied" });
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("original");
  });

  it.each(["project-read-only", "read-only"] as const)("preserves write denial for %s", async (level) => {
    const file = path.join(root, "note.txt");
    fs.writeFileSync(file, "original");
    await expect(run("write_file", { path: file, content: "updated" }, context(level))).rejects.toMatchObject({ category: "permission_denied" });
    await expect(replace(file, context(level))).rejects.toMatchObject({ category: "permission_denied" });
    expect(fs.readFileSync(file, "utf8")).toBe("original");
  });

  it("junction_rejection_requires_working_helper", async () => {
    const writeContext = context("scoped"), readContext = context("project-read-only");
    const ordinary = path.join(root, "ordinary.txt");
    await run("write_file", { path: ordinary, content: "original" }, writeContext);
    expect(JSON.parse(await run("read_file", { path: ordinary }, readContext)).content).toContain("original");
    const dir = path.join(root, "internal");
    fs.mkdirSync(dir);
    linkDir(dir, path.join(root, "alias"));
    if (process.platform === "win32") {
      const rejection = { code: "E_WORKSPACE_BOUNDARY", reason: "reparse-point" };
      await expect(run("write_file", { path: "alias/new/note.txt", content: "original" }, writeContext)).rejects.toMatchObject(rejection);
      const existing = path.join(root, "alias", "note.txt");
      fs.writeFileSync(path.join(dir, "note.txt"), "original");
      await expect(run("read_file", { path: existing }, readContext)).rejects.toMatchObject(rejection);
      await expect(replace(existing, writeContext)).rejects.toMatchObject(rejection);
      await expect(run("write_file", { path: existing, content: "tail", append: true }, writeContext)).rejects.toMatchObject(rejection);
      expect(fs.readFileSync(path.join(dir, "note.txt"), "utf8")).toBe("original");
      expect(fs.existsSync(path.join(dir, "new"))).toBe(false);
      return;
    }
    await run("write_file", { path: "alias/new/note.txt", content: "original" }, context("scoped"));
    const file = path.join(root, "alias", "new", "note.txt");
    expect(JSON.parse(await run("read_file", { path: file }, context("project-read-only"))).content).toContain("original");
    expect(JSON.parse(await replace(file, context("scoped"))).success).toBe(true);
    await run("write_file", { path: file, content: "tail", append: true }, context("scoped"));
    expect(fs.readFileSync(path.join(dir, "new", "note.txt"), "utf8")).toBe("updated\ntail");
  });

  it("rejects a junction root on Windows and canonicalizes it in the legacy fallback", async () => {
    const alias = path.join(fixture, "workspace-alias");
    const ctx = { ...context("scoped"), resolvedWorkspaceRoot: alias };
    const file = path.join(root, "note.txt");
    if (process.platform === "win32") {
      // Prove this exact root spelling/context works before turning it into a junction.
      fs.mkdirSync(alias);
      await run("write_file", { path: path.join(alias, "probe.txt"), content: "original" }, ctx);
      const readContext = { ...ctx, fileAccessLevel: "project-read-only" as const };
      expect(JSON.parse(await run("read_file", { path: path.join(alias, "probe.txt") }, readContext)).content).toContain("original");
      fs.rmSync(alias, { recursive: true });
      linkDir(root, alias);
      const rejection = { code: "E_WORKSPACE_BOUNDARY", reason: "reparse-point" };
      await expect(run("write_file", { path: path.join(alias, "note.txt"), content: "original" }, ctx)).rejects.toMatchObject(rejection);
      await expect(run("read_file", { path: path.join(alias, "note.txt") }, readContext)).rejects.toMatchObject(rejection);
      expect(fs.existsSync(file)).toBe(false);
      return;
    }
    linkDir(root, alias);
    await run("write_file", { path: file, content: "original" }, ctx);
    expect(JSON.parse(await replace(file, ctx)).success).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("updated");
  });

});
