import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtomicJsonStore } from "../../../main/base/storage/atomic-json-store";
import { createStorageContext } from "../../../main/base/storage/storage-context";
import type { PluginManifestV1 } from "../../../shared/plugin-manifest";
import {
  createPluginStateStore,
  DEFAULT_MODEL_RATE_LIMIT,
} from "./plugin-state-store";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-plugin-state-"));
  tempDirs.push(dir);
  return dir;
}

function makeManifest(overrides: Partial<PluginManifestV1> = {}): PluginManifestV1 {
  return {
    schemaVersion: 1,
    id: "dev.firefly.sample",
    name: "Sample Plugin",
    version: "1.0.0",
    sdk: "^1.2.0",
    main: "dist/index.mjs",
    tools: [{ name: "echo", title: "Echo", risk: ["network"], modes: ["work"] }],
    permissions: ["sessions.read", "workspace.read", "model.generate", "model.run"],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("PluginStateStore", () => {
  it("resolves path via StorageContext and handles missing state file cleanly", () => {
    const root = createTempDir();
    const userData = path.join(root, "Firefly-test");
    const storage = createStorageContext({
      kind: "test",
      applicationName: "Firefly-test",
      appData: root,
      userData,
      sessionData: path.join(userData, "session"),
      logs: path.join(userData, "logs"),
      isolationRoot: root,
    });

    const store = createPluginStateStore({ stateFile: storage.files.pluginState });
    expect(store.filePath).toBe(path.join(userData, "plugin-state.json"));
    expect(store.getReadStatus()).toBe("missing");
    expect(store.list()).toEqual([]);
    expect(store.isEnabled("dev.firefly.sample")).toBe(false);
    expect(store.getModelRateLimit("dev.firefly.sample")).toBe(DEFAULT_MODEL_RATE_LIMIT);
    expect(fs.existsSync(storage.files.pluginState)).toBe(false);
  });

  it("persists install, enable, grant/revoke, disable, upgrade revisions and confirmations across restarts", () => {
    const root = createTempDir();
    const stateFile = path.join(root, "plugin-state.json");
    const store = createPluginStateStore({ stateFile });
    const changes: string[] = [];
    store.onChange((id) => changes.push(id));

    const manifest = makeManifest();
    const installed = store.install({ manifest, installDir: path.join(root, "plugins", manifest.id, "1.0.0") });
    expect(installed.enabled).toBe(false);
    expect(installed.revision).toBe(1);
    expect(installed.modelRateLimit).toBe(10);
    expect(store.getReadStatus()).toBe("ok");

    const enabled = store.enable(manifest.id);
    expect(enabled.enabled).toBe(true);
    expect(store.isToolGranted(manifest.id, "echo")).toBe(true);
    expect(store.hasPermission(manifest.id, "sessions.read")).toBe(true);

    // Record first-use confirmation at current revision; verify it survives reload.
    store.confirmations.set(manifest.id, "sessions.read", enabled.revision);
    expect(store.confirmations.get(manifest.id, "sessions.read")).toBe(enabled.revision);

    const reloaded = createPluginStateStore({ stateFile });
    expect(reloaded.isEnabled(manifest.id)).toBe(true);
    expect(reloaded.confirmations.get(manifest.id, "sessions.read")).toBe(enabled.revision);

    // Revoke increments revision and clears/invalidates confirmation.
    const revoked = reloaded.revokePermission(manifest.id, "sessions.read");
    expect(revoked.revision).toBeGreaterThan(enabled.revision);
    expect(reloaded.hasPermission(manifest.id, "sessions.read")).toBe(false);
    expect(reloaded.confirmations.get(manifest.id, "sessions.read")).toBeUndefined();

    // Regrant also increments revision (never reuses prior revision).
    const regranted = reloaded.grantPermission(manifest.id, "sessions.read");
    expect(regranted.revision).toBeGreaterThan(revoked.revision);
    expect(reloaded.hasPermission(manifest.id, "sessions.read")).toBe(true);

    // Disable increments revision and clears confirmations.
    reloaded.confirmations.set(manifest.id, "workspace.read", regranted.revision);
    const disabled = reloaded.disable(manifest.id);
    expect(disabled.enabled).toBe(false);
    expect(disabled.revision).toBeGreaterThan(regranted.revision);
    expect(reloaded.confirmations.get(manifest.id, "workspace.read")).toBeUndefined();

    // Upgrade increments revision.
    const upgraded = reloaded.install({ manifest: makeManifest({ version: "1.1.0" }) });
    expect(upgraded.version).toBe("1.1.0");
    expect(upgraded.revision).toBeGreaterThan(disabled.revision);
    expect(changes.length).toBeGreaterThanOrEqual(2);
  });

  it("handles corrupted JSON gracefully without overwriting the disk file", () => {
    const root = createTempDir();
    const stateFile = path.join(root, "plugin-state.json");
    fs.writeFileSync(stateFile, "{corrupted-json", "utf8");

    const store = createPluginStateStore({ stateFile });
    expect(store.getReadStatus()).toBe("corrupted");
    expect(store.list()).toEqual([]);
    expect(store.isEnabled("dev.firefly.sample")).toBe(false);
    expect(() => store.install({ manifest: makeManifest() })).toThrowError(expect.objectContaining({ code: "ERR_INTERNAL" }));
    expect(fs.readFileSync(stateFile, "utf8")).toBe("{corrupted-json");
  });

  it("preserves prior disk state and rolls back memory on write failure", () => {
    const root = createTempDir();
    const stateFile = path.join(root, "plugin-state.json");
    const store = createPluginStateStore({ stateFile });
    const manifest = makeManifest();
    store.install({ manifest });
    const initialRevision = store.get(manifest.id)!.revision;
    const diskBefore = fs.readFileSync(stateFile, "utf8");

    vi.spyOn(AtomicJsonStore.prototype, "write").mockImplementation(() => {
      throw new Error("disk full");
    });

    expect(() => store.enable(manifest.id)).toThrowError(expect.objectContaining({ code: "ERR_INTERNAL" }));
    expect(store.isEnabled(manifest.id)).toBe(false);
    expect(store.get(manifest.id)!.revision).toBe(initialRevision);
    expect(fs.readFileSync(stateFile, "utf8")).toBe(diskBefore);
    expect(fs.readdirSync(root).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("validates and persists model rate limit in 1..60 with default 10", () => {
    const root = createTempDir();
    const stateFile = path.join(root, "plugin-state.json");
    const store = createPluginStateStore({ stateFile });
    const manifest = makeManifest();
    store.install({ manifest });

    expect(store.getModelRateLimit(manifest.id)).toBe(10);
    expect(() => store.setModelRateLimit(manifest.id, 0)).toThrowError(expect.objectContaining({ code: "ERR_INVALID_ARGUMENT" }));
    expect(() => store.setModelRateLimit(manifest.id, 61)).toThrowError(expect.objectContaining({ code: "ERR_INVALID_ARGUMENT" }));
    expect(() => store.setModelRateLimit(manifest.id, 10.5)).toThrowError(expect.objectContaining({ code: "ERR_INVALID_ARGUMENT" }));

    store.setModelRateLimit(manifest.id, 42);
    expect(store.getModelRateLimit(manifest.id)).toBe(42);
    const reloaded = createPluginStateStore({ stateFile });
    expect(reloaded.getModelRateLimit(manifest.id)).toBe(42);
  });
});
