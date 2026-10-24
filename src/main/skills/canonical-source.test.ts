import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { scanSkills } from "./skill-scanner";
import { resolveExternalContentPaths, resolveSkillScanSources } from "../external-content-paths";

vi.mock("electron", () => ({ app: {} }));

const root = process.cwd();
const vendor = path.join(root, "vendor/firefly-skills");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function inventory(directory: string, relative = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    expect(entry.isSymbolicLink(), entry.name).toBe(false);
    const filePath = path.posix.join(relative, entry.name);
    expect(path.posix.normalize(filePath)).toBe(filePath);
    expect(filePath.startsWith("../")).toBe(false);
    if (entry.isDirectory()) Object.assign(files, inventory(directory, filePath));
    else {
      expect(entry.isFile(), filePath).toBe(true);
      files[filePath] = createHash("sha256").update(fs.readFileSync(path.join(directory, filePath))).digest("hex");
    }
  }
  return files;
}

function metadata(directory: string) {
  return scanSkills(directory, "user").map(({ dirPath, bodyPath, ...entry }) => entry)
    .sort((left, right) => left.id.localeCompare(right.id));
}

it("materializes exactly the distributed vendor tree without adding a runtime source", async () => {
  const source = path.join(vendor, "skills");
  const manifest = JSON.parse(fs.readFileSync(path.join(vendor, "skills-manifest.json"), "utf8"));
  expect(fs.existsSync(source)).toBe(true);
  expect(fs.readdirSync(source).sort()).toEqual([...manifest.skills].sort());
  expect(manifest.skills).toHaveLength(50);
  expect(fs.readdirSync(path.join(root, "skills")).sort()).toEqual([...manifest.selfSkills].sort());
  expect(manifest.selfSkills).toEqual(["diagram", "document-reader-validation", "knowledge-workspace", "plugin-development"]);
  for (const id of manifest.skills) {
    expect(manifest.selfSkills).not.toContain(id);
    expect(fs.statSync(path.join(source, id)).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(source, id, "SKILL.md")).isFile()).toBe(true);
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-canonical-test-"));
  temporaryRoots.push(temporary);
  fs.cpSync(source, path.join(temporary, "distributed"), { recursive: true });
  expect(inventory(source)).toEqual(inventory(path.join(temporary, "distributed")));
  expect(metadata(source)).toEqual(metadata(path.join(temporary, "distributed")));
  const paths = resolveExternalContentPaths({ isPackaged: false, appPath: root,
    executablePath: process.execPath, userDataPath: temporary });
  expect(resolveSkillScanSources(paths).map(entry => entry.directory)).toEqual([
    path.join(root, "skills"), path.join(temporary, "skills"),
  ]);
});
