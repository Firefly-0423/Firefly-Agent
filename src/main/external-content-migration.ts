import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AtomicJsonStore } from "./atomic-json-store";

interface ContentManifest { prompts: Record<string, string>; skills: Record<string, string> }
export interface StagedContentMigrationInput {
  isPackaged: boolean; manifestFile: string; allowStagedMigration?: boolean;
  installRoot: string; promptDirectories: string[]; userSkillDirectories: string[];
}

// Startup can retry an interrupted installer handoff. Never stop startup for this cache.
export function migrateStagedExternalContent(input: StagedContentMigrationInput): void {
  if (input.isPackaged) {
    try {
      const handoff = path.join(input.installRoot, "..", ".Firefly.content-preserve");
      if (input.allowStagedMigration !== false && fs.existsSync(handoff)) recoverHandoff(handoff, input);
      const snapshot: ContentManifest = {
        prompts: collectHashes(promptRoot(input)),
        skills: collectHashes(path.join(input.installRoot, "skills")),
      };
      new AtomicJsonStore<ContentManifest>(input.manifestFile, acceptsManifest).write(snapshot);
    } catch { /* Preserve startup availability; a subsequent launch can retry. */ }
  }
}

function promptRoot(input: StagedContentMigrationInput): string {
  const installed = path.join(input.installRoot, "prompts");
  return input.promptDirectories.find((candidate) => candidate === installed) ?? installed;
}
function previousSnapshot(input: StagedContentMigrationInput): ContentManifest | null {
  try {
    if (!fs.existsSync(input.manifestFile)) return null;
    const data = JSON.parse(fs.readFileSync(input.manifestFile, "utf8")) as Partial<ContentManifest>;
    if (!data || typeof data !== "object") return null;
    return {
      prompts: data.prompts && typeof data.prompts === "object" ? data.prompts : {},
      skills: data.skills && typeof data.skills === "object" ? data.skills : {},
    };
  } catch { return null; }
}
function recoverHandoff(handoff: string, input: StagedContentMigrationInput): void {
  const recorded = previousSnapshot(input);
  const installedPrompts = promptRoot(input);
  const installedSkills = path.join(input.installRoot, "skills");
  recoverTree(path.join(handoff, "prompts"), input.promptDirectories[0], recorded?.prompts, installedPrompts);
  recoverTree(path.join(handoff, "skills"), input.userSkillDirectories[0], recorded?.skills, installedSkills);
  fs.rmSync(handoff, { recursive: true, force: true });
}
function isPristine(relative: string, hash: string, recorded: Record<string, string> | undefined, installed: string): boolean {
  if (recorded) return recorded[relative] === hash;
  const current = path.join(installed, relative);
  return fs.existsSync(current) && digestFile(current) === hash;
}
function recoverTree(sourceRoot: string, destinationRoot: string, recorded: Record<string, string> | undefined, installedRoot: string): void {
  if (!destinationRoot || !fs.existsSync(sourceRoot)) return;
  const relatives = enumerateFiles(sourceRoot);
  for (const relative of relatives) {
    const source = path.join(sourceRoot, relative);
    const destination = path.join(destinationRoot, relative);
    if (fs.existsSync(destination)) continue;
    const hash = digestFile(source);
    if (isPristine(relative, hash, recorded, installedRoot)) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}
// A breadth-first walk preserves both hash insertion order and the original copy order.
function enumerateFiles(root: string): string[] {
  const directories = [root];
  const relatives: string[] = [];
  while (directories.length !== 0) {
    const directory = directories.shift()!;
    const children = fs.readdirSync(directory, { withFileTypes: true });
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      if (child.isDirectory()) directories.push(absolute);
      else if (child.isFile()) relatives.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
  return relatives;
}
function collectHashes(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  if (fs.existsSync(root)) {
    for (const relative of enumerateFiles(root)) snapshot[relative] = digestFile(path.join(root, relative));
  }
  return snapshot;
}
function digestFile(location: string): string {
  const digest = crypto.createHash("sha1");
  return digest.update(fs.readFileSync(location)).digest("hex");
}
function acceptsManifest(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const snapshot = candidate as Partial<ContentManifest>;
  return [snapshot.prompts, snapshot.skills].every((tree) => {
    if (tree === undefined) return true;
    return !!tree && typeof tree === "object" && !Array.isArray(tree)
      && Object.values(tree).every((hash) => typeof hash === "string");
  });
}
