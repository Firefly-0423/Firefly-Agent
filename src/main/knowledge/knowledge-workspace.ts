import fs from "node:fs";
import path from "node:path";
import { ObsidianWorkspaceService } from "./obsidian/obsidian-workspace-service";

export function openKnowledgeWorkspace(mode: string | undefined, root: string | undefined): ObsidianWorkspaceService | undefined {
  if (mode !== "work" || !root) return undefined;
  if (!fs.existsSync(path.join(root, ".obsidian")) && !fs.existsSync(path.join(root, "learn/progress.md"))) return undefined;
  const workspace = new ObsidianWorkspaceService();
  workspace.configure({ enabled: true, vaultPath: root });
  return workspace.isReady() ? workspace : undefined;
}

export async function canUpdateLearningProgress(workspace: ObsidianWorkspaceService): Promise<boolean> {
  try {
    await workspace.readFile({ path: "learn/progress.md" });
    return true;
  } catch {
    return false;
  }
}
