import { it, expect, vi } from "vitest";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const profile = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({ app: { getPath: () => profile.root } }));

it("observes edits to exported markdown and stops watching when unbound", async () => {
  profile.root = mkdtempSync(join(tmpdir(), "ff-watch-profile-"));
  const vault = realpathSync.native(mkdtempSync(join(tmpdir(), "ff-watch-vault-")));
  vi.resetModules();
  const { memoryStore: store } = await import("./memory-store");
  const { exportMemoryToObsidianVault: exportVault } = await import("./obsidian-exporter");
  const watcher = await import("./obsidian-importer");
  try {
    const entry = await store.addL2Memory({ content: "Unedited garden", triggerText: "garden",
      sourceConversationId: "watch-session", isPinned: false });
    await exportVault(vault);
    watcher.startVaultWatcher(vault);
    expect(watcher.isVaultWatcherActive()).toBe(true);
    writeFileSync(join(vault, "记忆", `${entry.id}.md`),
      `---\nid: ${entry.id}\ntype: 片段\n---\n\n# Garden\n\nGarden edited in the vault\n`);
    await expect.poll(async () => (await store.getAllL2()).find(item => item.id === entry.id)?.content,
      { timeout: 6000, interval: 200 }).toBe("Garden edited in the vault");
    watcher.stopVaultWatcher();
    expect(watcher.isVaultWatcherActive()).toBe(false);
  } finally {
    watcher._resetForTest();
    rmSync(vault, { recursive: true, force: true });
    rmSync(profile.root, { recursive: true, force: true });
  }
}, 20000);
