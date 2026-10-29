import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { AtomicJsonStore } from "../storage/atomic-json-store";
import { canonicalPath, within } from "../startup/runtime-profile";
import type { StorageContext } from "../storage/storage-context";
import type { ExternalSkillErrorCode } from "../../shared/external-skills";
import { EXTERNAL_LIMITS, EXTERNAL_SOURCES, FIREFLY_NATIVE_POLICY_VERSION, externalSkillId, isExternalSourceId, reviewPolicyFor } from "./external-policy";
import { FIREFLY_NATIVE_KEYS, readFireflyNative, sameFireflyNative } from "./skill-metadata";
import { validateExternalPath } from "./external-fetch";
import { digestExternalFiles } from "./external-review";
import { assertSkillPath } from "./skill-path-safety";
import type { ExternalHostSession, ExternalSkillRecord } from "./external-types";

const SHA256 = /^[0-9a-f]{64}$/, SHA1 = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = new RegExp(`^external-(${Object.keys(EXTERNAL_SOURCES).join("|")})-[0-9a-f]{32}$`);
const MAX_STATE_BYTES = 2 * 1024 * 1024, MAX_LOCK_BYTES = 16384;
const LICENSE = /^(?:LICENSE|LICENCE|COPYING)(?:\.md|\.txt)?$/i;
const NOTICE = /^(?:NOTICE|COPYRIGHT)(?:\.md|\.txt)?$/i;
const SPDX = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"]);
export const EXTERNAL_OWNER_MARKER = ".external-skill-owner.json";
const activeLocks = new WeakMap<ExternalHostSession, Set<string>>();
const startedWriters = new WeakSet<ExternalHostSession>();
const attemptedRecovery = new WeakSet<ExternalHostSession>();
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, limit: number) => typeof value === "string" && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
export class ExternalStorageError extends Error {
  constructor(public readonly code: ExternalSkillErrorCode) { super(code); this.name = "ExternalStorageError"; }
}
export const storageFailure = (value: ExternalSkillErrorCode): never => { throw new ExternalStorageError(value); };
export function externalRecordBytes(record: ExternalSkillRecord): string { return JSON.stringify(record, null, 2); }
/** Exclusive descriptor ownership survives partial writes, so ENOSPC cannot turn cleanup into path guessing. */
export function writeExternalFileExclusive(location: string, bytes: string | Buffer, ownerRoot: string): ExternalFileIdentity {
  assertSkillPath(location);
  let fd: number | undefined, identity: fs.Stats | undefined;
  try {
    fd = fs.openSync(location, "wx", 0o600); identity = fs.fstatSync(fd);
    fs.writeFileSync(fd, bytes, { encoding: "utf8", flush: true }); fs.fsyncSync(fd);
    const current = snapshotExternalPath(location, ownerRoot);
    if (current.dev !== identity.dev || current.ino !== identity.ino || current.kind !== "file" || current.sha256 !== hash(bytes)) return storageFailure("STATE_INVALID");
    return current;
  } catch (error) {
    if (identity) {
      try {
        const current = snapshotExternalPath(location, ownerRoot);
        if (current.dev !== identity.dev || current.ino !== identity.ino || current.kind !== "file") return storageFailure("ROLLBACK_FAILED");
        if (fd !== undefined) { fs.closeSync(fd); fd = undefined; }
        assertExternalIdentity(current, ownerRoot); fs.unlinkSync(location);
      } catch { return storageFailure("ROLLBACK_FAILED"); }
    }
    if (error instanceof ExternalStorageError) throw error;
    return storageFailure(code(error) === "EEXIST" ? "TARGET_EXISTS" : "STORAGE_FAILED");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function externalProfileKey(storage: StorageContext): string {
  const canonical = (value: string) => process.platform === "win32" ? canonicalPath(value).toLowerCase() : canonicalPath(value);
  return hash(JSON.stringify([storage.profile.kind, ...[storage.profile.userData, storage.dataRoot, storage.stateRoot, storage.cacheRoot].map(canonical)]));
}
function validPath(value: unknown): value is string { try { validateExternalPath(value); return true; } catch { return false; } }
function depthValid(value: unknown, max: number, depth = 0): boolean {
  return depth <= max && (!value || typeof value !== "object" || Object.values(value).every(child => depthValid(child, max, depth + 1)));
}
function parse(bytes: Buffer, limit: number, depth: number): unknown {
  if (bytes.length > limit) return storageFailure("STATE_INVALID");
  try { const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); if (!depthValid(value, depth)) return storageFailure("STATE_INVALID"); return value; }
  catch { return storageFailure("STATE_INVALID"); }
}
/** Every imported path is repo-relative and must map to one supported, skill-local text file. */
export function externalLocalManifest(record: ExternalSkillRecord): Record<string, string> {
  const manifest: Record<string, string> = {}, folded = new Set<string>();
  for (const file of record.skill.files) {
    if (!validPath(file.path) || !file.path.startsWith(record.skill.path + "/")) return storageFailure("PATH_INVALID");
    const relative = file.path.slice(record.skill.path.length + 1), parts = relative.split("/");
    if (!validPath(relative) || !((parts.length === 1 && (relative === "SKILL.md" || LICENSE.test(relative) || NOTICE.test(relative)))
      || (parts.length === 2 && parts[0] === "references" && /\.(md|txt)$/i.test(parts[1])))) return storageFailure("DEPENDENCY_BLOCKED");
    if (folded.has(relative.toLowerCase())) return storageFailure("PATH_INVALID");
    folded.add(relative.toLowerCase()); manifest[relative] = file.sha256;
  }
  if (!Object.hasOwn(manifest, "SKILL.md")) return storageFailure("STATE_INVALID");
  return manifest;
}
export function isExternalSkillRecord(value: unknown): value is ExternalSkillRecord {
  try {
    if (!object(value) || !keys(value, ["schema", "id", "transactionId", "status", "enabled", "skill", "contentSha256", "reviewPolicyVersion"]) || value.schema !== 1 || typeof value.id !== "string" || !ID.test(value.id)
      || (value.reviewPolicyVersion !== undefined && (typeof value.reviewPolicyVersion !== "string" || !/^[a-z0-9][a-z0-9.-]{0,99}$/.test(value.reviewPolicyVersion)))
      || typeof value.transactionId !== "string" || !UUID.test(value.transactionId)
      || (value.status !== "prepared" && value.status !== "committed") || typeof value.enabled !== "boolean"
      || (value.status === "prepared" && value.enabled) || typeof value.contentSha256 !== "string" || !SHA256.test(value.contentSha256)
      || !object(value.skill)) return false;
    const skill = value.skill;
    if (!keys(skill, ["id", "sourceId", "upstreamName", "description", "bundle", "repository", "path", "commit", "version", "licenses", "files", "review", "blockers", "native"])) return false;
    // Firefly-native records always carry their reviewed Firefly metadata; no other record carries any.
    if (isExternalSourceId(skill.sourceId) && reviewPolicyFor(skill.sourceId) === FIREFLY_NATIVE_POLICY_VERSION) {
      if (!object(skill.native) || Object.keys(skill.native).some(key => !(FIREFLY_NATIVE_KEYS as readonly string[]).includes(key))) return false;
      const native = readFireflyNative(skill.native);
      if (!native || !sameFireflyNative(native, skill.native)) return false;
    } else if (skill.native !== undefined) return false;
    if (!isExternalSourceId(skill.sourceId) || skill.repository !== EXTERNAL_SOURCES[skill.sourceId].repository
      || !validPath(skill.path) || skill.id !== value.id || value.id !== externalSkillId(skill.sourceId, String(skill.repository), skill.path)
      || !text(skill.upstreamName, 500) || !text(skill.description, 10000) || !object(skill.bundle) || !keys(skill.bundle, ["name", "version", "license"]) || !text(skill.bundle.name, 500)
      || (skill.version !== undefined && !text(skill.version, 100)) || (skill.bundle.version !== undefined && !text(skill.bundle.version, 100))
      || (skill.bundle.license !== undefined && (typeof skill.bundle.license !== "string" || !SPDX.has(skill.bundle.license)))
      || typeof skill.commit !== "string" || !SHA1.test(skill.commit) || skill.review !== "approved"
      || !Array.isArray(skill.blockers) || skill.blockers.length !== 0 || !Array.isArray(skill.files) || !skill.files.length
      || skill.files.length > EXTERNAL_LIMITS.files || !Array.isArray(skill.licenses) || !skill.licenses.length || skill.licenses.length > EXTERNAL_LIMITS.files) return false;
    let bytes = 0;
    for (const file of skill.files) {
      if (!object(file) || !keys(file, ["path", "blobSha1", "sha256", "bytes"]) || !validPath(file.path) || typeof file.sha256 !== "string" || !SHA256.test(file.sha256)
        || typeof file.blobSha1 !== "string" || !SHA1.test(file.blobSha1) || !Number.isSafeInteger(file.bytes)
        || Number(file.bytes) < 0 || Number(file.bytes) > EXTERNAL_LIMITS.fileBytes) return false;
      bytes += Number(file.bytes);
    }
    if (bytes > EXTERNAL_LIMITS.totalBytes || digestExternalFiles(skill.files as ExternalSkillRecord["skill"]["files"]) !== value.contentSha256) return false;
    const files = new Map(skill.files.map(file => [file.path, file])), covered = new Set<string>(), licensePaths = new Set<string>();
    for (const license of skill.licenses) {
      if (!object(license) || !keys(license, ["path", "sha256", "spdx", "covers"]) || !validPath(license.path) || !LICENSE.test(license.path.split("/").at(-1)!)
        || typeof license.spdx !== "string" || !SPDX.has(license.spdx) || !files.has(license.path)
        || files.get(license.path)?.sha256 !== license.sha256 || licensePaths.has(license.path)
        || !Array.isArray(license.covers) || !license.covers.length || license.covers.length > EXTERNAL_LIMITS.files
        || new Set(license.covers).size !== license.covers.length || license.covers.some(item => typeof item !== "string" || !files.has(item))) return false;
      licensePaths.add(license.path); license.covers.forEach(item => covered.add(item));
    }
    if (skill.files.some(file => !covered.has(file.path) || (LICENSE.test(file.path.split("/").at(-1)!) && !licensePaths.has(file.path)))) return false;
    externalLocalManifest(value as unknown as ExternalSkillRecord);
    return true;
  } catch { return false; }
}
export interface ExternalFileIdentity {
  path: string; dev: number; ino: number; nlink: number; size: number; mtimeMs: number; kind: "file" | "directory"; sha256?: string;
}
/** lstat + descriptor identity + no-link ancestor checks. This is not same-OS-user kernel isolation. */
export function snapshotExternalPath(location: string, ownerRoot: string, maximumBytes = MAX_STATE_BYTES): ExternalFileIdentity {
  assertSkillPath(location); assertSkillPath(ownerRoot);
  if (!within(canonicalPath(ownerRoot), canonicalPath(location))) return storageFailure("STATE_INVALID");
  const info = fs.lstatSync(location);
  if (info.isFile() && info.size > maximumBytes) return storageFailure("STATE_INVALID");
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) return storageFailure("STATE_INVALID");
  const identity: ExternalFileIdentity = { path: location, dev: info.dev, ino: info.ino, nlink: info.nlink, size: info.size, mtimeMs: info.mtimeMs,
    kind: info.isFile() ? "file" : "directory" };
  if (info.isFile()) {
    const fd = fs.openSync(location, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== info.dev || opened.ino !== info.ino || !opened.isFile()) return storageFailure("STATE_INVALID");
      identity.sha256 = hash(fs.readFileSync(fd));
      const after = fs.fstatSync(fd);
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) return storageFailure("STATE_INVALID");
    } finally { fs.closeSync(fd); }
  }
  return identity;
}
export function assertExternalIdentity(identity: ExternalFileIdentity, ownerRoot: string): void {
  const current = snapshotExternalPath(identity.path, ownerRoot);
  if (JSON.stringify(current) !== JSON.stringify(identity)) return storageFailure("STATE_INVALID");
}
export function externalPathExists(location: string): boolean {
  try { fs.lstatSync(location); return true; } catch (error) { if (code(error) === "ENOENT") return false; throw error; }
}
export interface ExternalOwnerMarker {
  schema: 1; kind: "external-skill-content-owner" | "external-skill-stage-owner";
  profileKey: string; id: string; transactionId: string; contentSha256: string;
}
export function externalOwnerMarker(storage: StorageContext, record: ExternalSkillRecord, stage = false): ExternalOwnerMarker {
  return { schema: 1, kind: stage ? "external-skill-stage-owner" : "external-skill-content-owner", profileKey: externalProfileKey(storage),
    id: record.id, transactionId: record.transactionId, contentSha256: record.contentSha256 };
}
export function verifyExternalMarker(storage: StorageContext, directory: string, record: ExternalSkillRecord, stage = false): ExternalFileIdentity {
  const location = path.join(directory, EXTERNAL_OWNER_MARKER), identity = snapshotExternalPath(location, stage ? storage.cacheRoot : storage.dataRoot, MAX_LOCK_BYTES);
  if (identity.kind !== "file" || identity.size > MAX_LOCK_BYTES || fs.lstatSync(location).nlink !== 1) return storageFailure("STATE_INVALID");
  const marker = parse(fs.readFileSync(location), MAX_LOCK_BYTES, 8);
  if (!object(marker) || JSON.stringify(marker) !== JSON.stringify(externalOwnerMarker(storage, record, stage))) return storageFailure("STATE_INVALID");
  return identity;
}
/** Full exact file manifest, sizes and both digests; never interprets or executes upstream text. */
export function verifyExternalContent(directory: string, record: ExternalSkillRecord, ownerRoot: string): ExternalFileIdentity[] {
  const expected = externalLocalManifest(record), identities: ExternalFileIdentity[] = [], files = new Map(record.skill.files.map(file => [file.path.slice(record.skill.path.length + 1), file]));
  const seen = new Set<string>(); let total = 0;
  function visit(current: string, prefix: string): void {
    const identity = snapshotExternalPath(current, ownerRoot); if (identity.kind !== "directory") return storageFailure("STATE_INVALID"); identities.push(identity);
    for (const entry of fs.readdirSync(current)) {
      const relative = prefix ? prefix + "/" + entry : entry;
      validateExternalPath(relative);
      const location = path.join(current, entry), info = snapshotExternalPath(location, ownerRoot);
      if (info.kind === "directory") {
        if (relative !== "references") return storageFailure("STATE_INVALID"); visit(location, relative);
      } else {
        const file = files.get(relative); if (fs.lstatSync(location).nlink !== 1 || !file || seen.has(relative.toLowerCase()) || info.sha256 !== expected[relative] || info.size !== file.bytes) return storageFailure("DIGEST_MISMATCH");
        total += info.size; if (info.size > EXTERNAL_LIMITS.fileBytes || total > EXTERNAL_LIMITS.totalBytes) return storageFailure("LIMIT_EXCEEDED");
        const bytes = fs.readFileSync(location);
        if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== file.blobSha1 || hash(bytes) !== file.sha256) return storageFailure("DIGEST_MISMATCH");
        seen.add(relative.toLowerCase()); identities.push(info);
      }
    }
  }
  visit(directory, ""); if (seen.size !== files.size) return storageFailure("DIGEST_MISMATCH");
  return identities;
}
export function verifyExternalInstallation(storage: StorageContext, record: ExternalSkillRecord): ExternalFileIdentity[] {
  const skills = path.join(storage.dataRoot, "skills"), outer = path.join(skills, record.id);
  if (fs.readdirSync(skills).some(name => name.toLowerCase() === record.id && name !== record.id)) return storageFailure("STATE_INVALID");
  const parents = [storage.dataRoot, skills, outer].map(location => snapshotExternalPath(location, storage.dataRoot));
  if (parents.some(info => info.kind !== "directory") || fs.readdirSync(outer).sort().join("\n") !== [EXTERNAL_OWNER_MARKER, "content"].sort().join("\n")) return storageFailure("STATE_INVALID");
  return [...parents, verifyExternalMarker(storage, outer, record), ...verifyExternalContent(path.join(outer, "content"), record, storage.dataRoot)];
}
interface HostLock {
  schema: 1; kind: "external-skill-state-lock"; profileKey: string; id: string; transactionId: string; hostRunId: string;
  operation: "transition" | "set-enabled" | "remove"; beforeSha256: string; afterSha256?: string; pid?: number; createdAt?: number;
}
function validLock(value: unknown): value is HostLock {
  return object(value) && Object.keys(value).every(key => ["schema", "kind", "profileKey", "id", "transactionId", "hostRunId", "operation", "beforeSha256", "afterSha256", "pid", "createdAt"].includes(key))
    && value.schema === 1 && value.kind === "external-skill-state-lock" && typeof value.profileKey === "string" && SHA256.test(value.profileKey)
    && typeof value.id === "string" && ID.test(value.id) && typeof value.transactionId === "string" && UUID.test(value.transactionId)
    && typeof value.hostRunId === "string" && UUID.test(value.hostRunId) && typeof value.operation === "string" && ["transition", "set-enabled", "remove"].includes(value.operation)
    && typeof value.beforeSha256 === "string" && SHA256.test(value.beforeSha256)
    && (value.afterSha256 === undefined || (typeof value.afterSha256 === "string" && SHA256.test(value.afterSha256)))
    && (value.operation === "remove" ? value.afterSha256 === undefined : value.afterSha256 !== undefined)
    && (value.pid === undefined || (Number.isSafeInteger(value.pid) && Number(value.pid) >= 0))
    && (value.createdAt === undefined || (typeof value.createdAt === "number" && Number.isFinite(value.createdAt) && value.createdAt >= 0));
}
export class ExternalSkillStateStore {
  private readonly diagnostics = new Map<string, { code: "STATE_INVALID"; error: string }>();
  private readonly root: string;
  constructor(private readonly storage: StorageContext, private readonly host?: ExternalHostSession) { this.root = path.join(storage.stateRoot, "external-skills"); }
  getDiagnostic(id: string): { code: "STATE_INVALID"; error: string } | undefined { return this.diagnostics.get(id); }
  private diagnostic(id: string): void { this.diagnostics.set(id, { code: "STATE_INVALID", error: "External Skill state requires verification and remains unavailable." }); }
  private location(id: string): string { if (!ID.test(id)) return storageFailure("STATE_INVALID"); return path.join(this.root, id + ".json"); }
  private assertHost(): ExternalHostSession {
    if (!this.host || !UUID.test(this.host.runId) || !this.host.isPrimaryProcess()) return storageFailure("STATE_INVALID"); return this.host;
  }
  /** Main-only capability check, before install creates any formal filesystem paths. */
  assertWritable(storage: StorageContext): void {
    this.assertHost();
    if (externalProfileKey(storage) !== externalProfileKey(this.storage)) return storageFailure("STATE_INVALID");
  }
  private assertRoot(): void {
    assertSkillPath(this.root); assertSkillPath(this.storage.stateRoot);
    if (!within(canonicalPath(this.storage.stateRoot), canonicalPath(this.root))) return storageFailure("STATE_INVALID");
  }
  private hasLock(file: string): boolean {
    return externalPathExists(this.root) && fs.readdirSync(this.root).some(name => name.toLowerCase() === path.basename(file + ".lock").toLowerCase());
  }
  private unlockedRecord(id: string): { record: ExternalSkillRecord; identity: ExternalFileIdentity } {
    this.assertRoot(); const file = this.location(id), identity = snapshotExternalPath(file, this.storage.stateRoot);
    if (identity.kind !== "file" || identity.size > MAX_STATE_BYTES || fs.lstatSync(file).nlink !== 1) return storageFailure("STATE_INVALID");
    const value = parse(fs.readFileSync(file), MAX_STATE_BYTES, 32);
    if (!isExternalSkillRecord(value) || value.id !== id) return storageFailure("STATE_INVALID");
    assertExternalIdentity(identity, this.storage.stateRoot); return { record: value, identity };
  }
  read(id: string): ExternalSkillRecord | undefined {
    try {
      const file = this.location(id); this.assertRoot();
      if (this.hasLock(file)) return storageFailure("STATE_INVALID");
      if (!externalPathExists(file)) {
        if (externalPathExists(file + ".bak")) this.diagnostic(id); return undefined;
      }
      const { record } = this.unlockedRecord(id); this.diagnostics.delete(id); return record;
    } catch { this.diagnostic(id); return undefined; }
  }
  createPreparedExclusive(record: ExternalSkillRecord): void {
    try { this.createPrepared(record); }
    catch (error) { if (error instanceof ExternalStorageError) throw error; return storageFailure("STORAGE_FAILED"); }
  }
  private createPrepared(record: ExternalSkillRecord): void {
    const host = this.assertHost(); startedWriters.add(host);
    if (!isExternalSkillRecord(record) || record.status !== "prepared" || record.enabled) return storageFailure("STATE_INVALID");
    this.assertRoot(); fs.mkdirSync(this.root, { recursive: true }); this.assertRoot();
    const file = this.location(record.id);
    if (fs.readdirSync(this.root).some(name => [path.basename(file), path.basename(file) + ".bak", path.basename(file) + ".lock"].some(target => name.toLowerCase() === target.toLowerCase())) || externalPathExists(file + ".lock")) return storageFailure("TARGET_EXISTS");
    const temporary = path.join(this.root, `.${record.id}.${randomUUID()}.prepared`); let owned: ExternalFileIdentity | undefined;
    try {
      owned = writeExternalFileExclusive(temporary, externalRecordBytes(record), this.storage.stateRoot);
      if (!isExternalSkillRecord(parse(fs.readFileSync(temporary), MAX_STATE_BYTES, 32))) return storageFailure("STATE_INVALID");
      assertExternalIdentity(owned, this.storage.stateRoot);
      fs.linkSync(temporary, file); // No exists+rename fallback: the filesystem must support exclusive links.
      const linked = snapshotExternalPath(temporary, this.storage.stateRoot);
      if (linked.dev !== owned.dev || linked.ino !== owned.ino || linked.sha256 !== owned.sha256 || linked.nlink !== 2) return storageFailure("STATE_INVALID");
      owned = linked;
    } catch (error) { if (error instanceof ExternalStorageError) throw error; return storageFailure(code(error) === "EEXIST" ? "TARGET_EXISTS" : "STORAGE_FAILED"); }
    finally {
      if (owned) { assertExternalIdentity(owned, this.storage.stateRoot); fs.unlinkSync(temporary); }
    }
  }
  private mutate(id: string, transactionId: string, operation: HostLock["operation"], change: (before: ExternalSkillRecord) => ExternalSkillRecord | undefined): void {
    const host = this.assertHost(); startedWriters.add(host);
    const file = this.location(id), lockPath = file + ".lock"; this.assertRoot();
    const active = activeLocks.get(host) ?? new Set<string>(); activeLocks.set(host, active);
    if (this.hasLock(file)) { this.diagnostic(id); return storageFailure("STATE_INVALID"); }
    let fd: number;
    try { fd = fs.openSync(lockPath, "wx", 0o600); } catch { this.diagnostic(id); return storageFailure("STATE_INVALID"); }
    active.add(lockPath); let lockIdentity: ExternalFileIdentity | undefined, acquired: fs.Stats | undefined, parent: ExternalFileIdentity | undefined;
    try {
      acquired = fs.fstatSync(fd); parent = snapshotExternalPath(this.root, this.storage.stateRoot);
      const before = this.unlockedRecord(id);
      if (before.record.transactionId !== transactionId) return storageFailure("STATE_INVALID");
      const backup = file + ".bak";
      let backupIdentity: ExternalFileIdentity | undefined;
      if (externalPathExists(backup)) {
        backupIdentity = snapshotExternalPath(backup, this.storage.stateRoot);
        const saved = parse(fs.readFileSync(backup), MAX_STATE_BYTES, 32);
        if (!isExternalSkillRecord(saved) || saved.id !== id || saved.transactionId !== transactionId || fs.lstatSync(backup).nlink !== 1) return storageFailure("STATE_INVALID");
      }
      const next = change(before.record);
      if (next && (!isExternalSkillRecord(next) || next.id !== id || next.transactionId !== transactionId)) return storageFailure("STATE_INVALID");
      const lock: HostLock = { schema: 1, kind: "external-skill-state-lock", profileKey: externalProfileKey(this.storage), id, transactionId,
        hostRunId: host.runId, operation, beforeSha256: before.identity.sha256!, ...(next ? { afterSha256: hash(externalRecordBytes(next)) } : {}) };
      const lockBytes = JSON.stringify(lock);
      fs.writeFileSync(fd, lockBytes); fs.fsyncSync(fd);
      const written = fs.fstatSync(fd);
      // This is the acquired descriptor's proof, never a new pathname's ownership claim.
      lockIdentity = { path: lockPath, dev: acquired.dev, ino: acquired.ino, nlink: 1,
        size: Buffer.byteLength(lockBytes, "utf8"), mtimeMs: written.mtimeMs, kind: "file", sha256: hash(lockBytes) };
      if (!written.isFile() || written.dev !== acquired.dev || written.ino !== acquired.ino || written.nlink !== 1 || written.size !== lockIdentity.size) return storageFailure("STATE_INVALID");
      assertExternalIdentity(lockIdentity, this.storage.stateRoot);
      const parentIdentity = snapshotExternalPath(this.root, this.storage.stateRoot);
      assertExternalIdentity(before.identity, this.storage.stateRoot); assertExternalIdentity(lockIdentity, this.storage.stateRoot); assertExternalIdentity(parentIdentity, this.storage.stateRoot);
      if (backupIdentity) assertExternalIdentity(backupIdentity, this.storage.stateRoot);
      if (next) new AtomicJsonStore<ExternalSkillRecord>(file, isExternalSkillRecord).write(next);
      else { fs.unlinkSync(file); if (backupIdentity) { assertExternalIdentity(backupIdentity, this.storage.stateRoot); fs.unlinkSync(backup); } }
      this.diagnostics.delete(id);
    } catch (error) { this.diagnostic(id); if (error instanceof ExternalStorageError) throw error; return storageFailure("STORAGE_FAILED"); }
    finally {
      fs.closeSync(fd); active.delete(lockPath);
      // Failed validation can own an empty lock too; never unlink a replacement inode.
      try {
        const info = fs.lstatSync(lockPath);
        if (lockIdentity) assertExternalIdentity(lockIdentity, this.storage.stateRoot);
        else if (!info.isFile() || info.isSymbolicLink() || !acquired || info.dev !== acquired.dev || info.ino !== acquired.ino) return storageFailure("STATE_INVALID");
        const parentNow = snapshotExternalPath(this.root, this.storage.stateRoot);
        if (!parent || parentNow.kind !== "directory" || parentNow.dev !== parent.dev || parentNow.ino !== parent.ino) return storageFailure("STATE_INVALID");
        fs.unlinkSync(lockPath);
      } catch (error) { this.diagnostic(id); if (code(error) !== "ENOENT") return storageFailure("STATE_INVALID"); }
    }
  }
  transitionOwned(id: string, transactionId: string, next: ExternalSkillRecord): void {
    this.mutate(id, transactionId, "transition", before => {
      if (before.status !== "prepared" || before.enabled || next.status !== "committed" || next.enabled
        || JSON.stringify({ ...next, status: "prepared" }) !== JSON.stringify(before)) return storageFailure("STATE_INVALID");
      verifyExternalInstallation(this.storage, next); return next;
    });
  }
  setEnabledOwned(id: string, transactionId: string, enabled: boolean): void {
    this.mutate(id, transactionId, "set-enabled", before => {
      if (before.status !== "committed" || typeof enabled !== "boolean") return storageFailure("STATE_INVALID");
      verifyExternalInstallation(this.storage, before); return { ...before, enabled };
    });
  }
  removeOwned(id: string, transactionId: string): void { this.mutate(id, transactionId, "remove", () => undefined); }
  /** Only recoverExternalSkills calls this before external writers or registry scanning begin. */
  recoverStartup(storage: StorageContext): void {
    try { if (externalProfileKey(storage) !== externalProfileKey(this.storage)) return; this.assertRoot(); } catch { return; }
    if (!this.host || !this.host.isPrimaryProcess() || !UUID.test(this.host.runId) || startedWriters.has(this.host) || attemptedRecovery.has(this.host)) {
      if (externalPathExists(this.root)) for (const name of fs.readdirSync(this.root)) if (name.toLowerCase().endsWith(".json.lock")) this.diagnostic(name.slice(0, -10).toLowerCase());
      return;
    }
    attemptedRecovery.add(this.host);
    try { this.assertRoot(); if (!externalPathExists(this.root)) return; }
    catch { return; }
    for (const name of fs.readdirSync(this.root)) {
      if (!name.toLowerCase().endsWith(".json.lock")) continue;
      const id = name.slice(0, -10).toLowerCase(), lockPath = path.join(this.root, name);
      try {
        if (activeLocks.get(this.host)?.has(lockPath)) return storageFailure("STATE_INVALID");
        const lockIdentity = snapshotExternalPath(lockPath, this.storage.stateRoot, MAX_LOCK_BYTES);
        if (lockIdentity.kind !== "file" || lockIdentity.size > MAX_LOCK_BYTES || fs.lstatSync(lockPath).nlink !== 1) return storageFailure("STATE_INVALID");
        const lock = parse(fs.readFileSync(lockPath), MAX_LOCK_BYTES, 8);
        if (name !== id + ".json.lock" || !validLock(lock) || lock.profileKey !== externalProfileKey(this.storage) || lock.id !== id || lock.hostRunId === this.host.runId || lock.operation === "remove") return storageFailure("STATE_INVALID");
        const entry = this.unlockedRecord(id);
        if (entry.record.status !== "committed" || entry.record.enabled || entry.record.transactionId !== lock.transactionId
          || ![lock.beforeSha256, lock.afterSha256].includes(entry.identity.sha256!)) return storageFailure("STATE_INVALID");
        const stateProofs = [snapshotExternalPath(this.storage.stateRoot, this.storage.stateRoot), snapshotExternalPath(this.root, this.storage.stateRoot), entry.identity, lockIdentity];
        const contentProofs = verifyExternalInstallation(this.storage, entry.record);
        // Capture all proofs first; a second pass detects replacement or byte changes before unlink.
        for (const proof of stateProofs) assertExternalIdentity(proof, this.storage.stateRoot);
        for (const proof of contentProofs) assertExternalIdentity(proof, this.storage.dataRoot);
        fs.unlinkSync(lockPath); this.diagnostics.delete(id);
      } catch { this.diagnostic(id); }
    }
  }
}
