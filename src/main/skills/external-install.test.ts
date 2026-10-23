import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createStorageContext } from "../storage-context";
import { externalSkillId } from "./external-policy";
import { digestExternalFiles } from "./external-review";
import type { ExternalHostSession, ExternalSkillRecord } from "./external-types";
import { ExternalSkillStateStore, EXTERNAL_OWNER_MARKER, externalOwnerMarker, verifyExternalInstallation } from "./external-state";
import * as install from "./external-install";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "firefly-external-state-test-"))); roots.push(root);
  const userData = path.join(root, "Firefly-test"); fs.mkdirSync(userData);
  const storage = createStorageContext({ kind: "test", applicationName: "Firefly-test", appData: root, userData,
    sessionData: path.join(userData, "session"), logs: path.join(userData, "logs"), isolationRoot: root });
  const host: ExternalHostSession = { runId: randomUUID(), isPrimaryProcess: () => true };
  const prefix = "plugins/synthetic/skills/text", body = Buffer.from("---\nname: text\ndescription: Synthetic.\n---\nSummarize supplied text.\n");
  const files = [{ path: prefix + "/SKILL.md", blobSha1: createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex"),
    sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length }];
  const license = Buffer.from("Synthetic MIT terms.\n");
  files.push({ path: prefix + "/LICENSE", blobSha1: createHash("sha1").update(`blob ${license.length}\0`).update(license).digest("hex"), sha256: createHash("sha256").update(license).digest("hex"), bytes: license.length });
  const id = externalSkillId("openai", "openai/plugins", prefix);
  const record: ExternalSkillRecord = { schema: 1, id, transactionId: randomUUID(), status: "prepared", enabled: false,
    contentSha256: digestExternalFiles(files), skill: { id, sourceId: "openai", upstreamName: "text", description: "Synthetic.",
      bundle: { name: "synthetic", license: "MIT" }, repository: "openai/plugins", path: prefix, commit: "a".repeat(40),
      files, licenses: [{ path: files[1].path, sha256: files[1].sha256, spdx: "MIT", covers: files.map(file => file.path) }], review: "approved", blockers: [] } };
  return { root, storage, host, record, body, license, file: path.join(storage.stateRoot, "external-skills", id + ".json") };
}

function prepared(f = fixture()) {
  const state = new ExternalSkillStateStore(f.storage, f.host);
  const payload = new Map([[f.record.skill.path + "/SKILL.md", f.body], [f.record.skill.path + "/LICENSE", f.license]]);
  const stage = install.stageExternalSkill(f.storage, f.record, payload);
  const outer = path.join(f.storage.dataRoot, "skills", f.record.id);
  return { ...f, state, payload, stage, outer, content: path.join(outer, "content"), input: { storage: f.storage, state, record: f.record, stageRoot: stage.stageRoot } };
}
it("commit_order publishes a full disabled record only after reserving and publishing content", async () => {
  const f = prepared(), events: string[] = [], mkdir = fs.mkdirSync, rename = fs.renameSync;
  const create = vi.spyOn(f.state, "createPreparedExclusive");
  vi.spyOn(fs, "mkdirSync").mockImplementation((location, options) => {
    if (location === f.outer) { events.push("reserve"); expect(f.state.read(f.record.id)?.status).toBe("prepared"); expect(create).toHaveBeenCalledOnce(); }
    return mkdir(location, options as never);
  });
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === f.content) { events.push("publish"); expect(fs.readdirSync(f.outer)).toEqual([EXTERNAL_OWNER_MARKER]); }
    if (to === f.file) { events.push("state"); expect(fs.readFileSync(path.join(f.content, "SKILL.md"))).toEqual(f.body); }
    return rename(from, to);
  });
  expect(await install.commitExternalSkill(f.input)).toEqual({ id: f.record.id, enabled: false, contentSha256: f.record.contentSha256 });
  expect(events).toEqual(["reserve", "publish", "state"]); expect(f.state.read(f.record.id)?.enabled).toBe(false);
  expect(() => verifyExternalInstallation(f.storage, { ...f.record, status: "committed" })).not.toThrow();
  expect(fs.existsSync(path.dirname(f.stage.stageRoot))).toBe(false); expect(() => install.discardExternalStage(f.storage, f.stage)).not.toThrow();
});
it.each(["normal", "empty", "corrupt", "link", "case-folded"])("never_overwrite preserves a %s target byte-for-byte and mtime", async kind => {
  const f = prepared(), target = kind === "case-folded" ? path.join(path.dirname(f.outer), f.record.id.toUpperCase()) : f.outer;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (kind === "link") { const outside = path.join(f.root, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "private"), "private"); fs.symlinkSync(outside, target, process.platform === "win32" ? "junction" : "dir"); }
  else { fs.mkdirSync(target); if (kind !== "empty") fs.writeFileSync(path.join(target, "SKILL.md"), kind === "corrupt" ? "{corrupt" : "private"); }
  const before = fs.lstatSync(target), body = fs.existsSync(path.join(target, "SKILL.md")) ? fs.readFileSync(path.join(target, "SKILL.md")) : undefined;
  await expect(install.commitExternalSkill(f.input)).rejects.toMatchObject({ code: "TARGET_EXISTS" });
  expect(fs.lstatSync(target).mtimeMs).toBe(before.mtimeMs); expect(fs.lstatSync(target).ino).toBe(before.ino);
  if (body) expect(fs.readFileSync(path.join(target, "SKILL.md"))).toEqual(body);
  expect(fs.existsSync(f.file)).toBe(false);
});
it("never_overwrite detects a competitor that appears at exclusive mkdir", async () => {
  const f = prepared(), mkdir = fs.mkdirSync;
  vi.spyOn(fs, "mkdirSync").mockImplementation((location, options) => {
    if (location === f.outer) { mkdir(location); fs.writeFileSync(path.join(f.outer, "private"), "competitor"); }
    return mkdir(location, options as never);
  });
  await expect(install.commitExternalSkill(f.input)).rejects.toMatchObject({ code: "TARGET_EXISTS" });
  expect(fs.readFileSync(path.join(f.outer, "private"), "utf8")).toBe("competitor"); expect(fs.existsSync(f.file)).toBe(false);
});
it.each(["orphan", "corrupt", "enabled-committed"])("existing_state_never_replaced rejects %s without touching its bytes", async kind => {
  const f = prepared(); fs.mkdirSync(path.dirname(f.file), { recursive: true });
  const previous = kind === "corrupt" ? "{" : JSON.stringify({ ...f.record, transactionId: randomUUID(), status: "committed", enabled: kind === "enabled-committed" }, null, 2);
  fs.writeFileSync(f.file, previous); const before = fs.statSync(f.file);
  if (kind === "enabled-committed") { fs.mkdirSync(f.outer, { recursive: true }); fs.writeFileSync(path.join(f.outer, "private"), "enabled prior bytes"); }
  const remove = vi.spyOn(f.state, "removeOwned");
  await expect(install.commitExternalSkill(f.input)).rejects.toMatchObject({ code: "TARGET_EXISTS" });
  expect(fs.readFileSync(f.file, "utf8")).toBe(previous); expect(fs.statSync(f.file).mtimeMs).toBe(before.mtimeMs); expect(remove).not.toHaveBeenCalled();
  if (kind === "enabled-committed") { expect(f.state.read(f.record.id)?.enabled).toBe(true); expect(fs.readFileSync(path.join(f.outer, "private"), "utf8")).toBe("enabled prior bytes"); }
});
it.each(["missing", "changed", "extra", "prefix-escape"])("stage refuses %s payload without creating a transaction", kind => {
  const f = fixture(), payload = new Map([[f.record.skill.path + "/SKILL.md", f.body], [f.record.skill.path + "/LICENSE", f.license]]);
  if (kind === "missing") payload.delete(f.record.skill.path + "/LICENSE");
  if (kind === "changed") payload.set(f.record.skill.path + "/SKILL.md", Buffer.from("changed"));
  if (kind === "extra") payload.set(f.record.skill.path + "/../escape.md", Buffer.from("escape"));
  if (kind === "prefix-escape") { f.record.skill.files[0].path = f.record.skill.path + "-other/SKILL.md"; f.record.contentSha256 = digestExternalFiles(f.record.skill.files); }
  expect(() => install.stageExternalSkill(f.storage, f.record, payload)).toThrow(); expect(fs.existsSync(path.join(f.storage.cacheRoot, "external-skills", f.record.transactionId))).toBe(false);
});
it("stage strips only the exact repository-relative prefix and retains exact license bytes", () => {
  const f = prepared(); expect(fs.readFileSync(path.join(f.stage.stageRoot, f.record.id, "SKILL.md"))).toEqual(f.body);
  expect(fs.readFileSync(path.join(f.stage.stageRoot, f.record.id, "LICENSE"))).toEqual(f.license);
  expect(fs.readdirSync(f.stage.stageRoot)).toEqual([f.record.id]); expect(fs.existsSync(path.join(f.stage.stageRoot, "plugins"))).toBe(false);
});
it("foreign stage cleanup and unknown added files are preserved", () => {
  const f = prepared(); expect(() => install.discardExternalStage(f.storage, { ...f.stage })).toThrow("STATE_INVALID");
  fs.writeFileSync(path.join(f.stage.stageRoot, "private"), "foreign");
  expect(() => install.discardExternalStage(f.storage, f.stage)).toThrow("ROLLBACK_FAILED"); expect(fs.readFileSync(path.join(f.stage.stageRoot, "private"), "utf8")).toBe("foreign");
});
it.each(["first-state", "outer-marker", "rename", "EXDEV", "ENOSPC", "last-state"])("rollback_every_step safely rolls back %s failure", async boundary => {
  const f = prepared();
  if (boundary === "first-state") vi.spyOn(f.state, "createPreparedExclusive").mockImplementation(() => { throw new Error("injected"); });
  if (boundary === "last-state") vi.spyOn(f.state, "transitionOwned").mockImplementation(() => { throw new Error("injected"); });
  if (["rename", "EXDEV"].includes(boundary)) { const rename = fs.renameSync; vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { if (to === f.content) throw Object.assign(new Error("injected"), { code: boundary }); return rename(from, to); }); }
  if (["outer-marker", "ENOSPC"].includes(boundary)) { const open = fs.openSync; vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => { if (file === path.join(f.outer, EXTERNAL_OWNER_MARKER)) throw Object.assign(new Error("injected"), { code: boundary }); return open(file, flags, mode); }); }
  await expect(install.commitExternalSkill(f.input)).rejects.toMatchObject({ code: "STORAGE_FAILED" });
  expect(fs.existsSync(f.outer)).toBe(false); expect(fs.existsSync(f.file)).toBe(false); expect(fs.existsSync(path.dirname(f.stage.stageRoot))).toBe(false);
});
it("rollback refuses changed content and preserves its state and unknown bytes", async () => {
  const f = prepared(); vi.spyOn(f.state, "transitionOwned").mockImplementation(() => { fs.writeFileSync(path.join(f.content, "private"), "foreign"); throw new Error("injected"); });
  await expect(install.commitExternalSkill(f.input)).rejects.toMatchObject({ code: "ROLLBACK_FAILED" });
  expect(fs.readFileSync(path.join(f.content, "private"), "utf8")).toBe("foreign"); expect(f.state.read(f.record.id)?.enabled).toBe(false);
});
it("commit revalidates staged bytes, manifest and realpath immediately before publication", async () => {
  const f = prepared(); fs.writeFileSync(path.join(f.stage.stageRoot, f.record.id, "SKILL.md"), "changed");
  await expect(install.commitExternalSkill(f.input)).rejects.toMatchObject({ code: "STATE_INVALID" }); expect(fs.existsSync(f.outer)).toBe(false); expect(fs.existsSync(f.file)).toBe(false);
});
it("postcommit rescan rollback removes only the newly committed disabled transaction", async () => {
  const f = prepared(); await install.commitExternalSkill(f.input);
  const rollback = (install as Record<string, unknown>).rollbackExternalSkill;
  expect(rollback, "T4 needs an ownership-checked rollback for failed postcommit rescan").toBeTypeOf("function");
  (rollback as (input: { storage: typeof f.storage; record: ExternalSkillRecord; state: ExternalSkillStateStore }) => void)(f.input);
  expect(fs.existsSync(f.outer)).toBe(false); expect(fs.existsSync(f.file)).toBe(false);
});

it("F1: finalization releases exact rollback authority without filesystem mutation and is idempotent", async () => {
  const f = prepared(); await install.commitExternalSkill(f.input);
  const locations = [f.file, path.join(f.outer, EXTERNAL_OWNER_MARKER), path.join(f.content, "SKILL.md"), path.join(f.content, "LICENSE")];
  const before = locations.map(location => ({ bytes: fs.readFileSync(location), stat: fs.statSync(location) }));
  const mutations = [vi.spyOn(fs, "writeFileSync"), vi.spyOn(fs, "unlinkSync"), vi.spyOn(fs, "renameSync"), vi.spyOn(fs, "rmdirSync"), vi.spyOn(fs, "mkdirSync"), vi.spyOn(fs, "linkSync")];
  expect(install.finalizeExternalSkillCommit).toBeTypeOf("function");
  install.finalizeExternalSkillCommit(f.input); install.finalizeExternalSkillCommit(f.input);
  expect(() => install.rollbackExternalSkill(f.input)).toThrow("ROLLBACK_FAILED");
  for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
  for (const [index, location] of locations.entries()) {
    expect(fs.readFileSync(location)).toEqual(before[index].bytes);
    const after = fs.statSync(location); expect([after.ino, after.mtimeMs, after.ctimeMs]).toEqual([before[index].stat.ino, before[index].stat.mtimeMs, before[index].stat.ctimeMs]);
  }
  expect(f.state.read(f.record.id)).toMatchObject({ status: "committed", enabled: false });
});
it("F1: finalizing a profile leaves the same ID and transaction in another profile rollbackable", async () => {
  const first = prepared(), otherFixture = fixture(); otherFixture.record.transactionId = first.record.transactionId;
  const other = prepared(otherFixture); await install.commitExternalSkill(first.input); await install.commitExternalSkill(other.input);
  expect(install.finalizeExternalSkillCommit).toBeTypeOf("function");
  install.finalizeExternalSkillCommit(first.input);
  expect(() => install.rollbackExternalSkill(first.input)).toThrow("ROLLBACK_FAILED");
  install.rollbackExternalSkill(other.input);
  expect(fs.existsSync(other.file)).toBe(false); expect(fs.existsSync(other.outer)).toBe(false);
  expect(first.state.read(first.record.id)?.enabled).toBe(false); expect(fs.readFileSync(path.join(first.content, "SKILL.md"))).toEqual(first.body);
});
it.each(["id", "transactionId"] as const)("F1: a foreign %s cannot finalize the current transaction", async field => {
  const f = prepared(); await install.commitExternalSkill(f.input);
  const foreign = { ...f.record, [field]: field === "id" ? externalSkillId("openai", "openai/plugins", "plugins/other/skills/text") : randomUUID() };
  expect(install.finalizeExternalSkillCommit).toBeTypeOf("function");
  install.finalizeExternalSkillCommit({ storage: f.storage, record: foreign });
  install.rollbackExternalSkill(f.input);
  expect(fs.existsSync(f.file)).toBe(false); expect(fs.existsSync(f.outer)).toBe(false);
});

it.each(["foreign", "tampered", "enabled", "replaced"])("postcommit rollback refuses %s ownership and retains all bytes", async kind => {
  const f = prepared(); await install.commitExternalSkill(f.input);
  if (kind === "foreign") f.record.transactionId = randomUUID();
  if (kind === "tampered") fs.writeFileSync(path.join(f.content, "SKILL.md"), "private change");
  if (kind === "enabled") f.state.setEnabledOwned(f.record.id, f.record.transactionId, true);
  if (kind === "replaced") { fs.renameSync(f.outer, f.outer + ".original"); fs.cpSync(f.outer + ".original", f.outer, { recursive: true }); }
  const bytes = fs.readFileSync(f.file), body = fs.readFileSync(path.join(f.content, "SKILL.md")), unlink = vi.spyOn(fs, "unlinkSync");
  const rollback = (install as Record<string, unknown>).rollbackExternalSkill;
  expect(rollback).toBeTypeOf("function"); expect(() => (rollback as (input: typeof f.input) => void)(f.input)).toThrow("ROLLBACK_FAILED");
  expect(unlink).not.toHaveBeenCalled(); expect(fs.readFileSync(f.file)).toEqual(bytes); expect(fs.readFileSync(path.join(f.content, "SKILL.md"))).toEqual(body);
});

it("restart_each_boundary keeps every incomplete snapshot unavailable and complete snapshots disabled", async () => {
  const f = prepared(), snapshots: Array<{ name: string; directory: string }> = [];
  const save = (name: string) => { const directory = path.join(f.root, "snapshot-" + name); fs.cpSync(f.storage.profile.userData, directory, { recursive: true }); snapshots.push({ name, directory }); };
  save("stage-only"); const create = f.state.createPreparedExclusive.bind(f.state), transition = f.state.transitionOwned.bind(f.state), rename = fs.renameSync, mkdir = fs.mkdirSync;
  vi.spyOn(f.state, "createPreparedExclusive").mockImplementation(record => { create(record); save("prepared"); });
  vi.spyOn(fs, "mkdirSync").mockImplementation((location, options) => { const result = mkdir(location, options as never); if (location === f.outer) save("reserved"); return result; });
  vi.spyOn(f.state, "transitionOwned").mockImplementation((id, transaction, record) => { save("published"); transition(id, transaction, record); });
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { rename(from, to); if (to === f.file) save("committed-locked"); });
  await install.commitExternalSkill(f.input); save("completed"); vi.restoreAllMocks();
  for (const snapshot of snapshots) {
    fs.rmSync(f.storage.profile.userData, { recursive: true }); fs.cpSync(snapshot.directory, f.storage.profile.userData, { recursive: true });
    const state = new ExternalSkillStateStore(f.storage, { runId: randomUUID(), isPrimaryProcess: () => true }), previous = fs.existsSync(f.file) ? fs.readFileSync(f.file) : undefined;
    install.recoverExternalSkills(f.storage, state); const entry = state.read(f.record.id);
    expect(entry?.enabled ?? false, snapshot.name).toBe(false); if (previous) expect(fs.readFileSync(f.file), snapshot.name).toEqual(previous);
    if (["committed-locked", "completed"].includes(snapshot.name)) { expect(entry?.status).toBe("committed"); expect(fs.existsSync(f.file + ".lock")).toBe(false); }
    else expect(entry?.status).not.toBe("committed");
  }
});

it("commit without a primary state capability cannot create a formal directory", async () => {
  const f = prepared(), state = new ExternalSkillStateStore(f.storage);
  await expect(install.commitExternalSkill({ ...f.input, state })).rejects.toMatchObject({ code: "STATE_INVALID" });
  expect(fs.existsSync(path.join(f.storage.dataRoot, "skills"))).toBe(false); expect(fs.existsSync(f.file)).toBe(false);
});
it("actual committed-state unlock interruption is recoverable only by a fresh primary run", async () => {
  const f = prepared(), unlink = fs.unlinkSync;
  vi.spyOn(fs, "unlinkSync").mockImplementation(file => { if (file === f.file + ".lock") throw Object.assign(new Error("interrupted unlock"), { code: "EACCES" }); return unlink(file); });
  await expect(install.commitExternalSkill(f.input)).rejects.toMatchObject({ code: "ROLLBACK_FAILED" });
  vi.restoreAllMocks(); const bytes = fs.readFileSync(f.file), content = fs.readFileSync(path.join(f.content, "SKILL.md")); expect(f.state.read(f.record.id)).toBeUndefined();
  const fresh = new ExternalSkillStateStore(f.storage, { runId: randomUUID(), isPrimaryProcess: () => true }); install.recoverExternalSkills(f.storage, fresh);
  expect(fs.existsSync(f.file + ".lock")).toBe(false); expect(fs.readFileSync(f.file)).toEqual(bytes); expect(fs.readFileSync(path.join(f.content, "SKILL.md"))).toEqual(content); expect(fresh.read(f.record.id)?.enabled).toBe(false);
});

it("reimport cannot change a prior valid enabled installation or its effective body", async () => {
  const f = prepared(); await install.commitExternalSkill(f.input); f.state.setEnabledOwned(f.record.id, f.record.transactionId, true);
  const before = fs.readFileSync(f.file), body = fs.readFileSync(path.join(f.content, "SKILL.md")), mtime = fs.statSync(f.outer).mtimeMs;
  const next = { ...f.record, transactionId: randomUUID() }, stage = install.stageExternalSkill(f.storage, next, f.payload);
  await expect(install.commitExternalSkill({ ...f.input, record: next, stageRoot: stage.stageRoot })).rejects.toMatchObject({ code: "TARGET_EXISTS" });
  expect(fs.readFileSync(f.file)).toEqual(before); expect(fs.readFileSync(path.join(f.content, "SKILL.md"))).toEqual(body); expect(fs.statSync(f.outer).mtimeMs).toBe(mtime);
  const effective = f.state.read(f.record.id)!; expect(effective.enabled).toBe(true); expect(() => verifyExternalInstallation(f.storage, effective)).not.toThrow();
});

it("initial commit filesystem failure is sanitized without leaking profile paths", async () => {
  const f = prepared(), mkdir = fs.mkdirSync;
  vi.spyOn(fs, "mkdirSync").mockImplementation((location, options) => { if (location === path.join(f.storage.dataRoot, "skills")) throw new Error("failure at " + location); return mkdir(location, options as never); });
  await expect(install.commitExternalSkill(f.input)).rejects.toMatchObject({ code: "STORAGE_FAILED", message: "STORAGE_FAILED" }); expect(fs.existsSync(f.file)).toBe(false);
});
it("initial stage filesystem failure is sanitized without leaking profile paths", () => {
  const f = fixture(), mkdir = fs.mkdirSync;
  vi.spyOn(fs, "mkdirSync").mockImplementation((location, options) => { if (location === path.join(f.storage.cacheRoot, "external-skills")) throw new Error("failure at " + location); return mkdir(location, options as never); });
  expect(() => install.stageExternalSkill(f.storage, f.record, new Map([[f.record.skill.path + "/SKILL.md", f.body], [f.record.skill.path + "/LICENSE", f.license]]))).toThrow("STORAGE_FAILED");
});

it.each(["body", "marker"])("in-transaction rollback preserves rewritten identical %s bytes when identity metadata changes", async kind => {
  const f = prepared(); vi.spyOn(f.state, "transitionOwned").mockImplementation(() => {
    const location = kind === "body" ? path.join(f.content, "SKILL.md") : path.join(f.outer, EXTERNAL_OWNER_MARKER);
    fs.writeFileSync(location, fs.readFileSync(location)); fs.utimesSync(location, new Date(0), new Date(0)); throw new Error("injected");
  });
  await expect(install.commitExternalSkill(f.input)).rejects.toMatchObject({ code: "ROLLBACK_FAILED" });
  expect(fs.existsSync(f.outer)).toBe(true); expect(fs.existsSync(f.file)).toBe(true); expect(f.state.read(f.record.id)?.enabled).toBe(false);
});

it.each(["unknown-file", "replaced-marker"])("R1: post-transition success cleanup never adopts %s cache bytes", async kind => {
  const f = prepared(), transition = f.state.transitionOwned.bind(f.state), marker = path.join(path.dirname(f.stage.stageRoot), EXTERNAL_OWNER_MARKER);
  let foreignPath = "", foreignInode = 0;
  vi.spyOn(f.state, "transitionOwned").mockImplementation((id, transactionId, next) => {
    transition(id, transactionId, next);
    foreignPath = kind === "unknown-file" ? path.join(f.stage.stageRoot, "private.txt") : marker;
    if (kind === "replaced-marker") fs.renameSync(marker, path.join(f.root, "preserved-stage-marker"));
    fs.writeFileSync(foreignPath, "foreign cache bytes"); foreignInode = fs.lstatSync(foreignPath).ino;
  });
  const unlink = vi.spyOn(fs, "unlinkSync");
  await expect(install.commitExternalSkill(f.input)).rejects.toMatchObject({ code: "ROLLBACK_FAILED" });
  expect(fs.readFileSync(foreignPath, "utf8")).toBe("foreign cache bytes"); expect(fs.lstatSync(foreignPath).ino).toBe(foreignInode);
  expect(unlink.mock.calls.some(call => call[0] === foreignPath)).toBe(false); expect(fs.existsSync(path.dirname(f.stage.stageRoot))).toBe(true);
});
