import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../../rag/index", () => ({ searchMemory: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => "" }, shell: { openExternal: vi.fn() } }));

import { toolRegistry } from "../../orchestrator/tools/registry/tool-registry";
import { registerObsidianTools, unregisterObsidianTools } from "./obsidian-tools";
import { policyFor } from "../../permission-policy";

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
