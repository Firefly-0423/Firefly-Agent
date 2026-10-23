import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { PluginVersionStore, type PackageSource } from "./version-store";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "firefly-versions-")); roots.push(root);
  const userRoot = path.join(root, "plugins"); mkdirSync(userRoot);
  const legacy = path.join(userRoot, "fixture"); mkdirSync(legacy);
  writeFileSync(path.join(legacy, "manifest.json"), JSON.stringify({ apiVersion: 1, id: "fixture", name: "Fixture", version: "1.0.0", description: "fixture", author: "test", entry: "index.cjs", defaultEnabled: false }));
  writeFileSync(path.join(legacy, "index.cjs"), "module.exports={register(){}};");
  return { root, userRoot, legacy, store: new PluginVersionStore(userRoot) };
}

it("migrates by copying, preserves legacy files and marks unknown provenance", async () => {
  const f = fixture(), before = readFileSync(path.join(f.legacy, "manifest.json"), "utf8");
  const state = await f.store.migrate("fixture", f.legacy);
  expect(state.selected?.source.kind).toBe("legacy-unknown");
  expect(state.selected?.version).toBe("1.0.0");
  expect(f.store.packageDir("fixture", state.selected!.key)).not.toBe(f.legacy);
  expect(readFileSync(path.join(f.legacy, "manifest.json"), "utf8")).toBe(before);
  expect(await f.store.migrate("fixture", f.legacy)).toEqual(state);
});

it("stages a new immutable version without changing the selection; recovery restores the old version", async () => {
  const f = fixture(), old = await f.store.migrate("fixture", f.legacy);
  const staged = path.join(f.root, "candidate"); mkdirSync(staged);
  const manifest = JSON.parse(readFileSync(path.join(f.legacy, "manifest.json"), "utf8"));
  writeFileSync(path.join(staged, "manifest.json"), JSON.stringify({ ...manifest, version: "2.0.0" }));
  writeFileSync(path.join(staged, "index.cjs"), "module.exports={register(){throw Error('fixture')}};");
  const pending = await f.store.stage("fixture", staged, { kind: "local-zip", sourceId: "local-zip" });
  expect(pending.selected).toEqual(old.selected);
  expect(pending.pending?.version).toBe("2.0.0");
  await f.store.beginActivation("fixture");
  const restarted = new PluginVersionStore(f.userRoot);
  await restarted.recoverInterrupted("fixture");
  expect(restarted.read("fixture")?.selected).toEqual(old.selected);
  expect(restarted.read("fixture")?.pending).toBeNull();
  expect(restarted.read("fixture")?.error).toMatch(/interrupt/i);
  expect(existsSync(restarted.packageDir("fixture", pending.pending!.key))).toBe(true);
});

it("rejects tampering, unsafe IDs and malformed state instead of falling back to legacy", async () => {
  const f = fixture(), state = await f.store.migrate("fixture", f.legacy);
  writeFileSync(path.join(f.store.packageDir("fixture", state.selected!.key), "index.cjs"), "tampered");
  await expect(f.store.validate("fixture", state.selected!)).rejects.toThrow(/digest/i);
  expect(() => f.store.read("../escape")).toThrow();
  writeFileSync(f.store.recordPath("fixture"), "{broken");
  expect(() => f.store.read("fixture")).toThrow();
  await expect(f.store.migrate("fixture", f.legacy)).rejects.toThrow();
});

it("selects a validated pending version and retains exactly the previous selection", async () => {
  const f = fixture(), old = await f.store.migrate("fixture", f.legacy);
  const pending = await f.store.stage("fixture", f.legacy, { kind: "local-zip", sourceId: "local-zip" });
  await f.store.beginActivation("fixture");
  const ready = await f.store.finishActivation("fixture");
  expect(ready.selected).toEqual(pending.pending);
  expect(ready.previous).toEqual(old.selected);
  expect(ready.pending).toBeNull();
  expect(ready.phase).toBe("ready");
});

it("refuses a controlled source takeover before changing the record", async () => {
  const f = fixture();
  await f.store.stage("fixture", f.legacy, { kind: "curated-market", sourceId: "https://example.com/approved" });
  await f.store.beginActivation("fixture"); await f.store.finishActivation("fixture");
  const before = readFileSync(f.store.recordPath("fixture"), "utf8");
  await expect(f.store.stage("fixture", f.legacy, { kind: "local-zip", sourceId: "local-zip" })).rejects.toThrow(/source/i);
  expect(readFileSync(f.store.recordPath("fixture"), "utf8")).toBe(before);
});

it.each(["local-zip", "bundled"] as const)("stages a specifically confirmed %s package replacement into an online source", async kind => {
  const f = fixture();
  const from: PackageSource = { kind, sourceId: kind === "bundled" ? "bundled:registry" : "local-zip", archiveSha256: "a".repeat(64) };
  await f.store.stage("fixture", f.legacy, from);
  await f.store.beginActivation("fixture"); const before = await f.store.finishActivation("fixture");
  const to: PackageSource = { kind: "curated-market", sourceId: "https://example.com/approved", archiveSha256: "b".repeat(64) };
  const state = await f.store.stage("fixture", f.legacy, to, {
    confirmedSourceReplacement: { selectedKey: before.selected!.key, from, to },
  });
  expect(state.selected).toEqual(before.selected);
  expect(state.pending?.source).toEqual(to);
  await f.store.beginActivation("fixture");
  const restored = await f.store.failActivation("fixture", "synthetic candidate failure");
  expect(restored.selected).toEqual(before.selected);
  expect(restored.selected?.source).toEqual(from);
  expect(restored.pending).toBeNull();
});

it.each(["missing", "stale-selection", "wrong-old-source", "wrong-new-source", "wrong-archive"])("refuses an unbound source replacement approval (%s) without changing state", async kind => {
  const f = fixture();
  const from: PackageSource = { kind: "local-zip", sourceId: "local-zip", archiveSha256: "a".repeat(64) };
  await f.store.stage("fixture", f.legacy, from);
  await f.store.beginActivation("fixture"); const selected = (await f.store.finishActivation("fixture")).selected!;
  const to: PackageSource = { kind: "curated-market", sourceId: "https://example.com/approved", archiveSha256: "b".repeat(64) };
  const approval = { selectedKey: selected.key, from: { ...from }, to: { ...to } };
  if (kind === "stale-selection") approval.selectedKey = "00000000-0000-0000-0000-000000000000";
  if (kind === "wrong-old-source") approval.from.sourceId = "other-local-source";
  if (kind === "wrong-new-source") approval.to.sourceId = "https://example.com/other";
  if (kind === "wrong-archive") approval.to.archiveSha256 = "c".repeat(64);
  const before = readFileSync(f.store.recordPath("fixture"), "utf8");
  await expect(f.store.stage("fixture", f.legacy, to, { confirmedSourceReplacement: kind === "missing" ? undefined : approval })).rejects.toThrow(/source/i);
  expect(readFileSync(f.store.recordPath("fixture"), "utf8")).toBe(before);
});

it.each(["local-zip", "curated-market"] as const)("does not authorize a curated source takeover to %s", async kind => {
  const f = fixture();
  const from: PackageSource = { kind: "curated-market", sourceId: "https://example.com/approved", archiveSha256: "a".repeat(64) };
  await f.store.stage("fixture", f.legacy, from);
  await f.store.beginActivation("fixture"); const selected = (await f.store.finishActivation("fixture")).selected!;
  const to: PackageSource = { kind, sourceId: "different-source", archiveSha256: "b".repeat(64) };
  const before = readFileSync(f.store.recordPath("fixture"), "utf8");
  await expect(f.store.stage("fixture", f.legacy, to, { confirmedSourceReplacement: { selectedKey: selected.key, from, to } })).rejects.toThrow(/source/i);
  expect(readFileSync(f.store.recordPath("fixture"), "utf8")).toBe(before);
});

it("collects only unreferenced package versions and defers uninstall code deletion until recovery", async () => {
  const f = fixture(), old = await f.store.migrate("fixture", f.legacy);
  await f.store.stage("fixture", f.legacy, { kind: "local-zip", sourceId: "local-zip" });
  await f.store.beginActivation("fixture"); await f.store.finishActivation("fixture");
  await f.store.stage("fixture", f.legacy, { kind: "local-zip", sourceId: "local-zip" });
  await f.store.beginActivation("fixture"); const current = await f.store.finishActivation("fixture");
  await f.store.collect("fixture");
  expect(existsSync(f.store.packageDir("fixture", old.selected!.key))).toBe(false);
  expect(existsSync(f.store.packageDir("fixture", current.previous!.key))).toBe(true);
  await f.store.uninstall("fixture");
  expect(existsSync(f.store.packageDir("fixture", current.selected!.key))).toBe(true);
  await f.store.collect("fixture");
  expect(existsSync(f.store.packageDir("fixture", current.selected!.key))).toBe(false);
  expect(existsSync(f.legacy)).toBe(false);
});

it("collects the actual migrated directory without touching a different directory named after its ID", async () => {
  const f = fixture(), actual = path.join(f.userRoot, "custom-folder");
  renameSync(f.legacy, actual);
  mkdirSync(f.legacy); writeFileSync(path.join(f.legacy, "keep"), "unrelated");
  await f.store.migrate("fixture", actual);
  await f.store.stage("fixture", actual, { kind: "local-zip", sourceId: "local-zip" });
  await f.store.uninstall("fixture"); await f.store.collect("fixture");
  expect(existsSync(actual)).toBe(false);
  expect(readFileSync(path.join(f.legacy, "keep"), "utf8")).toBe("unrelated");
});

it("preserves a migrated directory whose contents were subsequently replaced", async () => {
  const f = fixture(); await f.store.migrate("fixture", f.legacy);
  writeFileSync(path.join(f.legacy, "index.cjs"), "replacement contents");
  await f.store.uninstall("fixture");
  await expect(f.store.collect("fixture")).rejects.toThrow(/legacy/i);
  expect(readFileSync(path.join(f.legacy, "index.cjs"), "utf8")).toBe("replacement contents");
});
