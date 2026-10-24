// Skill startup and Main-only API. All profile-owned locations use the injected StorageContext.
import * as fs from "fs";
import * as path from "path";
import { scanSkills, isExternalSkillId, externalSkillPlaceholder } from "./skill-scanner";
import { skillRegistry } from "./skill-registry";
import { registerSkillTools } from "./skill-tools";
import type { SkillEntry } from "./types";
import { logger, LogTag } from "../logger";
import { getExternalContentPaths, resolveSkillScanSources, resolvePackagedSkillDirectory } from "../external-content-paths";
import { synchronizeManagedSkillDirectories, validateManagedSourceDirectory } from "./directory-install";
import { getStorageContext, type StorageContext } from "../storage-context";
import { AtomicJsonStore } from "../atomic-json-store";
import { ExternalSkillStateStore, assertExternalIdentity, verifyExternalInstallation } from "./external-state";
import { scanExternalSkills } from "./external-scan";
import type { ExternalHostSession, ExternalSkillRecord } from "./external-types";

interface SkillsContext {
  storage: StorageContext;
  state: ExternalSkillStateStore;
  expected: Map<string, string>;
}
let context: SkillsContext | undefined;

// Before injection this was app.getPath("userData")/skills-enabled.json. StorageContext.configRoot
// is exactly profile.userData, and Main preflight applies that profile to Electron: no migration.
function enabledStore(storage: StorageContext): AtomicJsonStore<Record<string, boolean>> {
  return new AtomicJsonStore(path.join(storage.configRoot, "skills-enabled.json"), value => !!value && typeof value === "object"
    && !Array.isArray(value) && Object.values(value).every(entry => typeof entry === "boolean"));
}
function currentContext(): SkillsContext {
  if (!context) throw new Error("SKILL_STORAGE_NOT_INITIALIZED");
  return context;
}
function recordFingerprint(record: ExternalSkillRecord): string { return JSON.stringify({ ...record, enabled: false }); }

/** Recheck the current actual Main guard, complete provenance and every installed content digest. */
function verifiedExternalRecord(current: SkillsContext, skill: SkillEntry, requireEnabled: boolean): ExternalSkillRecord {
  current.state.assertWritable(current.storage);
  const record = current.state.read(skill.id);
  if (skill.external?.status !== "ready" || !record || record.status !== "committed"
    || current.expected.get(skill.id) !== recordFingerprint(record) || (requireEnabled && (!skill.enabled || !record.enabled))) throw new Error("SKILL_EXTERNAL_UNAVAILABLE");
  const directory = path.join(current.storage.dataRoot, "skills", skill.id, "content");
  if (skill.dirPath !== directory || skill.bodyPath !== path.join(directory, "SKILL.md")) throw new Error("SKILL_EXTERNAL_UNAVAILABLE");
  const proofs = verifyExternalInstallation(current.storage, record);
  for (const proof of proofs) assertExternalIdentity(proof, current.storage.dataRoot);
  // Detect a changed provenance record during verification, too.
  const after = current.state.read(skill.id);
  if (!after || JSON.stringify(after) !== JSON.stringify(record)) throw new Error("SKILL_EXTERNAL_UNAVAILABLE");
  return record;
}

function scanAndRegister(current: SkillsContext): number {
  const paths = { ...getExternalContentPaths(), userSkillDirectories: [path.join(current.storage.dataRoot, "skills")] };
  const sources = resolveSkillScanSources(paths), map = new Map<string, SkillEntry>();
  for (const source of sources) for (const skill of scanSkills(source.directory, source.source)) map.set(skill.id, skill);
  for (const skill of scanExternalSkills(current.storage, current.state)) map.set(skill.id, skill);
  const saved = enabledStore(current.storage).read({});
  for (const skill of map.values()) {
    if (isExternalSkillId(skill.id)) {
      const record = current.state.read(skill.id);
      if (skill.external?.status === "ready" && record?.status === "committed") {
        const fingerprint = recordFingerprint(record), previous = current.expected.get(skill.id);
        if (previous !== undefined && previous !== fingerprint) map.set(skill.id, externalSkillPlaceholder(skill.id, path.join(current.storage.dataRoot, "skills", skill.id)));
        else current.expected.set(skill.id, fingerprint);
      }
    } else if (Object.hasOwn(saved, skill.id)) skill.enabled = saved[skill.id];
  }
  for (const id of skillRegistry.getAll().map(skill => skill.id)) if (!map.has(id)) skillRegistry.unregister(id);
  skillRegistry.setExternalAccessGate(skill => {
    try { verifiedExternalRecord(current, skill, true); return true; } catch { return false; }
  });
  for (const skill of map.values()) skillRegistry.register(skill);
  logger.info(LogTag.Skills, `loaded ${map.size} skills:`, Array.from(map.keys()).join(", ") || "(none)");
  return map.size;
}

/** Main must pass the same host object used by all external stores/services. No-host is read-only. */
export async function initSkills(storage: StorageContext = getStorageContext(), host?: ExternalHostSession): Promise<void> {
  // Reset before reading the new profile, including a failed initialization.
  skillRegistry.setExternalAccessGate(() => false);
  for (const skill of skillRegistry.getAll()) skillRegistry.unregister(skill.id);
  context = { storage, state: new ExternalSkillStateStore(storage, host), expected: new Map() };
  const paths = { ...getExternalContentPaths(), userSkillDirectories: [path.join(storage.dataRoot, "skills")] };
  const sourceDirectory = resolvePackagedSkillDirectory(paths), userSkillsDir = paths.userSkillDirectories[0];
  try {
    if (sourceDirectory) {
      const manifestPath = path.join(path.dirname(sourceDirectory), "skills-manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { skills: string[]; files: Record<string, string> };
      if (!Array.isArray(manifest.skills) || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) throw new Error("SKILL_DIRECTORY_MANIFEST_INVALID");
      validateManagedSourceDirectory(sourceDirectory, manifest.skills, manifest.files);
      synchronizeManagedSkillDirectories({ sourceDirectory, userSkillsDir, expectedIds: manifest.skills, expectedFileHashes: manifest.files });
    }
  } catch (error) {
    const reason = error instanceof Error && /^SKILL_[A-Z_]+$/.test(error.message) ? error.message : "SKILL_DIRECTORY_SYNC_FAILED";
    logger.warn(LogTag.Skills, "managed directory sync failed; scanning existing files without replacing them", { reason });
  }
  scanAndRegister(context);
  registerSkillTools();
}

/** Persist first. Registry state never advertises a write which failed. */
export function setSkillEnabled(id: string, enabled: boolean): void {
  const current = currentContext(), skill = skillRegistry.getById(id);
  if (typeof id !== "string" || typeof enabled !== "boolean" || !skill) throw new Error("SKILL_ENABLE_ARGUMENT_INVALID");
  if (isExternalSkillId(id)) {
    const record = verifiedExternalRecord(current, skill, false);
    current.state.setEnabledOwned(id, record.transactionId, enabled);
  } else {
    const store = enabledStore(current.storage), saved = store.read({});
    store.write({ ...saved, [id]: enabled });
  }
  skillRegistry.setEnabled(id, enabled);
}

/** UI metadata is deliberately separate from runtime instruction authorization. */
export function listSkillsForUi() {
  return skillRegistry.getAll().filter(skill => !skill.hiddenFromUi).map(skill => ({
    id: skill.id, name: skill.name, description: skill.description, tools: skill.tools ?? [], enabled: skill.enabled,
    source: skill.source, version: skill.version, references: skill.references, external: skill.external,
  }));
}
export function rescanSkills(): number { return scanAndRegister(currentContext()); }
export { skillRegistry } from "./skill-registry";
export { buildAutoInjectedSkillContext, buildAutoInjectedSoulContext, buildSkillCatalog } from "./skill-catalog";
export { parseSlashCommand } from "./skill-commands";
