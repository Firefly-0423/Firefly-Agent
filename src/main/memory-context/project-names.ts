import { projectKeyForWorkspaceRoot } from "../memory-policy/project-scope";

/** Where project names can come from: the cheap session index, or (fallback) the sessions themselves. */
export interface ProjectNameSource {
  /** Lightweight workspace info taken from the session index; preferred because it never reads session files. */
  listProjectBindings?(): ReadonlyArray<{ workspaceRoot?: string; displayName?: string }>;
  listSessionIds(): readonly string[];
  getSession(id: string): { workspaceBinding?: { workspaceRoot?: string; displayName?: string } } | undefined | null;
}

/**
 * Display names for the project keys the settings list actually needs, found among the sessions Main still knows.
 * The names are decoration: nothing here may fail the memory panel, so every unreadable binding is skipped, and the
 * search stops as soon as every needed key has a name. Without any needed key nothing is read at all.
 */
export function resolveProjectNames(needed: ReadonlySet<string>, source: ProjectNameSource): Map<string, string> {
  const names = new Map<string, string>();
  if (needed.size === 0) return names;
  const consider = (root: string | undefined, name: string | undefined) => {
    if (!root || !name) return;
    try {
      const key = projectKeyForWorkspaceRoot(root);
      if (needed.has(key) && !names.has(key)) names.set(key, name);
    } catch { /* an invalid stored root only loses its own name */ }
  };
  try {
    if (source.listProjectBindings) {
      for (const binding of source.listProjectBindings()) {
        consider(binding.workspaceRoot, binding.displayName);
        if (names.size === needed.size) break;
      }
      return names;
    }
    for (const id of source.listSessionIds()) {
      try {
        const binding = source.getSession(id)?.workspaceBinding;
        consider(binding?.workspaceRoot, binding?.displayName);
      } catch { /* one unreadable session loses only its own name */ }
      if (names.size === needed.size) break;
    }
  } catch { /* a failing index leaves the names empty */ }
  return names;
}
