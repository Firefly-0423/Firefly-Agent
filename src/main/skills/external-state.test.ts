import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
// Real SQLite / filesystem integration cases: the 5 s default is too tight on CI runners, so this file allows 30 s. Other files keep the default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import { probeFileSymlink, Win32SymlinkError } from "../../../scripts/verify/file-symlink-probe";
import { createStorageContext } from "../storage-context";
import { externalSkillId } from "./external-policy";
import { digestExternalFiles } from "./external-review";
import type { ExternalHostSession, ExternalSkillRecord } from "./external-types";

const modules = import.meta.glob<typeof import("./external-state")>("./external-state.ts");
async function subject() {
  const load = modules["./external-state.ts"];
  expect(load, "Main must provide exclusive, owned external state transactions").toBeTypeOf("function");
  return load();
}
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
export function stateFixture() {
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

it("existing_state_never_replaced: preserves orphan state bytes and mtime", async () => {
  const { ExternalSkillStateStore } = await subject(), f = stateFixture();
  fs.mkdirSync(path.dirname(f.file)); fs.writeFileSync(f.file, "{orphan state");
  const before = fs.statSync(f.file), bytes = fs.readFileSync(f.file);
  const state = new ExternalSkillStateStore(f.storage, f.host);
  expect(() => state.createPreparedExclusive(f.record)).toThrow("TARGET_EXISTS");
  expect(fs.readFileSync(f.file)).toEqual(bytes); expect(fs.statSync(f.file).mtimeMs).toBe(before.mtimeMs);
});
it("first prepared publication is wx, flushed and exclusive even with a competing state file", async () => {
  const { ExternalSkillStateStore } = await subject(), f = stateFixture(), original = fs.linkSync;
  const link = vi.spyOn(fs, "linkSync").mockImplementation((from, to) => { fs.writeFileSync(to, "competitor", { flag: "wx" }); return original(from, to); });
  const writes = vi.spyOn(fs, "writeFileSync"), opens = vi.spyOn(fs, "openSync"), sync = vi.spyOn(fs, "fsyncSync"), state = new ExternalSkillStateStore(f.storage, f.host), remove = vi.spyOn(state, "removeOwned");
  expect(() => state.createPreparedExclusive(f.record)).toThrow("TARGET_EXISTS");
  expect(link).toHaveBeenCalledOnce(); expect(fs.readFileSync(f.file, "utf8")).toBe("competitor"); expect(remove).not.toHaveBeenCalled();
  expect(opens.mock.calls.some(call => typeof call[0] === "string" && call[0].endsWith(".prepared") && call[1] === "wx")).toBe(true); expect(sync).toHaveBeenCalled();
  expect(writes.mock.calls.some(call => typeof call[2] === "object" && call[2]?.flush === true)).toBe(true);
});
it("only owned transitions may commit or enable and a lock blocks all reads", async () => {
  const { ExternalSkillStateStore } = await subject(), f = stateFixture(), state = new ExternalSkillStateStore(f.storage, f.host);
  state.createPreparedExclusive(f.record); expect(state.read(f.record.id)?.enabled).toBe(false);
  expect(() => state.transitionOwned(f.record.id, "unknown", { ...f.record, status: "committed" })).toThrow("STATE_INVALID");
  const { stageExternalSkill, commitExternalSkill } = await import("./external-install");
  // This test has already created the prepared state, so publish fixture content without re-importing state.
  const outer = path.join(f.storage.dataRoot, "skills", f.record.id); fs.mkdirSync(path.join(outer, "content"), { recursive: true });
  fs.writeFileSync(path.join(outer, "content", "SKILL.md"), f.body); fs.writeFileSync(path.join(outer, "content", "LICENSE"), f.license);
  const { externalOwnerMarker, EXTERNAL_OWNER_MARKER } = await import("./external-state");
  fs.writeFileSync(path.join(outer, EXTERNAL_OWNER_MARKER), JSON.stringify(externalOwnerMarker(f.storage, f.record)));
  void stageExternalSkill; void commitExternalSkill;
  state.transitionOwned(f.record.id, f.record.transactionId, { ...f.record, status: "committed" });
  state.setEnabledOwned(f.record.id, f.record.transactionId, true); expect(state.read(f.record.id)?.enabled).toBe(true);
  fs.writeFileSync(f.file + ".lock", "unknown"); expect(state.read(f.record.id)).toBeUndefined();
  expect(() => state.setEnabledOwned(f.record.id, f.record.transactionId, false)).toThrow("STATE_INVALID");
});

async function committedFixture() {
  const { ExternalSkillStateStore } = await subject(), f = stateFixture();
  const { stageExternalSkill, commitExternalSkill } = await import("./external-install");
  const state = new ExternalSkillStateStore(f.storage, f.host), payload = new Map([[f.record.skill.path + "/SKILL.md", f.body], [f.record.skill.path + "/LICENSE", f.license]]);
  const stage = stageExternalSkill(f.storage, f.record, payload); await commitExternalSkill({ storage: f.storage, state, record: f.record, stageRoot: stage.stageRoot });
  const recordBytes = fs.readFileSync(f.file), committed = { ...f.record, status: "committed" as const };
  const lock = { schema: 1, kind: "external-skill-state-lock", profileKey: (await import("./external-state")).externalProfileKey(f.storage), id: f.record.id,
    transactionId: f.record.transactionId, hostRunId: f.host.runId, operation: "transition", beforeSha256: createHash("sha256").update(JSON.stringify(f.record, null, 2)).digest("hex"), afterSha256: createHash("sha256").update(recordBytes).digest("hex") };
  return { ...f, state, committed, lock, recordBytes, outer: path.join(f.storage.dataRoot, "skills", f.record.id), content: path.join(f.storage.dataRoot, "skills", f.record.id, "content") };
}
async function runtimeBody(f: Awaited<ReturnType<typeof committedFixture>>, state: InstanceType<Awaited<ReturnType<typeof subject>>["ExternalSkillStateStore"]>) {
  const record = state.read(f.record.id); if (!record?.enabled || record.status !== "committed") return null;
  try { (await import("./external-state")).verifyExternalInstallation(f.storage, record); return fs.readFileSync(path.join(f.content, "SKILL.md"), "utf8"); } catch { return null; }
}
it.each(["transition-after", "enable-before"])("owned_stale_lock_recovery releases a proven previous-run %s lock without enabling or rewriting", async operation => {
  const f = await committedFixture(), { ExternalSkillStateStore } = await subject(), { recoverExternalSkills } = await import("./external-install");
  const lock = operation === "enable-before" ? { ...f.lock, operation: "set-enabled", beforeSha256: f.lock.afterSha256, afterSha256: createHash("sha256").update(JSON.stringify({ ...f.committed, enabled: true }, null, 2)).digest("hex") } : f.lock;
  fs.writeFileSync(f.file + ".lock", JSON.stringify(lock)); const markerBytes = fs.readFileSync(path.join(f.outer, ".external-skill-owner.json")), bodyBytes = fs.readFileSync(path.join(f.content, "SKILL.md"));
  const state = new ExternalSkillStateStore(f.storage, { runId: randomUUID(), isPrimaryProcess: () => true });
  recoverExternalSkills(f.storage, state); expect(fs.existsSync(f.file + ".lock")).toBe(false);
  expect(fs.readFileSync(f.file)).toEqual(f.recordBytes); expect(fs.readFileSync(path.join(f.content, "SKILL.md"))).toEqual(bodyBytes); expect(fs.readFileSync(path.join(f.outer, ".external-skill-owner.json"))).toEqual(markerBytes);
  expect(state.read(f.record.id)?.enabled).toBe(false); expect(await runtimeBody(f, state)).toBeNull();
  state.setEnabledOwned(f.record.id, f.record.transactionId, true); expect(await runtimeBody(f, state)).toContain("Summarize supplied text");
});
function createLinkedLock(target: string, link: string, context: { skip(reason?: string): unknown }, probe = probeFileSymlink): boolean {
  // Only the strict native probe can establish 1314; ambiguous Node EPERM must fail.
  const capability = probe(target, link);
  if (!capability.supported) { context.skip(capability.reason); return false; }
  // The probe removes its link. A subsequent fixture creation failure is never a skip.
  fs.symlinkSync(target, link);
  return true;
}
it("linked-lock fixture skips only confirmed native creation error 1314", () => {
  const error = Object.assign(new Win32SymlinkError(1314), { code: "EPERM" }), skip = vi.fn();
  const create = vi.spyOn(fs, "symlinkSync");
  const probe = () => probeFileSymlink("target", "link", { create: () => { throw error; }, remove: vi.fn() });
  expect(createLinkedLock("target", "link", { skip }, probe)).toBe(false);
  expect(skip).toHaveBeenCalledExactlyOnceWith("Windows file symlink unavailable: ERROR_PRIVILEGE_NOT_HELD (1314)");
  expect(create).not.toHaveBeenCalled();
});
const linkedLockErrors = [
  ["native access denied 5", Object.assign(new Win32SymlinkError(5), { code: "EPERM" })],
  ["ambiguous Node EPERM", Object.assign(new Error("unconfirmed"), { code: "EPERM" })],
  ["Node EACCES", Object.assign(new Error("denied"), { code: "EACCES" })],
  ["native invalid parameter 87", new Win32SymlinkError(87)],
] as const;
it.each(linkedLockErrors)("linked-lock fixture propagates %s without skipping", (_name, error) => {
  const skip = vi.fn(); vi.spyOn(fs, "symlinkSync").mockImplementation(() => { throw error; });
  const probe = () => probeFileSymlink("target", "link", { create: () => { throw error; }, remove: vi.fn() });
  expect(() => createLinkedLock("target", "link", { skip }, probe)).toThrow(error);
  expect(skip).not.toHaveBeenCalled();
});
it("linked-lock fixture propagates probe cleanup error 1314 without skipping", () => {
  const error = Object.assign(new Win32SymlinkError(1314), { code: "EPERM" }), skip = vi.fn();
  vi.spyOn(fs, "symlinkSync").mockImplementation(() => { throw error; });
  const probe = () => probeFileSymlink("target", "link", { create: vi.fn(), remove: () => { throw error; } });
  expect(() => createLinkedLock("target", "link", { skip }, probe)).toThrow(error);
  expect(skip).not.toHaveBeenCalled();
});
it("linked-lock fixture propagates creation EPERM after a successful probe", () => {
  const error = Object.assign(new Error("fixture denied"), { code: "EPERM" }), skip = vi.fn();
  vi.spyOn(fs, "symlinkSync").mockImplementation(() => { throw error; });
  const probe = () => probeFileSymlink("target", "link", { create: vi.fn(), remove: vi.fn() });
  expect(() => createLinkedLock("target", "link", { skip }, probe)).toThrow(error);
  expect(skip).not.toHaveBeenCalled();
});

const invalidLocks = ["unknown", "corrupt", "legacy", "oversized", "linked", "profile", "id", "transaction", "record-sha", "content-sha", "marker", "prepared", "missing-record", "corrupt-record", "bak-only", "enabled", "current-run", "active-writer", "secondary", "no-host"] as const;
it.for(invalidLocks)("stale_lock_fail_closed preserves %s lock and all remaining bytes", async (kind, context) => {
  const f = await committedFixture(), { ExternalSkillStateStore } = await subject(), { recoverExternalSkills } = await import("./external-install");
  let lock: Record<string, unknown> = { ...f.lock }, lockBytes: string | undefined;
  const host = { runId: randomUUID(), isPrimaryProcess: () => kind !== "secondary" };
  if (kind === "unknown") lock.extra = "unrecognized";
  if (kind === "corrupt") lockBytes = "{";
  if (kind === "legacy") lock = { pid: 999999999, acquiredAt: 0 };
  if (kind === "oversized") lockBytes = " ".repeat(16385);
  if (kind === "profile") lock.profileKey = "f".repeat(64);
  if (kind === "id") lock.id = f.record.id.replace(/.$/, f.record.id.endsWith("0") ? "1" : "0");
  if (kind === "transaction") lock.transactionId = randomUUID();
  if (kind === "record-sha") { lock.beforeSha256 = "f".repeat(64); lock.afterSha256 = "f".repeat(64); }
  if (kind === "content-sha") fs.writeFileSync(path.join(f.content, "SKILL.md"), "modified");
  if (kind === "marker") fs.writeFileSync(path.join(f.outer, ".external-skill-owner.json"), JSON.stringify({ ...f.lock, kind: "foreign" }));
  if (kind === "prepared") fs.writeFileSync(f.file, JSON.stringify(f.record, null, 2));
  if (kind === "missing-record") fs.unlinkSync(f.file);
  if (kind === "corrupt-record") fs.writeFileSync(f.file, "{");
  if (kind === "bak-only") { fs.renameSync(f.file, f.file + ".bak"); }
  if (kind === "enabled") { const bytes = JSON.stringify({ ...f.committed, enabled: true }, null, 2); fs.writeFileSync(f.file, bytes); lock.afterSha256 = createHash("sha256").update(bytes).digest("hex"); }
  if (kind === "current-run") lock.hostRunId = host.runId;
  const bytes = lockBytes ?? JSON.stringify(lock); fs.writeFileSync(f.file + ".lock", bytes);
  if (kind === "linked") {
    fs.renameSync(f.file + ".lock", f.file + ".foreign-lock");
    if (!createLinkedLock(f.file + ".foreign-lock", f.file + ".lock", context)) return;
  }
  const beforeRecord = fs.existsSync(f.file) ? fs.readFileSync(f.file) : undefined, beforeLock = fs.readFileSync(f.file + ".lock"), unlink = vi.spyOn(fs, "unlinkSync");
  const state = kind === "active-writer" ? f.state : new ExternalSkillStateStore(f.storage, kind === "no-host" ? undefined : host);
  recoverExternalSkills(f.storage, state); expect(unlink).not.toHaveBeenCalled(); expect(fs.readFileSync(f.file + ".lock")).toEqual(beforeLock);
  if (beforeRecord) expect(fs.readFileSync(f.file)).toEqual(beforeRecord); expect(await runtimeBody(f, state)).toBeNull();
  expect(() => state.setEnabledOwned(f.record.id, f.record.transactionId, true)).toThrow("STATE_INVALID"); expect(state.getDiagnostic(f.record.id)).toBeDefined();
});
it("ordinary reads and enable retries cannot release even a fully proven ancient lock", async () => {
  const f = await committedFixture(), { ExternalSkillStateStore } = await subject(); fs.writeFileSync(f.file + ".lock", JSON.stringify(f.lock));
  fs.utimesSync(f.file + ".lock", new Date(0), new Date(0)); const state = new ExternalSkillStateStore(f.storage, { runId: randomUUID(), isPrimaryProcess: () => true }), unlink = vi.spyOn(fs, "unlinkSync");
  expect(state.read(f.record.id)).toBeUndefined(); expect(() => state.setEnabledOwned(f.record.id, f.record.transactionId, true)).toThrow("STATE_INVALID"); expect(unlink).not.toHaveBeenCalled();
});
it.each(["lock", "record", "marker", "parent"])("lock_identity_race preserves a replaced %s during final proof verification", async kind => {
  const f = await committedFixture(), { ExternalSkillStateStore } = await subject(), { recoverExternalSkills } = await import("./external-install");
  fs.writeFileSync(f.file + ".lock", JSON.stringify(f.lock));
  const selected = kind === "lock" ? f.file + ".lock" : kind === "record" ? f.file : kind === "marker" ? path.join(f.outer, ".external-skill-owner.json") : f.outer;
  const lstat = fs.lstatSync; let calls = 0, replaced = false;
  vi.spyOn(fs, "lstatSync").mockImplementation((location, options) => {
    if (String(location) === selected && ++calls === (kind === "record" ? 5 : kind === "parent" ? 7 : 3)) {
      fs.renameSync(selected, selected + ".preserved");
      if (kind === "parent") { fs.mkdirSync(selected); fs.writeFileSync(path.join(selected, "private"), "replacement"); }
      else fs.writeFileSync(selected, fs.readFileSync(selected + ".preserved")); replaced = true;
    }
    return lstat(location, options as never);
  });
  const state = new ExternalSkillStateStore(f.storage, { runId: randomUUID(), isPrimaryProcess: () => true }), unlink = vi.spyOn(fs, "unlinkSync");
  recoverExternalSkills(f.storage, state); expect(replaced).toBe(true); expect(unlink).not.toHaveBeenCalled(); expect(fs.existsSync(f.file + ".lock")).toBe(true); expect(state.getDiagnostic(f.record.id)).toBeDefined();
  expect(await runtimeBody(f, state)).toBeNull();
});
it("without a host capability the state store is read-only", async () => {
  const f = stateFixture(), { ExternalSkillStateStore } = await subject(); expect(() => new ExternalSkillStateStore(f.storage).createPreparedExclusive(f.record)).toThrow("STATE_INVALID");
  expect(fs.existsSync(f.file)).toBe(false);
});
it("first prepared publication refuses orphan backup and unsupported hard links", async () => {
  const f = stateFixture(), { ExternalSkillStateStore } = await subject(), state = new ExternalSkillStateStore(f.storage, f.host);
  fs.mkdirSync(path.dirname(f.file)); fs.writeFileSync(f.file + ".bak", "prior backup");
  expect(() => state.createPreparedExclusive(f.record)).toThrow("TARGET_EXISTS"); expect(fs.readFileSync(f.file + ".bak", "utf8")).toBe("prior backup");
  fs.unlinkSync(f.file + ".bak"); vi.spyOn(fs, "linkSync").mockImplementation(() => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); });
  expect(() => state.createPreparedExclusive(f.record)).toThrow("STORAGE_FAILED"); expect(fs.readdirSync(path.dirname(f.file))).toEqual([]);
});

it("a failed writer never removes a replacement of its initially empty lock", async () => {
  const f = stateFixture(), { ExternalSkillStateStore } = await subject(), state = new ExternalSkillStateStore(f.storage, f.host);
  state.createPreparedExclusive(f.record); const read = fs.readFileSync; let replaced = false;
  vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
    if (file === f.file && !replaced) { fs.renameSync(f.file + ".lock", f.file + ".owned-lock"); fs.writeFileSync(f.file + ".lock", "foreign lock"); replaced = true; }
    return read(file, options as never);
  });
  expect(() => state.removeOwned(f.record.id, randomUUID())).toThrow("STATE_INVALID");
  expect(fs.readFileSync(f.file + ".lock", "utf8")).toBe("foreign lock"); expect(fs.existsSync(f.file)).toBe(true);
});
it("first prepared flush failure cleans only its owned partial temporary", async () => {
  const f = stateFixture(), { ExternalSkillStateStore } = await subject(), state = new ExternalSkillStateStore(f.storage, f.host), write = fs.writeFileSync;
  vi.spyOn(fs, "writeFileSync").mockImplementation((file, bytes, options) => {
    if ((typeof file === "string" && file.endsWith(".prepared")) || typeof file === "number") { write(file, "partial", options); throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); }
    return write(file, bytes, options);
  });
  expect(() => state.createPreparedExclusive(f.record)).toThrow("STORAGE_FAILED"); expect(fs.readdirSync(path.dirname(f.file))).toEqual([]);
});

it("corrupt UTF-8 and unknown record fields remain preserved and unreadable", async () => {
  const f = stateFixture(), { ExternalSkillStateStore } = await subject(), state = new ExternalSkillStateStore(f.storage, f.host);
  state.createPreparedExclusive(f.record);
  const unknown = JSON.stringify({ ...f.record, unexpected: "foreign format" }, null, 2); fs.writeFileSync(f.file, unknown);
  expect(state.read(f.record.id)).toBeUndefined(); expect(fs.readFileSync(f.file, "utf8")).toBe(unknown);
  const bytes = Buffer.from(JSON.stringify(f.record, null, 2)), position = bytes.indexOf("Synthetic."); bytes[position] = 255; fs.writeFileSync(f.file, bytes);
  expect(state.read(f.record.id)).toBeUndefined(); expect(fs.readFileSync(f.file)).toEqual(bytes);
});
it.each(["lock", "record", "marker", "content"])("stale_lock_fail_closed rejects hardlinked %s proof", async kind => {
  const f = await committedFixture(), { ExternalSkillStateStore } = await subject(), { recoverExternalSkills } = await import("./external-install");
  fs.writeFileSync(f.file + ".lock", JSON.stringify(f.lock));
  const selected = kind === "lock" ? f.file + ".lock" : kind === "record" ? f.file : kind === "marker" ? path.join(f.outer, ".external-skill-owner.json") : path.join(f.content, "SKILL.md");
  fs.linkSync(selected, path.join(f.root, "outside-hardlink")); const unlink = vi.spyOn(fs, "unlinkSync"), state = new ExternalSkillStateStore(f.storage, { runId: randomUUID(), isPrimaryProcess: () => true });
  recoverExternalSkills(f.storage, state); expect(unlink).not.toHaveBeenCalled(); expect(state.getDiagnostic(f.record.id)).toBeDefined(); expect(fs.existsSync(f.file + ".lock")).toBe(true);
});
it("case aliases of an existing lock block ordinary reads and writer acquisition", async () => {
  const f = await committedFixture(), { ExternalSkillStateStore } = await subject();
  const lock = path.join(path.dirname(f.file), path.basename(f.file + ".lock").toUpperCase()); fs.writeFileSync(lock, "unknown");
  const state = new ExternalSkillStateStore(f.storage, { runId: randomUUID(), isPrimaryProcess: () => true });
  expect(state.read(f.record.id)).toBeUndefined(); expect(() => state.setEnabledOwned(f.record.id, f.record.transactionId, true)).toThrow("STATE_INVALID"); expect(fs.readFileSync(lock, "utf8")).toBe("unknown");
});

it("owned transitions preserve an unrecognized existing backup and the current record", async () => {
  const f = await committedFixture(), bytes = fs.readFileSync(f.file); fs.writeFileSync(f.file + ".bak", "{unrecognized backup");
  expect(() => f.state.setEnabledOwned(f.record.id, f.record.transactionId, true)).toThrow("STATE_INVALID");
  expect(fs.readFileSync(f.file)).toEqual(bytes); expect(fs.readFileSync(f.file + ".bak", "utf8")).toBe("{unrecognized backup");
});
it("residual recovery succeeds when injected state/data/cache roots are distinct", async () => {
  const f = stateFixture(), { ExternalSkillStateStore } = await subject(), { stageExternalSkill, commitExternalSkill, recoverExternalSkills } = await import("./external-install");
  const storage = { ...f.storage, dataRoot: path.join(f.storage.profile.userData, "data"), stateRoot: path.join(f.storage.profile.userData, "state"), cacheRoot: path.join(f.storage.profile.userData, "cache-distinct") };
  [storage.dataRoot, storage.stateRoot, storage.cacheRoot].forEach(directory => fs.mkdirSync(directory)); const state = new ExternalSkillStateStore(storage, f.host);
  const stage = stageExternalSkill(storage, f.record, new Map([[f.record.skill.path + "/SKILL.md", f.body], [f.record.skill.path + "/LICENSE", f.license]]));
  await commitExternalSkill({ storage, state, record: f.record, stageRoot: stage.stageRoot });
  const file = path.join(storage.stateRoot, "external-skills", f.record.id + ".json"), bytes = fs.readFileSync(file);
  fs.writeFileSync(file + ".lock", JSON.stringify({ schema: 1, kind: "external-skill-state-lock", profileKey: (await import("./external-state")).externalProfileKey(storage),
    id: f.record.id, transactionId: f.record.transactionId, hostRunId: f.host.runId, operation: "set-enabled", beforeSha256: createHash("sha256").update(bytes).digest("hex"), afterSha256: "f".repeat(64) }));
  const fresh = new ExternalSkillStateStore(storage, { runId: randomUUID(), isPrimaryProcess: () => true }); recoverExternalSkills(storage, fresh);
  expect(fs.existsSync(file + ".lock")).toBe(false); expect(fs.readFileSync(file)).toEqual(bytes); expect(fresh.read(f.record.id)?.enabled).toBe(false);
});

it("zero-age prior-run locks with a reused diagnostic PID still require full proofs", async () => {
  const f = await committedFixture(), { ExternalSkillStateStore } = await subject(), { recoverExternalSkills } = await import("./external-install");
  fs.writeFileSync(f.file + ".lock", JSON.stringify({ ...f.lock, pid: process.pid, createdAt: Date.now() }));
  const fresh = new ExternalSkillStateStore(f.storage, { runId: randomUUID(), isPrimaryProcess: () => true }); recoverExternalSkills(f.storage, fresh);
  expect(fs.existsSync(f.file + ".lock")).toBe(false); expect(fs.readFileSync(f.file)).toEqual(f.recordBytes); expect(fresh.read(f.record.id)?.enabled).toBe(false);
});
it("a failed startup unlink preserves the exact lock and records STATE_INVALID", async () => {
  const f = await committedFixture(), { ExternalSkillStateStore } = await subject(), { recoverExternalSkills } = await import("./external-install");
  const bytes = JSON.stringify(f.lock); fs.writeFileSync(f.file + ".lock", bytes);
  vi.spyOn(fs, "unlinkSync").mockImplementation(() => { throw Object.assign(new Error("blocked"), { code: "EACCES" }); });
  const state = new ExternalSkillStateStore(f.storage, { runId: randomUUID(), isPrimaryProcess: () => true }); recoverExternalSkills(f.storage, state);
  expect(fs.readFileSync(f.file + ".lock", "utf8")).toBe(bytes); expect(fs.readFileSync(f.file)).toEqual(f.recordBytes); expect(state.getDiagnostic(f.record.id)?.code).toBe("STATE_INVALID");
});

it("lock_identity_race notices a new hardlink created after initial proof validation", async () => {
  const f = await committedFixture(), { ExternalSkillStateStore } = await subject(), { recoverExternalSkills } = await import("./external-install");
  fs.writeFileSync(f.file + ".lock", JSON.stringify(f.lock)); const read = fs.readFileSync; let linked = false;
  vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
    if (file === path.join(f.outer, ".external-skill-owner.json") && !linked) { fs.linkSync(f.file + ".lock", path.join(f.root, "late-hardlink")); linked = true; }
    return read(file, options as never);
  });
  const state = new ExternalSkillStateStore(f.storage, { runId: randomUUID(), isPrimaryProcess: () => true }), unlink = vi.spyOn(fs, "unlinkSync");
  recoverExternalSkills(f.storage, state); expect(linked).toBe(true); expect(unlink).not.toHaveBeenCalled(); expect(fs.existsSync(f.file + ".lock")).toBe(true); expect(state.getDiagnostic(f.record.id)).toBeDefined();
});

it("initial state filesystem failure is sanitized without leaking profile paths", async () => {
  const f = stateFixture(), { ExternalSkillStateStore } = await subject(), mkdir = fs.mkdirSync;
  vi.spyOn(fs, "mkdirSync").mockImplementation((location, options) => { if (location === path.dirname(f.file)) throw new Error("failure at " + location); return mkdir(location, options as never); });
  expect(() => new ExternalSkillStateStore(f.storage, f.host).createPreparedExclusive(f.record)).toThrow("STORAGE_FAILED"); expect(fs.existsSync(f.file)).toBe(false);
});

it.each(["transition", "set-enabled", "remove"] as const)("R2: a valid %s mutation preserves a lock pathname replaced during descriptor write", async operation => {
  const f = await committedFixture();
  if (operation === "transition") fs.writeFileSync(f.file, JSON.stringify(f.record, null, 2));
  const recordBytes = fs.readFileSync(f.file), backupBytes = fs.readFileSync(f.file + ".bak"), write = fs.writeFileSync; let replaced = false, foreignInode = 0;
  vi.spyOn(fs, "writeFileSync").mockImplementation((file, bytes, options) => {
    write(file, bytes, options);
    if (typeof file === "number" && typeof bytes === "string" && bytes.includes('"external-skill-state-lock"') && !replaced) {
      fs.renameSync(f.file + ".lock", f.file + ".acquired-lock"); write(f.file + ".lock", "foreign lock bytes"); foreignInode = fs.lstatSync(f.file + ".lock").ino; replaced = true;
    }
  });
  const mutate = () => operation === "transition" ? f.state.transitionOwned(f.record.id, f.record.transactionId, f.committed)
    : operation === "set-enabled" ? f.state.setEnabledOwned(f.record.id, f.record.transactionId, true) : f.state.removeOwned(f.record.id, f.record.transactionId);
  expect(mutate).toThrow("STATE_INVALID"); expect(replaced).toBe(true); expect(fs.readFileSync(f.file + ".lock", "utf8")).toBe("foreign lock bytes");
  expect(fs.lstatSync(f.file + ".lock").ino).toBe(foreignInode); expect(fs.readFileSync(f.file)).toEqual(recordBytes); expect(fs.readFileSync(f.file + ".bak")).toEqual(backupBytes);
  expect(f.state.read(f.record.id)).toBeUndefined(); expect(f.state.getDiagnostic(f.record.id)?.code).toBe("STATE_INVALID");
});
it("R2: exact intended lock bytes bind cleanup even when the acquired inode is unchanged", async () => {
  const f = await committedFixture(), recordBytes = fs.readFileSync(f.file), write = fs.writeFileSync; let changed = false;
  vi.spyOn(fs, "writeFileSync").mockImplementation((file, bytes, options) => {
    write(file, bytes, options);
    if (typeof file === "number" && typeof bytes === "string" && bytes.includes('"external-skill-state-lock"') && !changed) { write(f.file + ".lock", "foreign same-inode bytes"); changed = true; }
  });
  expect(() => f.state.setEnabledOwned(f.record.id, f.record.transactionId, true)).toThrow("STATE_INVALID");
  expect(changed).toBe(true); expect(fs.readFileSync(f.file + ".lock", "utf8")).toBe("foreign same-inode bytes"); expect(fs.readFileSync(f.file)).toEqual(recordBytes); expect(f.state.getDiagnostic(f.record.id)?.code).toBe("STATE_INVALID");
});
it.each([[["transition"]], [["set-enabled"]], [["remove"]], [null], [1], [true], [{}]])("R3: malformed lock operation %j remains byte-identical and blocks recovery", async operation => {
  const f = await committedFixture(), { ExternalSkillStateStore } = await subject(), { recoverExternalSkills } = await import("./external-install");
  const lockBytes = JSON.stringify({ ...f.lock, operation }); fs.writeFileSync(f.file + ".lock", lockBytes);
  const contentBytes = fs.readFileSync(path.join(f.content, "SKILL.md")), unlink = vi.spyOn(fs, "unlinkSync"), state = new ExternalSkillStateStore(f.storage, { runId: randomUUID(), isPrimaryProcess: () => true });
  recoverExternalSkills(f.storage, state); expect(unlink).not.toHaveBeenCalled(); expect(fs.readFileSync(f.file + ".lock", "utf8")).toBe(lockBytes);
  expect(fs.readFileSync(f.file)).toEqual(f.recordBytes); expect(fs.readFileSync(path.join(f.content, "SKILL.md"))).toEqual(contentBytes);
  expect(state.read(f.record.id)).toBeUndefined(); expect(() => state.setEnabledOwned(f.record.id, f.record.transactionId, true)).toThrow("STATE_INVALID"); expect(state.getDiagnostic(f.record.id)?.code).toBe("STATE_INVALID");
});
it.each([[["committed"]], [["prepared"]], [null], [1], [true], [{}]])("R3: malformed record status %j is never returned or mutated", async status => {
  const f = stateFixture(), { ExternalSkillStateStore } = await subject(); fs.mkdirSync(path.dirname(f.file)); const bytes = JSON.stringify({ ...f.record, status, enabled: true }); fs.writeFileSync(f.file, bytes);
  const state = new ExternalSkillStateStore(f.storage, f.host); expect(state.read(f.record.id)).toBeUndefined();
  expect(() => state.setEnabledOwned(f.record.id, f.record.transactionId, true)).toThrow("STATE_INVALID"); expect(fs.readFileSync(f.file, "utf8")).toBe(bytes); expect(state.getDiagnostic(f.record.id)?.code).toBe("STATE_INVALID");
});
it.each([[["MIT"]], [null], [1], [true], [{}]])("R3: malformed bundle license %j is never returned or mutated", async license => {
  const f = stateFixture(), { ExternalSkillStateStore } = await subject(); fs.mkdirSync(path.dirname(f.file)); const bytes = JSON.stringify({ ...f.record, skill: { ...f.record.skill, bundle: { ...f.record.skill.bundle, license } } }); fs.writeFileSync(f.file, bytes);
  const state = new ExternalSkillStateStore(f.storage, f.host); expect(state.read(f.record.id)).toBeUndefined();
  expect(() => state.removeOwned(f.record.id, f.record.transactionId)).toThrow("STATE_INVALID"); expect(fs.readFileSync(f.file, "utf8")).toBe(bytes); expect(state.getDiagnostic(f.record.id)?.code).toBe("STATE_INVALID");
});
