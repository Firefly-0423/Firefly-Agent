import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { canonicalPath, within } from "../runtime-profile";
import type { StorageContext } from "../storage-context";
import type { ExternalCommitted } from "../../shared/external-skills";
import type { ExternalSkillRecord } from "./external-types";
import { validateManagedSourceDirectory } from "./directory-install";
import { assertSkillPath } from "./skill-path-safety";
import { EXTERNAL_OWNER_MARKER, ExternalStorageError, ExternalSkillStateStore, assertExternalIdentity, externalLocalManifest,
  externalOwnerMarker, externalPathExists, externalProfileKey, isExternalSkillRecord, snapshotExternalPath, storageFailure,
  verifyExternalContent, verifyExternalInstallation, verifyExternalMarker, writeExternalFileExclusive, type ExternalFileIdentity } from "./external-state";

/** Main-only handle. A caller-created lookalike is never cleanup authority. */
export interface ExternalStageHandle {
  readonly stageRoot: string; readonly id: string; readonly transactionId: string; readonly profileKey: string;
}
interface OwnedStage { handle: ExternalStageHandle; proofs: ExternalFileIdentity[]; disposed: boolean }
const stages = new WeakMap<ExternalStageHandle, OwnedStage>();
const stagesByPath = new Map<string, OwnedStage>();
const committedTransactions = new Map<string, { record: ExternalSkillRecord; state: ExternalFileIdentity; content: ExternalFileIdentity[] }>();
const transactionKey = (storage: StorageContext, record: ExternalSkillRecord) => externalProfileKey(storage) + "/" + record.id + "/" + record.transactionId;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function ownedRoot(storage: StorageContext, stageRoot: string, record: ExternalSkillRecord): void {
  const base = path.join(storage.cacheRoot, "external-skills"), transactionRoot = path.dirname(stageRoot); assertSkillPath(base); assertSkillPath(stageRoot);
  if (path.dirname(transactionRoot) !== base || path.basename(transactionRoot) !== record.transactionId || path.basename(stageRoot) !== "payload"
    || !within(canonicalPath(storage.cacheRoot), canonicalPath(stageRoot))) return storageFailure("STATE_INVALID");
}
function treeProofs(root: string, ownerRoot: string): ExternalFileIdentity[] {
  const result: ExternalFileIdentity[] = [];
  function visit(location: string): void {
    const info = snapshotExternalPath(location, ownerRoot); result.push(info);
    if (info.kind === "directory") fs.readdirSync(location).forEach(name => visit(path.join(location, name)));
  }
  visit(root); return result;
}
function assertDirectoryInode(proof: ExternalFileIdentity, ownerRoot: string): void {
  const next = snapshotExternalPath(proof.path, ownerRoot);
  if (next.kind !== "directory" || next.dev !== proof.dev || next.ino !== proof.ino) return storageFailure("ROLLBACK_FAILED");
}
/** No recursive rm: unknown/replaced files survive, and nonempty directories refuse removal. */
function removeOwnedTree(root: string, proofs: ExternalFileIdentity[], ownerRoot: string): void {
  const actual = treeProofs(root, ownerRoot);
  if (actual.length !== proofs.length || actual.some(info => !proofs.some(proof => JSON.stringify(proof) === JSON.stringify(info)))) return storageFailure("ROLLBACK_FAILED");
  for (const proof of proofs) assertExternalIdentity(proof, ownerRoot);
  for (const proof of [...proofs].sort((left, right) => right.path.length - left.path.length)) {
    if (proof.kind === "file") { assertExternalIdentity(proof, ownerRoot); fs.unlinkSync(proof.path); }
    else { assertDirectoryInode(proof, ownerRoot); fs.rmdirSync(proof.path); }
  }
}
function writeOwnedMarker(storage: StorageContext, root: string, record: ExternalSkillRecord, stage: boolean): ExternalFileIdentity {
  return writeExternalFileExclusive(path.join(root, EXTERNAL_OWNER_MARKER), JSON.stringify(externalOwnerMarker(storage, record, stage)), stage ? storage.cacheRoot : storage.dataRoot);
}
/** T4 calls this only after complete download + static review. It never rewrites or drops an upstream file. */
function stageExternalSkillImpl(storage: StorageContext, record: ExternalSkillRecord, payloadMap: ReadonlyMap<string, Buffer>): ExternalStageHandle {
  if (!isExternalSkillRecord(record) || record.status !== "prepared" || record.enabled) return storageFailure("STATE_INVALID");
  const manifest = externalLocalManifest(record);
  if (payloadMap.size !== record.skill.files.length) return storageFailure("DIGEST_MISMATCH");
  for (const file of record.skill.files) {
    const bytes = payloadMap.get(file.path);
    if (!Buffer.isBuffer(bytes) || bytes.length !== file.bytes || hash(bytes) !== file.sha256
      || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== file.blobSha1) return storageFailure("DIGEST_MISMATCH");
    try { if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(new TextDecoder("utf-8", { fatal: true }).decode(bytes))) return storageFailure("DEPENDENCY_BLOCKED"); }
    catch { return storageFailure("DEPENDENCY_BLOCKED"); }
  }
  if ([...payloadMap.keys()].some(file => !record.skill.files.some(expected => expected.path === file))) return storageFailure("DIGEST_MISMATCH");
  const base = path.join(storage.cacheRoot, "external-skills"), transactionRoot = path.join(base, record.transactionId), stageRoot = path.join(transactionRoot, "payload");
  ownedRoot(storage, stageRoot, record); fs.mkdirSync(base, { recursive: true }); ownedRoot(storage, stageRoot, record);
  const created = new Map<string, ExternalFileIdentity>();
  const mark = (location: string) => created.set(location, snapshotExternalPath(location, storage.cacheRoot));
  try {
    fs.mkdirSync(transactionRoot); mark(transactionRoot);
    created.set(path.join(transactionRoot, EXTERNAL_OWNER_MARKER), writeOwnedMarker(storage, transactionRoot, record, true));
    fs.mkdirSync(stageRoot); mark(stageRoot);
    const skillRoot = path.join(stageRoot, record.id); fs.mkdirSync(skillRoot); mark(skillRoot);
    for (const file of record.skill.files) {
      const relative = file.path.slice(record.skill.path.length + 1), destination = path.join(skillRoot, ...relative.split("/"));
      if (relative.startsWith("references/") && !created.has(path.dirname(destination))) { fs.mkdirSync(path.dirname(destination)); mark(path.dirname(destination)); }
      created.set(destination, writeExternalFileExclusive(destination, payloadMap.get(file.path)!, storage.cacheRoot));
    }
    const expected = Object.fromEntries(Object.entries(manifest).map(([relative, digest]) => [record.id + "/" + relative, digest]));
    validateManagedSourceDirectory(stageRoot, [record.id], expected);
    verifyExternalContent(skillRoot, record, storage.cacheRoot);
    const handle = Object.freeze({ stageRoot, id: record.id, transactionId: record.transactionId, profileKey: externalProfileKey(storage) });
    const owned = { handle, proofs: treeProofs(transactionRoot, storage.cacheRoot), disposed: false }; stages.set(handle, owned); stagesByPath.set(stageRoot, owned);
    return handle;
  } catch (error) {
    if (created.size) {
      try {
        const actual = treeProofs(transactionRoot, storage.cacheRoot);
        if (actual.some(info => !created.has(info.path) || info.dev !== created.get(info.path)?.dev || info.ino !== created.get(info.path)?.ino || (info.kind === "file" && JSON.stringify(info) !== JSON.stringify(created.get(info.path))))) return storageFailure("ROLLBACK_FAILED");
        removeOwnedTree(transactionRoot, actual, storage.cacheRoot);
      } catch { return storageFailure("ROLLBACK_FAILED"); }
    }
    if (error instanceof ExternalStorageError) throw error;
    return storageFailure((error as NodeJS.ErrnoException).code === "EEXIST" ? "TARGET_EXISTS" : "STORAGE_FAILED");
  }
}
export function stageExternalSkill(storage: StorageContext, record: ExternalSkillRecord, payloadMap: ReadonlyMap<string, Buffer>): ExternalStageHandle {
  try { return stageExternalSkillImpl(storage, record, payloadMap); }
  catch (error) { if (error instanceof ExternalStorageError) throw error; return storageFailure("STORAGE_FAILED"); }
}
export function discardExternalStage(storage: StorageContext, handle: ExternalStageHandle): void {
  const owned = stages.get(handle);
  if (!owned || handle.profileKey !== externalProfileKey(storage)) return storageFailure("STATE_INVALID");
  if (owned.disposed) return;
  try { removeOwnedTree(path.dirname(handle.stageRoot), owned.proofs, storage.cacheRoot); owned.disposed = true; stagesByPath.delete(handle.stageRoot); }
  catch { return storageFailure("ROLLBACK_FAILED"); }
}
function validateStage(storage: StorageContext, stageRoot: string, record: ExternalSkillRecord): ExternalFileIdentity[] {
  ownedRoot(storage, stageRoot, record); const transactionRoot = path.dirname(stageRoot); verifyExternalMarker(storage, transactionRoot, record, true);
  if (fs.readdirSync(transactionRoot).sort().join("\n") !== [EXTERNAL_OWNER_MARKER, "payload"].sort().join("\n") || fs.readdirSync(stageRoot).join("\n") !== record.id) return storageFailure("STATE_INVALID");
  const known = stagesByPath.get(stageRoot);
  if (known) { for (const proof of known.proofs) assertExternalIdentity(proof, storage.cacheRoot); }
  verifyExternalContent(path.join(stageRoot, record.id), record, storage.cacheRoot);
  const expected = Object.fromEntries(Object.entries(externalLocalManifest(record)).map(([relative, digest]) => [record.id + "/" + relative, digest]));
  validateManagedSourceDirectory(stageRoot, [record.id], expected);
  return treeProofs(transactionRoot, storage.cacheRoot);
}
/** Prepared record -> exclusive outer directory -> atomic content rename -> committed, always disabled. */
async function commitExternalSkillImpl(input: { storage: StorageContext; stageRoot: string; record: ExternalSkillRecord; state: ExternalSkillStateStore }): Promise<ExternalCommitted> {
  const { storage, stageRoot, record, state } = input;
  state.assertWritable(storage);
  if (!isExternalSkillRecord(record) || record.status !== "prepared" || record.enabled) return storageFailure("STATE_INVALID");
  const stageProofs = validateStage(storage, stageRoot, record);
  const skills = path.join(storage.dataRoot, "skills"), outer = path.join(skills, record.id), content = path.join(outer, "content");
  assertSkillPath(skills); if (!within(canonicalPath(storage.dataRoot), canonicalPath(skills))) return storageFailure("STATE_INVALID");
  fs.mkdirSync(skills, { recursive: true }); assertSkillPath(skills);
  if (fs.readdirSync(skills).some(name => name.toLowerCase() === record.id)) return storageFailure("TARGET_EXISTS");
  let stateCreated = false, outerIdentity: ExternalFileIdentity | undefined, outerMarkerIdentity: ExternalFileIdentity | undefined, publishedProofs: ExternalFileIdentity[] | undefined, published = false;
  try {
    state.createPreparedExclusive(record); stateCreated = true;
    // Case-insensitive aliases are refused even on the case-sensitive test filesystem.
    if (fs.readdirSync(skills).some(name => name.toLowerCase() === record.id)) return storageFailure("TARGET_EXISTS");
    try { fs.mkdirSync(outer); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return storageFailure("TARGET_EXISTS"); throw error; }
    outerIdentity = snapshotExternalPath(outer, storage.dataRoot);
    outerMarkerIdentity = writeOwnedMarker(storage, outer, record, false);
    const marker = verifyExternalMarker(storage, outer, record);
    assertDirectoryInode(outerIdentity, storage.dataRoot); assertExternalIdentity(marker, storage.dataRoot);
    for (const proof of stageProofs) assertExternalIdentity(proof, storage.cacheRoot);
    if (fs.readdirSync(outer).join("\n") !== EXTERNAL_OWNER_MARKER) return storageFailure("STATE_INVALID");
    validateManagedSourceDirectory(stageRoot, [record.id], Object.fromEntries(Object.entries(externalLocalManifest(record)).map(([relative, digest]) => [record.id + "/" + relative, digest])));
    verifyExternalContent(path.join(stageRoot, record.id), record, storage.cacheRoot);
    assertDirectoryInode(outerIdentity, storage.dataRoot); assertExternalIdentity(marker, storage.dataRoot);
    fs.renameSync(path.join(stageRoot, record.id), content); published = true;
    publishedProofs = verifyExternalInstallation(storage, record).filter(proof => proof.path === outer || proof.path.startsWith(outer + path.sep));
    state.transitionOwned(record.id, record.transactionId, { ...record, status: "committed", enabled: false });
    const remainder = treeProofs(path.dirname(stageRoot), storage.cacheRoot);
    const movedRoot = path.join(stageRoot, record.id);
    const expectedRemainder = stageProofs.filter(proof => proof.path !== movedRoot && !proof.path.startsWith(movedRoot + path.sep));
    if (remainder.length !== expectedRemainder.length) return storageFailure("ROLLBACK_FAILED");
    // Only payload-directory metadata changes because its one known skill child was moved.
    for (const info of remainder) {
      const original = expectedRemainder.find(proof => proof.path === info.path);
      if (!original || info.kind !== original.kind || info.dev !== original.dev || info.ino !== original.ino
        || (info.path !== stageRoot && JSON.stringify(info) !== JSON.stringify(original))) return storageFailure("ROLLBACK_FAILED");
    }
    removeOwnedTree(path.dirname(stageRoot), remainder, storage.cacheRoot);
    const handle = stagesByPath.get(stageRoot); if (handle) { handle.disposed = true; stagesByPath.delete(stageRoot); }
    committedTransactions.set(transactionKey(storage, record), { record: { ...record, status: "committed", enabled: false },
      state: snapshotExternalPath(path.join(storage.stateRoot, "external-skills", record.id + ".json"), storage.stateRoot),
      content: treeProofs(outer, storage.dataRoot) });
    return { id: record.id, enabled: false, contentSha256: record.contentSha256 };
  } catch (error) {
    try {
      let outerProofs: ExternalFileIdentity[] | undefined;
      if (outerIdentity) {
        assertDirectoryInode(outerIdentity, storage.dataRoot);
        if (outerMarkerIdentity) assertExternalIdentity(outerMarkerIdentity, storage.dataRoot);
        if (published) {
          verifyExternalInstallation(storage, record);
          if (!publishedProofs) return storageFailure("ROLLBACK_FAILED");
          for (const proof of publishedProofs) assertExternalIdentity(proof, storage.dataRoot);
        } else if (externalPathExists(path.join(outer, EXTERNAL_OWNER_MARKER))) verifyExternalMarker(storage, outer, record);
        const names = fs.readdirSync(outer);
        if (names.some(name => name !== EXTERNAL_OWNER_MARKER && !(published && name === "content"))) return storageFailure("ROLLBACK_FAILED");
        outerProofs = treeProofs(outer, storage.dataRoot);
      }
      if (stateCreated) state.removeOwned(record.id, record.transactionId);
      if (outerProofs) removeOwnedTree(outer, outerProofs, storage.dataRoot);
      // The only cache tree allowed here was verified before publication; require its own marker and identities.
      const transactionRoot = path.dirname(stageRoot);
      if (externalPathExists(transactionRoot)) {
        verifyExternalMarker(storage, transactionRoot, record, true);
        const remainder = treeProofs(transactionRoot, storage.cacheRoot);
        for (const info of remainder) {
          const proof = stageProofs.find(original => original.path === info.path);
          if (!proof || proof.dev !== info.dev || proof.ino !== info.ino || (proof.kind === "file" && JSON.stringify(proof) !== JSON.stringify(info))) return storageFailure("ROLLBACK_FAILED");
        }
        removeOwnedTree(transactionRoot, remainder, storage.cacheRoot);
      }
      const handle = stagesByPath.get(stageRoot); if (handle) { handle.disposed = true; stagesByPath.delete(stageRoot); }
    } catch { return storageFailure("ROLLBACK_FAILED"); }
    if (error instanceof ExternalStorageError) throw error;
    return storageFailure("STORAGE_FAILED"); // Includes EXDEV: no copying fallback across devices.
  }
}
export async function commitExternalSkill(input: { storage: StorageContext; stageRoot: string; record: ExternalSkillRecord; state: ExternalSkillStateStore }): Promise<ExternalCommitted> {
  try { return await commitExternalSkillImpl(input); }
  catch (error) { if (error instanceof ExternalStorageError) throw error; return storageFailure("STORAGE_FAILED"); }
}
/** Main-only release after successful rescan. Exact transaction, memory only; never removes installed bytes. */
export function finalizeExternalSkillCommit(input: { storage: StorageContext; record: ExternalSkillRecord }): void {
  committedTransactions.delete(transactionKey(input.storage, input.record));
}
/** Main-only rollback of this run's new disabled commit when the one required rescan fails. */
export function rollbackExternalSkill(input: { storage: StorageContext; record: ExternalSkillRecord; state: ExternalSkillStateStore }): void {
  const { storage, record, state } = input, key = transactionKey(storage, record), owned = committedTransactions.get(key);
  try {
    if (!owned) return storageFailure("ROLLBACK_FAILED");
    const current = state.read(record.id);
    if (!current || current.enabled || current.status !== "committed" || JSON.stringify(current) !== JSON.stringify(owned.record)
      || JSON.stringify({ ...record, status: "committed", enabled: false }) !== JSON.stringify(owned.record)) return storageFailure("ROLLBACK_FAILED");
    assertExternalIdentity(owned.state, storage.stateRoot);
    verifyExternalInstallation(storage, current);
    for (const proof of owned.content) assertExternalIdentity(proof, storage.dataRoot);
    const outer = path.join(storage.dataRoot, "skills", record.id), actual = treeProofs(outer, storage.dataRoot);
    if (actual.length !== owned.content.length) return storageFailure("ROLLBACK_FAILED");
    state.removeOwned(record.id, record.transactionId);
    removeOwnedTree(outer, owned.content, storage.dataRoot); committedTransactions.delete(key);
  } catch { return storageFailure("ROLLBACK_FAILED"); }
}
/** Startup-only, before registry scanning or any external writer. Never commits or enables an entry. */
export function recoverExternalSkills(storage: StorageContext, state: ExternalSkillStateStore): void {
  state.recoverStartup(storage);
}
