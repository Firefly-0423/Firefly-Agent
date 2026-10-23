import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: { getPath: () => { throw new Error("direct Electron path access forbidden"); } } }));
const roots: string[] = [];
function temporary() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-token-storage-")); roots.push(root); return root; }
beforeEach(() => vi.resetModules());
afterEach(async () => { const token = await import("./token-usage-store"); token.flush(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
async function setup() {
  const { resolveRuntimeProfile } = await import("./runtime-profile");
  const { initializeStorageContext } = await import("./storage-context");
  const root = temporary();
  return initializeStorageContext(resolveRuntimeProfile({ isPackaged: true, env: {}, productionAppData: temporary(), argv: ["--firefly-profile=test", `--firefly-isolation-root=${root}`] }));
}
describe("token usage storage boundary", () => {
  it("refuses loading before storage initialization", async () => {
    const token = await import("./token-usage-store");
    expect(() => token.getUsage(1)).toThrow("FIREFLY_STORAGE_NOT_INITIALIZED");
  });
  it("writes usage and a bounded valid backup through StorageContext", async () => {
    const storage = await setup(); const token = await import("./token-usage-store");
    token.recordUsage(10, 5); token.flush();
    token.recordUsage(3, 2); token.flush();
    const current = JSON.parse(fs.readFileSync(storage.files.tokenUsage, "utf8"));
    const previous = JSON.parse(fs.readFileSync(`${storage.files.tokenUsage}.bak`, "utf8"));
    expect(Object.values(current.days)).toEqual([expect.objectContaining({ input: 13, output: 7 })]);
    expect(Object.values(previous.days)).toEqual([expect.objectContaining({ input: 10, output: 5 })]);
  });
  it("keeps malformed existing usage unchanged when new usage is recorded", async () => {
    const storage = await setup(); fs.mkdirSync(storage.stateRoot, { recursive: true }); fs.writeFileSync(storage.files.tokenUsage, "{malformed");
    const token = await import("./token-usage-store");
    token.recordUsage(10, 5); token.flush();
    expect(fs.readFileSync(storage.files.tokenUsage, "utf8")).toBe("{malformed");
  });
});
