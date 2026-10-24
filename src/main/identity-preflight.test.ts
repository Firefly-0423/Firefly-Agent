import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ paths: new Map<string, string>(), names: [] as string[] }));
vi.mock("electron", () => ({ app: {
  isPackaged: true,
  getPath: (name: string) => fake.paths.get(name),
  setPath: (name: string, value: string) => fake.paths.set(name, value),
  setName: (name: string) => fake.names.push(name),
  setAppLogsPath: (value: string) => fake.paths.set("logs", value),
} }));
const roots: string[] = [];
function temporary() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-preflight-test-")); roots.push(root); return root; }
beforeEach(() => {
  vi.resetModules();
  fake.paths.clear(); fake.names.length = 0;
  const production = temporary();
  fake.paths.set("appData", production);
  fake.paths.set("userData", path.join(production, "Firefly"));
  vi.stubEnv("FIREFLY_RUNTIME_PROFILE", "smoke");
  vi.stubEnv("FIREFLY_ISOLATION_ROOT", "");
  vi.stubEnv("FIREFLY_ISOLATED_SMOKE_APPDATA", "");
});
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
describe("earliest identity preflight", () => {
  it("rejects a lost smoke root without creating production files or installing storage", async () => {
    const production = fake.paths.get("appData")!;
    await expect(import("./identity-preflight")).rejects.toThrow("FIREFLY_RUNTIME_ISOLATION_REQUIRED");
    expect(fs.readdirSync(production)).toEqual([]);
    const { getStorageContext } = await import("./storage-context");
    expect(() => getStorageContext()).toThrow("FIREFLY_STORAGE_NOT_INITIALIZED");
  });
  it("installs storage only after all Electron roots have been applied", async () => {
    const isolation = temporary();
    vi.stubEnv("FIREFLY_ISOLATION_ROOT", isolation);
    const preflight = await import("./identity-preflight");
    const { getStorageContext } = await import("./storage-context");
    const storage = getStorageContext();
    expect(storage.profile.kind).toBe("smoke");
    expect(preflight.userDataDir).toBe(path.join(fs.realpathSync.native(isolation), "Firefly-smoke"));
    expect(storage.sessionRoot).toBe(fake.paths.get("sessionData"));
    expect(storage.logsRoot).toBe(fake.paths.get("logs"));
  });
});
