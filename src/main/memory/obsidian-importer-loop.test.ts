import { it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const profile = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({ app: { getPath: () => profile.root } }));
const pause = (duration: number) => new Promise(resolve => setTimeout(resolve, duration));

it("does not export a memory change made under the vault import guard", async () => {
  profile.root = mkdtempSync(join(tmpdir(), "ff-sync-profile-"));
  const vault = mkdtempSync(join(tmpdir(), "ff-sync-vault-"));
  vi.resetModules();
  const { memoryStore: store } = await import("./memory-store");
  const { loadObsidianVaultConfig: config, saveObsidianVaultConfig: configure } = await import("./obsidian-vault-config");
  const { setImportingMemory: guard } = await import("./obsidian-sync-flag");
  try {
    configure({ vaultPath: vault, autoSync: true });
    const entry = await store.addL2Memory({ content: "Garden before import", triggerText: "garden",
      sourceConversationId: "sync-session", isPinned: false });
    await pause(2300);
    const exportedAt = config().lastSyncAt;
    expect(exportedAt).toBeGreaterThan(0);
    guard(true);
    try { await store.updateL2Content(entry.id, "Garden after import"); } finally { guard(false); }
    await pause(2300);
    expect(config().lastSyncAt).toBe(exportedAt);
    expect((await store.getAllL2()).find(item => item.id === entry.id)!.content).toBe("Garden after import");
  } finally {
    (await import("./obsidian-importer"))._resetForTest();
    rmSync(vault, { recursive: true, force: true });
    rmSync(profile.root, { recursive: true, force: true });
  }
}, 20000);
