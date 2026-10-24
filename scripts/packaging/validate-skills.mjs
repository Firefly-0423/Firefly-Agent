import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

function assertName(name) {
  if (!name || name === "." || name === ".." || /[\\/:*?"<>|\x00-\x1f]/.test(name)
    || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error("SKILL_DIRECTORY_PATH_INVALID");
  }
}

export async function readTree(root) {
  const info = await fs.lstat(root);
  if (info.isSymbolicLink()) throw new Error("SKILL_DIRECTORY_LINK");
  if (!info.isDirectory()) throw new Error("SKILL_DIRECTORY_NOT_DIRECTORY");
  const files = [];
  const seen = new Set();
  async function visit(directory, prefix) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      assertName(entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const key = relative.toLowerCase();
      if (seen.has(key)) throw new Error("SKILL_DIRECTORY_DUPLICATE_PATH");
      seen.add(key);
      const location = path.join(directory, entry.name);
      const info = await fs.lstat(location);
      if (info.isSymbolicLink()) throw new Error("SKILL_DIRECTORY_LINK");
      if (info.isDirectory()) await visit(location, relative);
      else if (info.isFile()) files.push(relative);
      else throw new Error("SKILL_DIRECTORY_NOT_FILE");
    }
  }
  await visit(root, "");
  return files;
}

export async function validateSkills(root = projectRoot) {
  const vendorRoot = path.join(root, "vendor", "firefly-skills");
  const manifest = JSON.parse(await fs.readFile(path.join(vendorRoot, "skills-manifest.json"), "utf8"));
  if (manifest.formatVersion !== 2 || !Array.isArray(manifest.skills) || manifest.skills.length !== 50
    || !Array.isArray(manifest.selfSkills) || manifest.selfSkills.length !== 4) throw new Error("SKILL_MANIFEST_INVALID");
  const ids = [...manifest.skills, ...manifest.selfSkills];
  if (new Set(ids).size !== 54 || ids.some(id => typeof id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) {
    throw new Error("SKILL_MANIFEST_IDS_INVALID");
  }
  const vendor = path.join(vendorRoot, "skills");
  const project = path.join(root, "skills");
  const vendorEntries = await fs.readdir(vendor);
  const projectEntries = await fs.readdir(project);
  if (JSON.stringify(vendorEntries.sort()) !== JSON.stringify([...manifest.skills].sort())
    || JSON.stringify(projectEntries.sort()) !== JSON.stringify([...manifest.selfSkills].sort())) {
    throw new Error("SKILL_SOURCE_IDS_MISMATCH");
  }
  const vendorFiles = await readTree(vendor);
  const projectFiles = await readTree(project);
  for (const id of manifest.skills) if (!vendorFiles.includes(`${id}/SKILL.md`)) throw new Error("SKILL_SOURCE_BODY_MISSING");
  for (const id of manifest.selfSkills) if (!projectFiles.includes(`${id}/SKILL.md`)) throw new Error("SKILL_SOURCE_BODY_MISSING");
  if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)
    || Object.keys(manifest.files).length !== vendorFiles.length) throw new Error("SKILL_SOURCE_HASH_MISMATCH");
  for (const relative of vendorFiles) {
    const digest = createHash("sha256").update(await fs.readFile(path.join(vendor, relative))).digest("hex");
    if (manifest.files[relative] !== digest) throw new Error("SKILL_SOURCE_HASH_MISMATCH");
  }
  for (const relative of ["LICENSE-NOTICES.md", "license-provenance.json"]) {
    await fs.access(path.join(vendorRoot, relative));
  }
  await readTree(path.join(vendorRoot, "licenses"));
  return { vendorIds: manifest.skills.length, projectIds: manifest.selfSkills.length,
    vendorFiles: vendorFiles.length, projectFiles: projectFiles.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validateSkills().then(result => console.log(`[validate-skills] ${result.vendorIds} vendor, ${result.projectIds} maintained; ${result.vendorFiles + result.projectFiles} files`))
    .catch(error => { console.error(`[validate-skills] ${error.message}`); process.exitCode = 1; });
}
