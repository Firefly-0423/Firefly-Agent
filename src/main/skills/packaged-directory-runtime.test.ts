import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
// Real SQLite / filesystem integration cases: the 5 s default is too tight on CI runners, so this file allows 30 s. Other files keep the default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import { resolveSkillScanSources } from "../storage/external-content-paths";
import { synchronizeManagedSkillDirectories } from "./directory-install";
import { scanSkills } from "./skill-scanner";

vi.mock("electron", () => ({ app: {} }));

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it("installs exactly 50 vendor directories alongside four maintained Skills without double scanning or changing enabled state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-packaged-skills-"));
  roots.push(root);
  const userSkillsDir = path.join(root, "userData", "skills");
  const enabled = path.join(root, "userData", "skills-enabled.json");
  fs.mkdirSync(path.dirname(enabled), { recursive: true });
  fs.writeFileSync(enabled, JSON.stringify({ pdf: false }));
  const repository = path.resolve(__dirname, "../../..");
  const vendorRoot = path.join(repository, "vendor", "firefly-skills");
  const manifest = JSON.parse(fs.readFileSync(path.join(vendorRoot, "skills-manifest.json"), "utf8"));
  const options = { sourceDirectory: path.join(vendorRoot, "skills"), userSkillsDir,
    expectedIds: manifest.skills, expectedFileHashes: manifest.files };
  expect(synchronizeManagedSkillDirectories(options).installed).toHaveLength(50);
  const sources = resolveSkillScanSources({
    builtinSkillDirectory: path.join(repository, "skills"),
    userSkillDirectories: [userSkillsDir],
  });
  expect(sources).toHaveLength(2);
  expect(sources.some(source => source.directory === options.sourceDirectory)).toBe(false);
  const ids = sources.flatMap(source => scanSkills(source.directory, source.source).map(skill => skill.id));
  expect(ids).toHaveLength(54);
  expect(new Set(ids).size).toBe(54);
  expect(ids.sort()).toEqual([...manifest.skills, ...manifest.selfSkills].sort());
  expect(synchronizeManagedSkillDirectories(options)).toEqual({ installed: [], updated: [], preserved: [] });
  expect(fs.readFileSync(enabled, "utf8")).toBe(JSON.stringify({ pdf: false }));
});
