import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({ root: "", builtin: "", user: "" }));
vi.mock("electron", () => ({ app: { getPath: () => ports.root } }));
vi.mock("../external-content-paths", () => ({
  getExternalContentPaths: () => ({ builtinSkillDirectory: ports.builtin, userSkillDirectories: [ports.user] }),
  resolvePackagedSkillDirectory: () => null,
  resolveSkillScanSources: () => [{ directory: ports.builtin, source: "builtin" }, { directory: ports.user, source: "user" }],
}));
import { createStorageContext } from "../storage-context";
import { initSkills, rescanSkills, setSkillEnabled, skillRegistry } from "./index";

afterEach(() => {
  for (const skill of skillRegistry.getAll()) skillRegistry.unregister(skill.id);
  if (ports.root) fs.rmSync(ports.root, { recursive: true, force: true });
});

it("loads current enabled state and preserves user Skill precedence on rescan", async () => {
  ports.root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "firefly-current-skill-startup-")));
  ports.builtin = path.join(ports.root, "builtin");
  ports.user = path.join(ports.root, "skills");
  for (const directory of [ports.builtin, ports.user]) {
    fs.mkdirSync(path.join(directory, "diagram"), { recursive: true });
  }
  fs.writeFileSync(path.join(ports.builtin, "diagram", "SKILL.md"), "---\nname: diagram\ndescription: builtin\n---\nbuiltin");
  fs.writeFileSync(path.join(ports.user, "diagram", "SKILL.md"), "---\nname: diagram\ndescription: user\n---\ncustom");
  fs.writeFileSync(path.join(ports.root, "skills-enabled.json"), JSON.stringify({ diagram: false }));
  const storage = createStorageContext({ kind: "test", applicationName: "Firefly-test", appData: ports.root, userData: ports.root,
    sessionData: path.join(ports.root, "session"), logs: path.join(ports.root, "logs"), isolationRoot: ports.root });
  expect(storage.configRoot).toBe(ports.root); // exact legacy Electron userData location
  await initSkills(storage);
  expect(skillRegistry.getAll().map(skill => skill.id)).toEqual(["diagram"]);
  expect(skillRegistry.getBody("diagram")).toBe("custom");
  expect(skillRegistry.getById("diagram")?.enabled).toBe(false);
  expect(rescanSkills()).toBe(1);
  setSkillEnabled("diagram", true);
  expect(skillRegistry.getById("diagram")?.enabled).toBe(true);
});
