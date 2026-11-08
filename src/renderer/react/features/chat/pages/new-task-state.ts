type Workspace = { path: string; displayName?: string };
type Binding = { workspaceRoot: string; displayName?: string };

export function inheritedTaskWorkspace(explicit: Workspace | undefined, binding: Binding | undefined, pending: Workspace | undefined): Workspace | undefined {
  if (explicit) return { path: explicit.path, displayName: explicit.displayName };
  if (binding?.workspaceRoot) return { path: binding.workspaceRoot, displayName: binding.displayName };
  return pending;
}

export function withoutKey<T extends object>(state: T, key: keyof T): T {
  const next = { ...state };
  delete next[key];
  return next;
}
