type Workspace = { path: string; displayName?: string };
type Host = {
  store(): { setWorkspace(id: string, path: string): Promise<{ ok: boolean }> } | undefined;
  bound(name: string | undefined): void;
  clear(): void;
};

/** A failed binding leaves the name alone but still consumes the pending choice. */
export async function bindPendingWorkspace(sessionId: string, workspace: Workspace | undefined, host: Host): Promise<void> {
  if (!workspace) return;
  const result = await host.store()?.setWorkspace(sessionId, workspace.path);
  if (result?.ok) host.bound(workspace.displayName);
  host.clear();
}
