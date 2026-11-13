import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanSkills } from "./skill-scanner";
import { SkillRegistry } from "./skill-registry";
import { parseSlashCommand } from "./skill-commands";
import { isSkillAllowedForRun } from "./skill-tools";

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-exact-skill-ids-"));
  roots.push(root);
  for (const id of ["user-diagram", "firefly-diagram", "diagram"]) {
    fs.mkdirSync(path.join(root, id));
    fs.writeFileSync(path.join(root, id, "SKILL.md"), `---\nname: ${id}\ndescription: User-owned ${id}\n---\n${id} body`);
  }
  return scanSkills(root, "user");
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("exact current Skill identities", () => {
  it("keeps user-owned IDs and bodies distinct during scan, registration and cache reads", () => {
    const skills = fixture();
    expect(skills.map(skill => skill.id).sort()).toEqual(["diagram", "firefly-diagram", "user-diagram"]);
    const registry = new SkillRegistry();
    for (const skill of skills) registry.register(skill);
    expect(registry.getAll()).toHaveLength(3);
    for (const skill of skills) expect(registry.getBody(skill.id)).toBe(`${skill.id} body`);
    registry.unregister("user-diagram");
    expect(registry.getById("firefly-diagram")).toBeDefined();
  });
  it("does not expand commands or run allowlists across distinct IDs", () => {
    expect(parseSlashCommand("/user-diagram draw", ["firefly-diagram", "diagram"])).toEqual({ hit: false });
    expect(parseSlashCommand("/user-diagram draw", ["user-diagram"])).toEqual({ hit: true, skillId: "user-diagram" });
    expect(isSkillAllowedForRun("user-diagram", new Set(["firefly-diagram"]))).toBe(false);
    expect(isSkillAllowedForRun("firefly-diagram", new Set(["diagram"]))).toBe(false);
    expect(isSkillAllowedForRun("diagram", new Set(["diagram"]))).toBe(true);
  });
  it("keeps mode overrides, enabled changes and probes scoped to one identity", () => {
    const registry = new SkillRegistry();
    for (const skill of fixture()) registry.register(skill);
    expect(registry.getEnabledForMode("work", { "user-diagram": { work: false } }).map(skill => skill.id).sort())
      .toEqual(["diagram", "firefly-diagram"]);
    registry.setEnabled("user-diagram", false);
    registry.setAvailability("user-diagram", () => false);
    expect(registry.getById("firefly-diagram")?.enabled).toBe(true);
    expect(registry.isAvailable("firefly-diagram")).toBe(true);
  });
});
