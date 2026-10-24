import { expect, it } from "vitest";
import { vendorSkillSource } from "../../test-utils/vendor-skill-source";
import { scanSkills } from "./skill-scanner";
import { SkillRegistry } from "./skill-registry";

it("registers all 50 distributed Skills with current mode and permission boundaries", () => {
  const registry = new SkillRegistry();
  for (const skill of scanSkills(vendorSkillSource, "user")) registry.register(skill);
  expect(registry.getAll()).toHaveLength(50);
  for (const id of ["as-api-and-interface-design", "as-context-engineering", "as-using-agent-skills"]) {
    const skill = registry.getAll().find(entry => entry.id === id);
    expect(skill?.modes).toEqual(["code"]);
    expect(skill?.tools).toBeUndefined();
    expect(skill?.effectKind).toBeUndefined();
    expect(registry.getEnabledForMode("work").some(entry => entry.id === id)).toBe(false);
  }
});

it("resolves every linked Code Skill named by the current discovery body", () => {
  const registry = new SkillRegistry();
  for (const skill of scanSkills(vendorSkillSource, "user")) registry.register(skill);
  const body = registry.getBody("as-using-agent-skills")!;
  const routedIds = [...body.matchAll(/`((?:as|ecc|sp)-[a-z-]+)`/g)].map(match => match[1]);
  expect(routedIds.length).toBeGreaterThan(20);
  for (const routedId of routedIds) {
    expect(registry.getBody(routedId), routedId).toBeTruthy();
    expect(registry.getEnabledForMode("code").some(entry => entry.id === routedId), routedId).toBe(true);
  }
});
