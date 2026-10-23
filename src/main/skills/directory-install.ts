import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { assertSkillPath } from "./skill-path-safety";

type FileHashes = Record<string, string>;
type ManagedState = Record<string, FileHashes>;

export interface DirectoryInstallOptions {
  sourceDirectory: string;
  userSkillsDir: string;
  expectedIds: readonly string[];
  expectedFileHashes?: Readonly<Record<string, string>>;
}

export interface DirectoryInstallResult {
  installed: string[];
  updated: string[];
  preserved: string[];
}

export function validateManagedSourceDirectory(sourceDirectory: string, expectedIds: readonly string[],
  expectedFileHashes?: Readonly<Record<string, string>>): Map<string, FileHashes> {
  assertDirectory(sourceDirectory);
  const expected = new Set(expectedIds);
  if (expected.size !== expectedIds.length || [...expected].some(id => { try { assertName(id); return false; } catch { return true; } })) {
    throw new Error("SKILL_DIRECTORY_IDS_INVALID");
  }
  const entries = fs.readdirSync(sourceDirectory, { withFileTypes: true });
  if (entries.length !== expected.size || entries.some(entry => !expected.has(entry.name) || !entry.isDirectory())) {
    throw new Error("SKILL_DIRECTORY_IDS_MISMATCH");
  }
  const shipped = new Map<string, FileHashes>();
  for (const id of expectedIds) {
    const files = inventory(path.join(sourceDirectory, id));
    if (!files["SKILL.md"]) throw new Error("SKILL_DIRECTORY_BODY_MISSING");
    shipped.set(id, files);
  }
  if (expectedFileHashes) {
    const actual = [...shipped].flatMap(([id, files]) => Object.entries(files).map(([relative, digest]) => [`${id}/${relative}`, digest] as const));
    if (actual.length !== Object.keys(expectedFileHashes).length
      || actual.some(([relative, digest]) => expectedFileHashes[relative] !== digest)) {
      throw new Error("SKILL_DIRECTORY_HASH_MISMATCH");
    }
  }
  return shipped;
}

const stateName = ".firefly-managed-skills.json";

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertName(name: string): void {
  if (!name || name === "." || name === ".." || /[\\/:*?"<>|\x00-\x1f]/.test(name)
    || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error("SKILL_DIRECTORY_PATH_INVALID");
  }
}

function assertDirectory(directory: string): void {
  assertSkillPath(directory);
  const info = fs.lstatSync(directory);
  if (info.isSymbolicLink()) throw new Error("SKILL_DIRECTORY_LINK");
  if (!info.isDirectory()) throw new Error("SKILL_DIRECTORY_NOT_DIRECTORY");
}

function inventory(directory: string): FileHashes {
  assertDirectory(directory);
  const files: FileHashes = {};
  const seen = new Set<string>();
  function visit(current: string, prefix: string): void {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      assertName(entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const key = relative.toLowerCase();
      if (seen.has(key)) throw new Error("SKILL_DIRECTORY_DUPLICATE_PATH");
      seen.add(key);
      const file = path.join(current, entry.name);
      const info = fs.lstatSync(file);
      if (info.isSymbolicLink()) throw new Error("SKILL_DIRECTORY_LINK");
      if (info.isDirectory()) visit(file, relative);
      else if (info.isFile()) files[relative] = hash(fs.readFileSync(file));
      else throw new Error("SKILL_DIRECTORY_NOT_FILE");
    }
  }
  visit(directory, "");
  return files;
}

function sameFiles(left: FileHashes, right: FileHashes): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key]);
}

function matchesShippedFiles(installed: FileHashes, shipped: FileHashes): boolean {
  return Object.entries(shipped).every(([relative, digest]) => installed[relative] === digest)
    && Object.keys(installed).every(relative => relative in shipped || relative.endsWith(".pre-firefly.bak"));
}

function exists(location: string): boolean {
  try { fs.lstatSync(location); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function readState(file: string): ManagedState {
  assertSkillPath(file);
  if (!fs.existsSync(file)) return {};
  const state: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!state || typeof state !== "object" || Array.isArray(state)
    || Object.entries(state).some(([id, files]) => {
      try { assertName(id); } catch { return true; }
      return !files || typeof files !== "object" || Array.isArray(files)
        || Object.entries(files).some(([relative, digest]) => {
          try { relative.split("/").forEach(assertName); } catch { return true; }
          return typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest);
        });
    })) throw new Error("SKILL_DIRECTORY_STATE_INVALID");
  return state as ManagedState;
}

function writeState(file: string, state: ManagedState): void {
  assertSkillPath(file);
  const temporary = `${file}.update-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function copyTree(source: string, destination: string): void {
  assertDirectory(source);
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    assertName(entry.name);
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const info = fs.lstatSync(from);
    if (info.isSymbolicLink()) throw new Error("SKILL_DIRECTORY_LINK");
    if (info.isDirectory()) copyTree(from, to);
    else if (info.isFile()) fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    else throw new Error("SKILL_DIRECTORY_NOT_FILE");
  }
}

/** Copy into a newly reserved directory; existing roots (including empty ones) are never adopted. */
export function copyManagedSkillTreeExclusive(source: string, destination: string): void {
  assertDirectory(source);
  // Complete source validation happens before creating the destination.
  inventory(source);
  assertSkillPath(destination);
  fs.mkdirSync(destination);
  copyTree(source, destination);
}

function replaceTree(target: string, stage: string, backup: string | null): void {
  if (backup) fs.renameSync(target, backup);
  try { fs.renameSync(stage, target); }
  catch (error) {
    if (backup) fs.renameSync(backup, target);
    throw error;
  }
}

export function updateInstalledSkillDirectory(target: string, updateStage: (stage: string) => boolean): boolean {
  assertDirectory(target);
  const userSkillsDir = path.dirname(target);
  const stagingRoot = path.join(path.dirname(userSkillsDir), "skills-managed-staging");
  const backupRoot = path.join(path.dirname(userSkillsDir), "skills-managed-backups");
  assertSkillPath(stagingRoot);
  assertSkillPath(backupRoot);
  fs.mkdirSync(stagingRoot, { recursive: true });
  fs.mkdirSync(backupRoot, { recursive: true });
  const stage = path.join(stagingRoot, `${path.basename(target)}-${randomUUID()}`);
  const backup = path.join(backupRoot, `${path.basename(target)}-${randomUUID()}`);
  try {
    copyTree(target, stage);
    if (!updateStage(stage)) return false;
    inventory(stage);
    replaceTree(target, stage, backup);
    return true;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

/** Synchronize only recognized managed directories. Unknown or user-edited files are never overwritten. */
export function synchronizeManagedSkillDirectories(options: DirectoryInstallOptions): DirectoryInstallResult {
  const { sourceDirectory, userSkillsDir, expectedIds } = options;
  const shipped = validateManagedSourceDirectory(sourceDirectory, expectedIds, options.expectedFileHashes);

  assertSkillPath(userSkillsDir);
  fs.mkdirSync(userSkillsDir, { recursive: true });
  const statePath = path.join(userSkillsDir, stateName);
  let state = readState(statePath);
  const result: DirectoryInstallResult = { installed: [], updated: [], preserved: [] };
  const stagingRoot = path.join(path.dirname(userSkillsDir), "skills-managed-staging");
  const backupRoot = path.join(path.dirname(userSkillsDir), "skills-managed-backups");
  assertSkillPath(stagingRoot);
  assertSkillPath(backupRoot);
  for (const id of expectedIds) {
    const source = path.join(sourceDirectory, id);
    const target = path.join(userSkillsDir, id);
    const sourceFiles = shipped.get(id)!;
    if (exists(target)) {
      assertDirectory(target);
      const actual = inventory(target);
      if (!state[id]) {
        result.preserved.push(id);
        continue;
      }
      if (!sameFiles(actual, state[id])) {
        result.preserved.push(id);
        continue;
      }
      if (matchesShippedFiles(actual, sourceFiles)) continue;
    }
    fs.mkdirSync(stagingRoot, { recursive: true });
    fs.mkdirSync(backupRoot, { recursive: true });
    const stage = path.join(stagingRoot, `${id}-${randomUUID()}`);
    const backup = exists(target) ? path.join(backupRoot, `${id}-${randomUUID()}`) : null;
    try {
      if (backup) {
        copyTree(target, stage);
        for (const relative of Object.keys(state[id])) {
          if (relative.endsWith(".pre-firefly.bak")) continue;
          const installed = path.join(stage, ...relative.split("/"));
          if (!fs.existsSync(installed)) continue;
          const previous = fs.readFileSync(installed);
          const next = sourceFiles[relative];
          if (next !== hash(previous)) {
            const prior = `${installed}.pre-firefly.bak`;
            if (!fs.existsSync(prior)) fs.copyFileSync(installed, prior, fs.constants.COPYFILE_EXCL);
            fs.rmSync(installed);
          }
        }
        copyMissingSourceFiles(source, stage);
      } else copyTree(source, stage);
      const staged = inventory(stage);
      if (Object.entries(sourceFiles).some(([relative, digest]) => staged[relative] !== digest)) {
        throw new Error("SKILL_DIRECTORY_SOURCE_CHANGED");
      }
      const nextState = { ...state, [id]: staged };
      replaceTree(target, stage, backup);
      try { writeState(statePath, nextState); }
      catch (error) {
        if (backup) {
          const failed = path.join(stagingRoot, `${id}-failed-${randomUUID()}`);
          fs.renameSync(target, failed);
          fs.renameSync(backup, target);
          fs.rmSync(failed, { recursive: true, force: true });
        } else fs.rmSync(target, { recursive: true, force: true });
        throw error;
      }
      state = nextState;
      (backup ? result.updated : result.installed).push(id);
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  return result;
}

function copyMissingSourceFiles(source: string, stage: string): void {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(stage, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyMissingSourceFiles(from, to);
    } else if (entry.isFile()) {
      if (!fs.existsSync(to)) fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    } else throw new Error("SKILL_DIRECTORY_LINK");
  }
}
