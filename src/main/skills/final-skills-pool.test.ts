import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { scanSkills } from "./skill-scanner";
import { buildAutoInjectedSkillContext, buildSkillCatalog } from "./skill-catalog";
import { skillRegistry } from "./skill-registry";
import { registerSkillTools } from "./skill-tools";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";

const root = path.resolve(__dirname, "../../..");
const expectedIds = ["diagram", "document-reader-validation", "knowledge-workspace", "plugin-development"];

describe("final Skills pool delivery", () => {
  it("loads specialist delegation guidance without a public legacy task contract", async () => {
    const entries = scanSkills(path.join(root, "vendor/firefly-skills/skills"), "builtin");
    const ids = ["as-doubt-driven-development", "as-using-agent-skills", "sp-dispatching-parallel-agents", "sp-requesting-code-review", "sp-subagent-driven-development", "skill-creator"];
    try {
      for (const entry of entries) skillRegistry.register(entry);
      registerSkillTools();
      for (const id of ids) {
        const text = String(await toolRegistry.getById("invoke_skill")!.execute({ skill_id: id }, { userQuery: "public delegation fixture", allowedSkillIds: new Set(ids) }));
        expect(text).toContain("delegate_agent");
        expect(text).not.toMatch(/subagent_type|task_id|`task`/);
      }
      const reference = String(await toolRegistry.getById("read_skill_reference")!.execute({ skill_id: "sp-using-superpowers", ref: "firefly-tools.md" },
        { userQuery: "public delegation reference", allowedSkillIds: new Set(["sp-using-superpowers"]) }));
      expect(reference).toContain("delegate_agent");
      expect(reference).not.toMatch(/subagent_type|task_id|`task`/);
    } finally {
      for (const entry of entries) skillRegistry.unregister(entry.id);
    }
  });
  it("loads replacement bodies and attachments through the existing Skill tools", async () => {
    const skills = scanSkills(path.join(root, "skills"), "builtin");
    try {
      for (const skill of skills) skillRegistry.register(skill);
      registerSkillTools();
      const invoke = toolRegistry.getById("invoke_skill")!;
      const read = toolRegistry.getById("read_skill_reference")!;
      const context = { userQuery: "public fixture", allowedSkillIds: new Set(expectedIds) };
      for (const id of expectedIds) {
        expect(String(await invoke.execute({ skill_id: id }, context))).toContain(`[已加载 skill: ${id}]`);
        for (const reference of skills.find(skill => skill.id === id)?.references ?? []) {
          const result = String(await read.execute({ skill_id: id, ref: reference }, context));
          const body = fs.readFileSync(path.join(root, "skills", id, "references", reference), "utf8");
          expect(result).toContain(body.trim().slice(0, 120));
        }
      }
    } finally {
      for (const skill of skills) skillRegistry.unregister(skill.id);
    }
  });

  it("discovers four explicitly selected capability Skills without executing old factories", () => {
    const skills = scanSkills(path.join(root, "skills"), "builtin");
    expect(skills.map(skill => skill.id).sort()).toEqual(expectedIds);
    expect(buildAutoInjectedSkillContext(skills)).toBe("");
    for (const skill of skills) {
      expect(buildSkillCatalog([skill])).toContain(skill.id);
      expect(skill.modes).toEqual(skill.id === "diagram" || skill.id === "plugin-development"
        ? ["work", "code"] : ["work"]);
      expect(fs.existsSync(path.join(root, "skills", skill.id, "index.ts"))).toBe(false);
      expect(fs.readFileSync(path.join(root, "skills", skill.id, "LICENSE"), "utf8").replace(/\r\n/g, "\n").trim())
        .toBe(fs.readFileSync(path.join(root, "LICENSE"), "utf8").replace(/\r\n/g, "\n").trim());
      if (skill.id === "knowledge-workspace") {
        expect(skill.tools).toEqual([
          "obsidian_list_files", "obsidian_search", "obsidian_read_file",
          "obsidian_read_section", "obsidian_edit", "obsidian_open_note",
        ]);
      }
    }
  });

  it("delivers the SDK references with their replacement owner", () => {
    const skills = scanSkills(path.join(root, "skills"), "builtin");
    for (const [id, references] of [
      ["plugin-development", ["getting-started.md", "api-spec.md", "example-walkthrough.md"]],
    ] as const) {
      expect(skills.find(skill => skill.id === id)?.references?.sort()).toEqual([...references].sort());
      for (const reference of references) {
        expect(fs.readFileSync(path.join(root, "skills", id, "references", reference), "utf8").length).toBeGreaterThan(100);
      }
    }
  });

  it("keeps persona and workflow support readable outside the Skill catalog", () => {
    expect(fs.readdirSync(path.join(root, "prompts/persona-support/references")).sort()).toEqual([
      "boundary.md", "comfort.md", "concern.md", "encourage.md", "farewell.md",
      "gratitude.md", "greeting.md", "playful.md", "praised.md",
    ]);
    const persona = fs.readFileSync(path.join(root, "prompts/persona-support/original-voice.md"), "utf8");
    expect(persona.indexOf("## 场景参考")).toBeGreaterThan(persona.indexOf("## 流萤的表达"));
    for (const relative of [
      "persona-support/original-voice.md", "persona-support/references/boundary.md",
      "workflow-support/work-hygiene.md", "workflow-support/plan-mode.md",
      "workflow-support/references/coverage-check.md", "workflow-support/references/execution-handoff.md",
      "workflow-support/references/plan-templates.md", "persona-support/LICENSE", "workflow-support/LICENSE",
    ]) {
      expect(fs.readFileSync(path.join(root, "prompts", relative), "utf8").length).toBeGreaterThan(100);
    }
  });

  it("ships the 50 canonical vendor bodies and four maintained Skills without retired mode metadata", () => {
    const vendor = path.join(root, "vendor/firefly-skills");
    const manifest = JSON.parse(fs.readFileSync(path.join(vendor, "skills-manifest.json"), "utf8"));
    expect(manifest.selfSkills).toEqual(expectedIds);
    const entries = scanSkills(path.join(vendor, "skills"), "builtin");
    expect(entries.map(skill => skill.id).sort()).toEqual([...manifest.skills].sort());
    expect(entries).toHaveLength(50);
    for (const entry of entries) {
      const relative = `${entry.id}/SKILL.md`;
      const canonical = fs.readFileSync(path.join(vendor, "skills", relative));
      expect(canonical.length).toBeGreaterThan(0);
      expect(canonical.toString("utf8")).not.toMatch(/^\s*- learn\s*$/m);
      expect(entry.modes?.length).toBeGreaterThan(0);
      expect(entry.modes?.every(mode => mode === "work" || mode === "code")).toBe(true);
    }
    expect(new Set([...entries.map(entry => entry.id), ...manifest.selfSkills]).size).toBe(54);
  });
});
