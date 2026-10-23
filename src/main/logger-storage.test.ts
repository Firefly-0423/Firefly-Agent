import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const roots: string[] = [];
const stops: Array<() => void> = [];
function temporary() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-logger-boundary-")); roots.push(root); return root; }
beforeEach(() => vi.resetModules());
afterEach(() => { for (const stop of stops.splice(0)) stop(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
describe("file logger storage boundary", () => {
  it("refuses installation before validated storage exists", async () => {
    const main = await import("./logger");
    expect(() => main.initializeMainFileLogging()).toThrow("FIREFLY_STORAGE_NOT_INITIALIZED");
  });
  it("writes only to the StorageContext main log", async () => {
    const { resolveRuntimeProfile } = await import("./runtime-profile");
    const { initializeStorageContext } = await import("./storage-context");
    const isolation = temporary();
    const storage = initializeStorageContext(resolveRuntimeProfile({ isPackaged: true, env: {}, productionAppData: temporary(), argv: ["--firefly-profile=test", `--firefly-isolation-root=${isolation}`] }));
    const main = await import("./logger");
    stops.push(main.initializeMainFileLogging());
    main.logger.warn("Firefly", "storage-boundary-fixture");
    expect(fs.readFileSync(storage.files.mainLog, "utf8")).toContain("storage-boundary-fixture");
  });
});
