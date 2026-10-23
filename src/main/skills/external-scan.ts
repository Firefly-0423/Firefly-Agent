import fs from "node:fs";
import path from "node:path";
import type { StorageContext } from "../storage-context";
import type { SkillEntry } from "./types";
import { externalSkillPlaceholder, isExternalSkillId } from "./skill-scanner";
import { assertExternalIdentity, snapshotExternalPath, verifyExternalInstallation, type ExternalSkillStateStore } from "./external-state";

/** Only the controlled host record supplies metadata; untrusted directories never supply a fallback body. */
export function scanExternalSkills(storage: StorageContext, state: ExternalSkillStateStore): SkillEntry[] {
  const skillsRoot = path.join(storage.dataRoot, "skills"), stateRoot = path.join(storage.stateRoot, "external-skills");
  const ids = new Set<string>();
  for (const [root, stateFiles] of [[skillsRoot, false], [stateRoot, true]] as const) {
    try {
      if (snapshotExternalPath(root, stateFiles ? storage.stateRoot : storage.dataRoot).kind !== "directory") continue;
      for (const name of fs.readdirSync(root)) {
        const id = stateFiles ? name.endsWith(".json") ? name.slice(0, -5) : "" : name;
        if (isExternalSkillId(id)) ids.add(id);
      }
    } catch { /* No unowned-root traversal or fallback. Ordinary scanner placeholders remain visible. */ }
  }
  return [...ids].map(id => {
    const outer = path.join(skillsRoot, id), unavailable = externalSkillPlaceholder(id, outer);
    try {
      const record = state.read(id);
      if (!record || record.status !== "committed") return unavailable;
      const proofs = verifyExternalInstallation(storage, record);
      for (const proof of proofs) assertExternalIdentity(proof, storage.dataRoot);
      const dirPath = path.join(outer, "content"), prefix = record.skill.path + "/references/";
      return { id, name: record.skill.upstreamName, description: record.skill.description, tools: [],
        version: record.skill.version, dirPath, bodyPath: path.join(dirPath, "SKILL.md"),
        references: record.skill.files.filter(file => file.path.startsWith(prefix)).map(file => file.path.slice(prefix.length)),
        enabled: record.enabled, source: "user" as const, hiddenFromUi: false, external: { status: "ready" as const } };
    } catch { return unavailable; }
  });
}
