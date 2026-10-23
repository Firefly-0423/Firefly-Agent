import fs from "node:fs";
import path from "node:path";

export function assertSkillPath(location: string): void {
  const absolute = path.resolve(location);
  let current = path.parse(absolute).root;
  for (const part of path.relative(current, absolute).split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error("SKILL_DIRECTORY_LINK");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
