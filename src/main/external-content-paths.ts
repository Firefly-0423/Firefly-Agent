import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ExternalContentPathInput {
  isPackaged: boolean; appPath: string;
  executablePath: string; userDataPath: string;
}
export interface ExternalContentPaths {
  installRoot: string; promptDirectories: string[];
  builtinSkillDirectory: string; userSkillDirectories: string[];
}
export interface SkillScanSource { directory: string; source: "builtin" | "user" }

// All roots are outside the archive; the caller decides which installation owns them.
export function resolveExternalContentPaths(input: ExternalContentPathInput): ExternalContentPaths {
  const installation = input.isPackaged ? path.dirname(input.executablePath) : input.appPath;
  const prompts = input.isPackaged
    ? [path.join(input.userDataPath, "prompts"), path.join(installation, "prompts")]
    : [path.join(installation, "prompts")];
  return {
    installRoot: installation, promptDirectories: prompts,
    builtinSkillDirectory: path.join(installation, "skills"),
    userSkillDirectories: [path.join(input.userDataPath, "skills")],
  };
}

export function getExternalContentPaths(): ExternalContentPaths {
  let locations: ExternalContentPathInput;
  try {
    locations = {
      isPackaged: app.isPackaged, appPath: app.getAppPath(),
      executablePath: app.getPath("exe"), userDataPath: app.getPath("userData"),
    };
    return resolveExternalContentPaths(locations);
  } catch {
    const workingDirectory = process.cwd();
    locations = {
      isPackaged: false, appPath: workingDirectory,
      executablePath: process.execPath, userDataPath: path.join(workingDirectory, ".firefly-user-data"),
    };
    return resolveExternalContentPaths(locations);
  }
}

function confinedRelative(value: string): string | null {
  if (!value || path.isAbsolute(value)) return null;
  const relative = path.normalize(value);
  return relative === ".." || relative.startsWith(`..${path.sep}`) ? null : relative;
}

export function resolvePackagedSkillDirectory(
  paths: Pick<ExternalContentPaths, "installRoot"> = getExternalContentPaths(),
  options: { isPackaged?: boolean; resourcesPath?: string; existsSync?: (p: string) => boolean } = {},
): string | null {
  const packaged = options.isPackaged ?? app.isPackaged;
  const probe = options.existsSync ?? ((location: string) => fs.existsSync(location));
  const location = packaged
    ? path.join(options.resourcesPath ?? process.resourcesPath, "firefly-skills", "skills")
    : path.join(paths.installRoot, "vendor", "firefly-skills", "skills");
  return probe(location) ? location : null;
}

function firstExisting(roots: string[], suffix: string[]): string | null {
  for (const root of roots) {
    const location = path.join(root, ...suffix);
    if (fs.existsSync(location)) return location;
  }
  return null;
}

export function findPromptPath(relativePath: string, promptDirectories = getExternalContentPaths().promptDirectories): string | null {
  const relative = confinedRelative(relativePath);
  return relative ? firstExisting(promptDirectories, [relative]) : null;
}

export function findSkillPath(
  skillId: string, relativePath: string,
  paths: Pick<ExternalContentPaths, "builtinSkillDirectory" | "userSkillDirectories"> = getExternalContentPaths(),
): string | null {
  const identity = confinedRelative(skillId);
  const relative = confinedRelative(relativePath);
  if (!identity || !relative || identity.includes(path.sep)) return null;
  const roots = [...paths.userSkillDirectories].reverse();
  roots.push(paths.builtinSkillDirectory);
  return firstExisting(roots, [identity, relative]);
}

export function resolveSkillScanSources(
  paths: Pick<ExternalContentPaths, "builtinSkillDirectory" | "userSkillDirectories"> = getExternalContentPaths(),
): SkillScanSource[] {
  const scans: SkillScanSource[] = [];
  if (fs.existsSync(paths.builtinSkillDirectory)) scans.push({ directory: paths.builtinSkillDirectory, source: "builtin" });
  const identities = new Set(scans.map(({ directory }) => path.resolve(directory).toLowerCase()));
  for (const directory of paths.userSkillDirectories) {
    const identity = path.resolve(directory).toLowerCase();
    if (identities.has(identity)) continue;
    identities.add(identity);
    scans.push({ directory, source: "user" });
  }
  return scans;
}
