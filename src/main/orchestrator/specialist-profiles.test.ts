import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { SkillRegistry } from "../skills/skill-registry";
import { scanSkills } from "../skills/skill-scanner";
import { TASK_CHARACTERS } from "../../shared/task-characters";
import { createSpecialistProfiles, buildSkillOwnership } from "./specialist-profiles";
import { resolveAgentCapabilities } from "./agent-capabilities";

const root = path.resolve(__dirname, "../../..");
const skills = [
  ...scanSkills(path.join(root, "skills"), "builtin"),
  ...scanSkills(path.join(root, "vendor/firefly-skills/skills"), "builtin"),
];
const expected = {
  "strategy-planning": "艾利欧", architecture: "姬子", implementation: "刃",
  research: "大黑塔", knowledge: "丹恒", review: "瓦尔特",
  "security-governance": "星期日", "ui-visual": "三月七", "documents-data": "知更鸟",
  "tooling-skills": "银狼", "ops-release": "帕姆", "coordination-debug": "卡芙卡",
};

describe("production specialist profiles", () => {
  it("routes the approved twelve identities without replacing existing portraits", () => {
    const profiles = createSpecialistProfiles("work", [], skills);
    expect(Object.fromEntries(profiles.map(profile => [profile.id, profile.nickname]))).toEqual(expected);
    expect(new Set(profiles.map(profile => profile.nickname)).size).toBe(12);
    for (const profile of profiles) {
      expect(TASK_CHARACTERS.find(character => character.nickname === profile.nickname)).toBeDefined();
      expect(profile.role.length).toBeGreaterThan(0);
      expect(profile.description.length).toBeGreaterThan(0);
      expect(profile.persistent).toBe(true);
      expect(profile.maxConcurrency).toBe(1);
    }
  });

  it("assigns every distributed Skill exactly once and derives profile Skills from ownership", () => {
    const matrix = buildSkillOwnership(skills);
    expect(matrix).toHaveLength(54);
    expect(new Set(matrix.map(entry => entry.skillId)).size).toBe(54);
    expect(matrix.map(entry => entry.skillId).sort()).toEqual(skills.map(skill => skill.id).sort());
    for (const entry of matrix) {
      expect(Object.keys(expected)).toContain(entry.primaryAgent);
      for (const shared of entry.sharedAgents) expect(Object.keys(expected)).toContain(shared);
      const source = skills.find(skill => skill.id === entry.skillId)!;
      expect(entry.supportedModes).toEqual(source.modes);
      expect(entry.effectKind).toBe(source.effectKind ?? "unknown");
      expect(entry.tools).toEqual(source.tools ?? []);
    }
    for (const profile of createSpecialistProfiles("work", [], skills)) {
      expect([...profile.allowedSkillIds].sort()).toEqual(matrix.filter(entry =>
        entry.primaryAgent === profile.id || entry.sharedAgents.includes(profile.id)
      ).map(entry => entry.skillId).sort());
    }
  });

  it("never delegates in Chat and restricts Code to development-related profiles", () => {
    expect(createSpecialistProfiles("chat", [], skills)).toEqual([]);
    expect(createSpecialistProfiles("work", [], skills)).toHaveLength(12);
    expect(createSpecialistProfiles("code", [], skills).map(profile => profile.id)).toEqual([
      "strategy-planning", "architecture", "implementation", "research", "knowledge", "review",
      "security-governance", "ui-visual", "tooling-skills", "ops-release", "coordination-debug",
    ]);
  });

  it("only intersects parent tools and blocks nested delegation and interactive authority", () => {
    const tools = ["read_file", "task", "delegate_agent", "ask_user", "ask_user_choice", "confirm_uncertain_effect"]
      .map(id => ({ id, name: id, description: id, enabled: true,
        inputSchema: { type: "object", properties: {} }, effectKind: "read" as const,
        execute: async () => "public fixture" }));
    for (const profile of createSpecialistProfiles("work", tools, skills)) {
      expect(profile.allowedToolIds).toEqual(["read_file"]);
      expect(resolveAgentCapabilities(profile, "work", tools, skills).tools.map(tool => tool.id)).toEqual(["read_file"]);
    }
  });
});

const roleAlignedOwnership = {
  "ac-documentation-writer": "knowledge",
  "ac-prd": "strategy-planning",
  "as-api-and-interface-design": "architecture",
  "as-code-review-and-quality": "review",
  "as-code-simplification": "implementation",
  "as-context-engineering": "knowledge",
  "as-debugging-and-error-recovery": "tooling-skills",
  "as-deprecation-and-migration": "implementation",
  "as-doubt-driven-development": "research",
  "as-frontend-ui-engineering": "ui-visual",
  "as-git-workflow-and-versioning": "ops-release",
  "as-incremental-implementation": "implementation",
  "as-planning-and-task-breakdown": "strategy-planning",
  "as-security-and-hardening": "security-governance",
  "as-source-driven-development": "research",
  "as-spec-driven-development": "architecture",
  "as-using-agent-skills": "tooling-skills",
  "diagram": "ui-visual",
  "document-reader-validation": "documents-data",
  "docx": "documents-data",
  "ecc-agent-introspection-debugging": "tooling-skills",
  "ecc-agent-security-hardening": "security-governance",
  "ecc-ai-regression-testing": "review",
  "ecc-code-tour": "knowledge",
  "ecc-codebase-onboarding": "knowledge",
  "ecc-coding-standards": "security-governance",
  "ecc-plan-canvas": "strategy-planning",
  "ecc-production-audit": "ops-release",
  "ecc-security-review": "security-governance",
  "ecc-tdd-workflow": "implementation",
  "frontend-design": "ui-visual",
  "knowledge-workspace": "knowledge",
  "pdf": "documents-data",
  "plugin-development": "tooling-skills",
  "pptx-generator": "documents-data",
  "self-improving-agent": "knowledge",
  "skill-creator": "tooling-skills",
  "sp-brainstorming": "research",
  "sp-dispatching-parallel-agents": "coordination-debug",
  "sp-receiving-code-review": "review",
  "sp-requesting-code-review": "review",
  "sp-subagent-driven-development": "coordination-debug",
  "sp-systematic-debugging": "tooling-skills",
  "sp-using-git-worktrees": "ops-release",
  "sp-using-superpowers": "tooling-skills",
  "sp-verification-before-completion": "review",
  "sp-writing-plans": "strategy-planning",
  "tob-property-based-testing": "implementation",
  "ws-accessibility-compliance": "ui-visual",
  "ws-architecture-decision-records": "architecture",
  "ws-data-storytelling": "documents-data",
  "ws-error-handling-patterns": "implementation",
  "ws-stride-analysis-patterns": "security-governance",
  "xlsx": "documents-data"
} as const;

describe("role-aligned complete Skill allocation", () => {
  it("matches all 54 unique primary owners across the twelve roles", () => {
    const ownership = buildSkillOwnership(skills);
    expect(Object.fromEntries(ownership.map(row => [row.skillId, row.primaryAgent]))).toEqual(roleAlignedOwnership);
    expect(new Set(ownership.map(row => row.primaryAgent)).size).toBe(12);
    for (const row of ownership) {
      expect(row.sharedAgents).not.toContain(row.primaryAgent);
      expect(new Set(row.sharedAgents).size).toBe(row.sharedAgents.length);
    }
  });
  it("shares document generation with the visual specialist", () => {
    const ownership = buildSkillOwnership(skills);
    expect(ownership.find(row => row.skillId === "pptx-generator")).toMatchObject({ primaryAgent: "documents-data", sharedAgents: expect.arrayContaining(["ui-visual"]) });
  });
  it("shares common protocols without enabling delegation or changing Skill modes", () => {
    const ownership = buildSkillOwnership(skills);
    for (const row of ownership.filter(row => row.globalProtocol)) expect(row.sharedAgents).toHaveLength(11);
    const registry = new SkillRegistry();
    for (const skill of skills) registry.register(skill);
    const parentSkills = registry.getEnabledForMode("code");
    const profiles = createSpecialistProfiles("code", [], parentSkills);
    const ops = profiles.find(profile => profile.id === "ops-release")!;
    expect(resolveAgentCapabilities(ops, "code", [], parentSkills).skills.every(skill => skill.modes?.includes("code"))).toBe(true);
  });
});
