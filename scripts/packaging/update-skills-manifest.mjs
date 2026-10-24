import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readTree } from "./validate-skills.mjs";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const serialize = value => `${JSON.stringify(value, null, 2)}\n`;

export async function updateSkillsManifest(root = projectRoot) {
  const vendorRoot = path.join(root, "vendor/firefly-skills");
  const sourceRoot = path.join(vendorRoot, "skills");
  const projectSkillsRoot = path.join(root, "skills");
  const vendorFiles = (await readTree(sourceRoot)).sort();
  const projectFiles = await readTree(projectSkillsRoot);
  const skills = (await fs.readdir(sourceRoot)).sort();
  const selfSkills = (await fs.readdir(projectSkillsRoot)).sort();
  if (skills.length !== 50 || selfSkills.length !== 4
    || new Set([...skills, ...selfSkills]).size !== 54
    || [...skills, ...selfSkills].some(id => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
    || skills.some(id => !vendorFiles.includes(`${id}/SKILL.md`))
    || selfSkills.some(id => !projectFiles.includes(`${id}/SKILL.md`))) {
    throw new Error("SKILL_SOURCE_IDS_MISMATCH");
  }
  const manifestPath = path.join(vendorRoot, "skills-manifest.json");
  const previous = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const files = {};
  for (const relative of vendorFiles) {
    files[relative] = hash(await fs.readFile(path.join(sourceRoot, relative)));
  }
  const manifestText = serialize({ formatVersion: 2, skills, files, selfSkills });
  const provenancePath = path.join(vendorRoot, "license-provenance.json");
  const provenance = JSON.parse(await fs.readFile(provenancePath, "utf8"));
  const distribution = provenance.currentDistribution;
  const changed = new Set(Object.keys(distribution.changedFiles));
  for (const relative of vendorFiles) {
    if (previous.files[relative] !== files[relative]) changed.add(relative);
  }
  distribution.changedFiles = Object.fromEntries([...changed].sort()
    .filter(relative => Object.hasOwn(files, relative)).map(relative => [relative, files[relative]]));
  distribution.skillCount = skills.length;
  distribution.fileCount = vendorFiles.length;
  distribution.manifestSha256 = hash(manifestText);
  distribution.manifestSha256Scope = "SHA-256 of the current physical skills-manifest.json bytes";
  await fs.writeFile(manifestPath, manifestText);
  await fs.writeFile(provenancePath, serialize(provenance));
  return { skills: skills.length, files: vendorFiles.length, manifestSha256: hash(manifestText) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  updateSkillsManifest().then(result => console.log(`[update-skills-manifest] ${result.skills} vendor Skills; ${result.files} files; SHA-256 ${result.manifestSha256}`))
    .catch(error => { console.error(`[update-skills-manifest] ${error.message}`); process.exitCode = 1; });
}
