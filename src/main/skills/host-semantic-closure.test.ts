import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { copyVendorSkills } from "../../test-utils/vendor-skill-source";
import { scanSkills } from "./skill-scanner";
import { skillRegistry } from "./skill-registry";
import { registerSkillTools } from "./skill-tools";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import { registerDocumentTools } from "../orchestrator/tools/document-tools";
import { registerLifeTools } from "../orchestrator/tools/life-tools";

const mappings: Record<string, string[]> = {
  "as-code-review-and-quality": ["as-security-and-hardening"],
  "as-debugging-and-error-recovery": ["ecc-tdd-workflow"],
  "as-doubt-driven-development": ["as-code-review-and-quality", "as-debugging-and-error-recovery", "as-source-driven-development"],
  "as-git-workflow-and-versioning": ["as-api-and-interface-design", "as-code-review-and-quality"],
  "as-incremental-implementation": ["as-git-workflow-and-versioning", "ecc-tdd-workflow", "sp-verification-before-completion"],
  "as-planning-and-task-breakdown": ["sp-verification-before-completion"],
  "as-source-driven-development": ["as-security-and-hardening"],
  "ecc-agent-introspection-debugging": ["self-improving-agent", "sp-verification-before-completion"],
  "ecc-code-tour": ["ecc-codebase-onboarding", "ecc-coding-standards"],
  "ecc-coding-standards": ["as-api-and-interface-design", "as-frontend-ui-engineering"],
  "skill-creator": ["docx", "xlsx"],
  "sp-using-superpowers": ["sp-brainstorming", "sp-systematic-debugging"],
  "sp-systematic-debugging": ["ecc-tdd-workflow", "sp-verification-before-completion"],
  "sp-writing-plans": ["ecc-tdd-workflow", "sp-subagent-driven-development", "sp-using-git-worktrees"],
  "sp-brainstorming": ["sp-writing-plans"],
  "as-spec-driven-development": ["as-planning-and-task-breakdown", "as-incremental-implementation", "ecc-tdd-workflow", "as-context-engineering"],
};

let root: string | undefined;
let ids: string[] = [];

afterEach(() => {
  for (const id of ids) skillRegistry.unregister(id);
  ids = [];
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

it("resolves required cross-Skill calls when each Skill is invoked directly", async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-host-semantics-"));
  copyVendorSkills(root);
  const skills = scanSkills(root, "builtin");
  ids = skills.map(skill => skill.id);
  expect(skills).toHaveLength(50);
  for (const skill of skills) skillRegistry.register(skill);
  registerSkillTools();
  registerDocumentTools();
  registerLifeTools();
  const invoke = toolRegistry.getById("invoke_skill")!;
  const read = toolRegistry.getById("read_skill_reference")!;
  const allowedSkillIds = new Set(ids);
  const continuationPages = new Map<string, string>();
  const discoveredIds = ids.filter(id => id !== "as-using-agent-skills" && skillRegistry.getBody("as-using-agent-skills")!.includes(id));
  const allMappings = { ...mappings, "as-using-agent-skills": discoveredIds };
  for (const source of ids) {
    const targets = allMappings[source] ?? [];
    const result = String(await invoke.execute({ skill_id: source }, { userQuery: "public fixture", allowedSkillIds }));
    expect(result).toContain(`[已加载 skill: ${source}]`);
    const sourceSkill = skillRegistry.getById(source)!;
    for (const target of targets) {
      const targetSkill = skillRegistry.getById(target);
      expect(targetSkill, `${source} → ${target}`).toBeDefined();
      for (const mode of sourceSkill.modes ?? ["work", "code"] as const) {
        expect(skillRegistry.getEnabledForMode(mode).some(skill => skill.id === target), `${source} → ${target} in ${mode}`).toBe(true);
      }
      if (!result.includes(target)) {
        const body = skillRegistry.getBody(source)!;
        const offset = Math.floor(body.indexOf(target) / 8000) * 8000;
        expect(offset, `${source} → ${target} not present`).toBeGreaterThanOrEqual(0);
        const pageKey = `${source}/${offset}`;
        let continuation = continuationPages.get(pageKey);
        if (!continuation) {
          continuation = String(await read.execute({ skill_id: source, source: "body", ref: "SKILL.md", offset }, { userQuery: "public fixture", allowedSkillIds }));
          continuationPages.set(pageKey, continuation);
        }
        expect(continuation, `${source} → ${target} unavailable after direct invoke`).toContain(target);
      }
    }
  }
  const docx = skillRegistry.getBody("docx")!;
  expect(docx).toContain("write_word");
  expect(docx).not.toContain("ask_user_choice");
  expect(skillRegistry.getBody("xlsx")).toContain("xlsx_workspace.py create");
  expect(skillRegistry.getBody("xlsx")).not.toContain("Join-Path $env:TEMP 'firefly-xlsx-work'");
  for (const id of ["write_word", "write_excel", "write_pdf"] as const) {
    expect(toolRegistry.getById(id)?.modes).toEqual(["work"]);
    expect(toolRegistry.getById(id)?.effectKind).toBe("mutation");
  }
  expect(toolRegistry.getById("query_expense")?.modes).toEqual(["work"]);
  expect(toolRegistry.getById("query_expense")?.effectKind).toBe("read");
  expect(toolRegistry.getById("write_pptx")).toBeUndefined();
  expect(toolRegistry.getById("ask_user_choice")).toBeUndefined();
  const builtin = skillRegistry.getById("sp-writing-plans")!;
  const userBody = path.join(root, "user-writing-plans.md");
  fs.writeFileSync(userBody, "---\nname: sp-writing-plans\ndescription: custom public fixture\n---\nUser supplied plan instructions");
  skillRegistry.register({ ...builtin, source: "user", bodyPath: userBody });
  const userResult = String(await invoke.execute({ skill_id: "sp-writing-plans" }, { userQuery: "public fixture", allowedSkillIds }));
  expect(userResult).toContain("User supplied plan instructions");
  expect(userResult).not.toContain("Firefly execution uses");
});

it("keeps inherited workflow examples aligned with bundled Firefly commands", () => {
  const root = path.resolve("vendor/firefly-skills/skills");
  const planning = fs.readFileSync(path.join(root, "as-planning-and-task-breakdown/SKILL.md"), "utf8");
  const recovery = fs.readFileSync(path.join(root, "ecc-agent-introspection-debugging/SKILL.md"), "utf8");
  const docx = fs.readFileSync(path.join(root, "docx/SKILL.md"), "utf8");
  const project = fs.readFileSync(path.join(root, "docx/scripts/dotnet/MiniMaxAIDocx.Core/MiniMaxAIDocx.Core.csproj"), "utf8");
  expect(planning).toContain("upstream convention");
  expect(planning).not.toContain("expected by the `/build` command");
  expect(recovery).not.toContain("workspace-surface-audit");
  expect(docx).toContain("未注册 `run-script` 命令");
  expect(docx).not.toContain("-- run-script");
  expect(project).toContain('PackageReference Include="DocumentFormat.OpenXml" Version="3.5.1"');
  expect(docx).toContain("3.5.1");
});
