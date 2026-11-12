import * as fs from "fs";
import * as path from "path";

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Require lexical containment and check every existing ancestor's real target.
 * Missing suffixes are allowed for new files/directories. Dangling links and
 * resolution errors fail closed. This does not lock paths against external races.
 */
export function resolveContainedPath(root: string, target: string): string | null {
  try {
    const absoluteRoot = path.resolve(root);
    const absoluteTarget = path.resolve(absoluteRoot, target);
    if (!isWithin(absoluteRoot, absoluteTarget)) return null;
    const realRoot = fs.realpathSync(absoluteRoot);
    const relative = path.relative(absoluteRoot, absoluteTarget);
    const segments = relative ? relative.split(path.sep) : [];
    let current = absoluteRoot;
    let realTarget = realRoot;
    for (let index = 0; index < segments.length; index++) {
      current = path.join(current, segments[index]);
      try {
        fs.lstatSync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return path.resolve(realTarget, ...segments.slice(index));
      }
      // lstat first distinguishes a missing path from an unresolvable link.
      realTarget = fs.realpathSync(current);
      if (!isWithin(realRoot, realTarget)) return null;
    }
    return realTarget;
  } catch {
    return null;
  }
}
