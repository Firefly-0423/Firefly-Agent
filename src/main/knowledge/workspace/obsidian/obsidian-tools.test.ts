import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../../rag/index", () => ({ searchMemory: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => "" }, shell: { openExternal: vi.fn() } }));

import { toolRegistry } from "../../../tooling/registry/tool-registry";
import { registerObsidianTools, unregisterObsidianTools } from "./obsidian-tools";
import { policyFor } from "../../../platform/permission/permission-policy";

const roots: string[] = [];
it("keeps knowledge mutations behind the existing approval policy", () => {
  registerObsidianTools();
  const edit = toolRegistry.getById("obsidian_edit")!;
  expect(policyFor("read-only", edit.risk ?? "safe")).toBe("deny");
  expect(policyFor("per-action", edit.risk ?? "safe")).toBe("ask");
});
afterEach(() => {
  unregisterObsidianTools();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("runs knowledge reads against each bound initialized Work workspace", async () => {
  registerObsidianTools();
  const read = toolRegistry.getById("obsidian_read_file")!;
  expect(read.modes).toEqual(["work"]);
  const results = await Promise.all(["first", "second"].map(async (content) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-tools-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, ".obsidian"));
    fs.writeFileSync(path.join(root, "note.md"), content);
    return read.execute({ path: "note.md" }, { userQuery: "read", mode: "work", resolvedWorkspaceRoot: root });
  }));
  expect(results[0]).toContain("first");
  expect(results[0]).not.toContain("second");
  expect(results[1]).toContain("second");
});

it("rejects uninitialized Work workspaces without creating progress", async () => {
  registerObsidianTools();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-tools-"));
  roots.push(root);
  await expect(toolRegistry.getById("obsidian_list_files")!.execute({}, {
    userQuery: "read", mode: "work", resolvedWorkspaceRoot: root,
  })).rejects.toThrow("KNOWLEDGE_WORKSPACE_REQUIRED");
  expect(fs.readdirSync(root)).toEqual([]);
});

it("edits notes through obsidian_edit: create, then replace a section with or without its children using the returned hash", async () => {
  registerObsidianTools();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-tools-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".obsidian"));
  const edit = toolRegistry.getById("obsidian_edit")!, context = { userQuery: "edit", mode: "work" as const, resolvedWorkspaceRoot: root };
  const created = await edit.execute({ operation: "create", path: "plan.md", content: "# Plan\ntop\n## Step\nchild\n" }, context) as string;
  expect(created).toContain("操作成功 [create]\n文件: plan.md\n");
  expect(fs.readFileSync(path.join(root, "plan.md"), "utf8")).toBe("# Plan\ntop\n## Step\nchild\n");
  const hash = /contentHash: (.+)$/.exec(created)![1];
  const kept = await edit.execute({ operation: "replace_section", path: "plan.md", headingPath: ["Plan"], content: "# Plan\nnew top\n", expectedContentHash: hash }, context) as string;
  expect(kept).toContain("操作成功 [replace_section]");
  expect(fs.readFileSync(path.join(root, "plan.md"), "utf8")).toBe("# Plan\nnew top\n## Step\nchild\n");
  const replaced = await edit.execute({ operation: "replace_section", path: "plan.md", headingPath: ["Plan"], content: "# Plan\nonly\n", includeChildren: true, expectedContentHash: /contentHash: (.+)$/.exec(kept)![1] }, context) as string;
  expect(replaced).toContain("操作成功 [replace_section]");
  expect(fs.readFileSync(path.join(root, "plan.md"), "utf8")).toBe("# Plan\nonly\n");
});
it("refuses obsidian_edit with a stale content hash and leaves the note unchanged", async () => {
  registerObsidianTools();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-tools-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".obsidian"));
  fs.writeFileSync(path.join(root, "note.md"), "original");
  await expect(toolRegistry.getById("obsidian_edit")!.execute({ operation: "append", path: "note.md", content: "more", expectedContentHash: "stale" },
    { userQuery: "edit", mode: "work", resolvedWorkspaceRoot: root })).rejects.toThrow("CONTENT_CONFLICT");
  expect(fs.readFileSync(path.join(root, "note.md"), "utf8")).toBe("original");
});
