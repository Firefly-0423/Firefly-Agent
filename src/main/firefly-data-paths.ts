import path from "node:path";

export function fireflyDataDirectory(root: string, kind: "chats" | "runs" | "tasks"): string {
  return path.join(root, `firefly-${kind}`);
}

export function fireflyExportManifest(root: string): string {
  return path.join(root, ".firefly-export-manifest.json");
}
