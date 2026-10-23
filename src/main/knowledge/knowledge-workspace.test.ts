import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { registerObsidianTools, unregisterObsidianTools } from "./obsidian/obsidian-tools";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";

it("reads user-provided templates through the real bound Obsidian tool", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-templates-"));
  try {
    fs.mkdirSync(path.join(root, ".obsidian"));
    fs.mkdirSync(path.join(root, "templates"), { recursive: true });
    for (const filename of ["topic-template.md", "review-template.md", "outline-template.md"]) {
      fs.writeFileSync(path.join(root, "templates", filename), `# ${filename}

- section
`);
    }
    registerObsidianTools();
    const read = toolRegistry.getById("obsidian_read_file")!;
    for (const filename of ["topic-template.md", "review-template.md", "outline-template.md"]) {
      const relativePath = `templates/${filename}`;
      const content = fs.readFileSync(path.join(root, relativePath), "utf8");
      expect(content.trim().length).toBeGreaterThan(0);
      expect(await read.execute({ path: relativePath }, { userQuery: "read template", mode: "work", resolvedWorkspaceRoot: root })).toContain(content);
    }
  } finally {
    unregisterObsidianTools();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("references the current diagram capability in the teaching workflow", () => {
  const prompt = fs.readFileSync(path.resolve(__dirname, "../../../prompts/knowledge_workflow.md"), "utf8");
  expect(prompt).toContain("按 diagram 技能的契约");
  expect(prompt).not.toContain("firefly-diagram");
  expect(prompt).toContain("仅有 `.obsidian` 不代表用户启用了学习进度");
});
