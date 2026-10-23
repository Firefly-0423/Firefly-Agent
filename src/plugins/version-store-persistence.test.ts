import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { PluginVersionStore } from "./version-store";

const fault = vi.hoisted(() => ({ rename: false, copy: false }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (fault.rename) { fault.rename = false; throw new Error("fixture atomic rename failed"); }
    return actual.rename(...args);
  }, cp: async (...args: Parameters<typeof actual.cp>) => {
    await actual.cp(...args);
    if (fault.copy) { fault.copy = false; throw new Error("fixture interrupted copy"); }
  } };
});
let root = "";
afterEach(() => { fault.rename = false; fault.copy = false; if (root) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  root = mkdtempSync(path.join(os.tmpdir(), "firefly-state-fault-"));
  const userRoot = path.join(root, "plugins"), legacy = path.join(userRoot, "fixture"); mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, "manifest.json"), JSON.stringify({ apiVersion: 1, id: "fixture", name: "Fixture", version: "1.0.0", description: "fixture", author: "test", entry: "index.cjs", defaultEnabled: false }));
  writeFileSync(path.join(legacy, "index.cjs"), "module.exports={register(){}};");
  return { legacy, store: new PluginVersionStore(userRoot) };
}

it("preserves the exact selection record when the atomic rename fails", async () => {
  const f = fixture(); await f.store.migrate("fixture", f.legacy);
  const before = readFileSync(f.store.recordPath("fixture"), "utf8");
  fault.rename = true;
  await expect(f.store.stage("fixture", f.legacy, { kind: "local-zip", sourceId: "local-zip" })).rejects.toThrow("atomic rename failed");
  expect(readFileSync(f.store.recordPath("fixture"), "utf8")).toBe(before);
  expect(f.store.read("fixture")?.pending).toBeNull();
});

it("rejects a directory junction inside package content before copying", async () => {
  const f = fixture(), outside = path.join(root, "outside"); mkdirSync(outside);
  writeFileSync(path.join(outside, "private"), "outside");
  symlinkSync(outside, path.join(f.legacy, "linked"), process.platform === "win32" ? "junction" : "dir");
  await expect(f.store.migrate("fixture", f.legacy)).rejects.toThrow(/[Ll]ink/);
  expect(readFileSync(path.join(outside, "private"), "utf8")).toBe("outside");
});

it.each(["rename", "copy"] as const)("discovers and collects recordless packages after first-install %s failure", async failure => {
  const f = fixture(); fault[failure] = true;
  await expect(f.store.stage("fixture", f.legacy, { kind: "local-zip", sourceId: "local-zip" })).rejects.toThrow();
  expect(f.store.read("fixture")).toBeUndefined();
  const restarted = new PluginVersionStore(f.store.userRoot);
  expect(restarted.ids()).toContain("fixture");
  for (const id of restarted.ids()) await restarted.collect(id);
  const packages = path.dirname(restarted.packageDir("fixture", "00000000-0000-0000-0000-000000000000"));
  expect(readdirSync(packages)).toEqual([]);
  expect(restarted.ids()).toEqual([]);
  expect(readFileSync(path.join(f.legacy, "index.cjs"), "utf8")).toContain("register");
});
