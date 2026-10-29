import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import type { ExternalCommitted, ExternalPrepared, ExternalResult, ExternalSkill, ExternalSkillErrorCode, ExternalSkillSourceId, ExternalSkillSelection, ExternalSkillRevisions } from "../../shared/external-skills";
import type { ExternalOwner, ExternalServiceDeps, ExternalSkillRecord } from "./external-types";
import { createExternalFetcher, ExternalFetchError, type ExternalFetcher, type ExternalTree, type ExternalRequestDiagnostic } from "./external-fetch";
import { discoverExternalSkills, verifyExternalSkillDeclaration } from "./external-sources";
import { digestExternalFiles, evaluateExternalSkill } from "./external-review";
import { EXTERNAL_LIMITS, EXTERNAL_SOURCES, externalSkillId, reviewPolicyFor } from "./external-policy";
import { isExternalSkillSelection, reviewedExternalSkill } from "./external-revisions";
import { parseSkillMatter } from "./skill-frontmatter";
import { ExternalSkillStateStore, ExternalStorageError, verifyExternalInstallation, assertExternalIdentity } from "./external-state";
import { stageExternalSkill, discardExternalStage, commitExternalSkill, finalizeExternalSkillCommit, rollbackExternalSkill, type ExternalStageHandle } from "./external-install";

// Finite service-wide reuse, not a growing cache of every browsed Skill/revision.
const BLOB_CACHE_BYTES = EXTERNAL_LIMITS.totalBytes;
const BLOB_CACHE_ENTRIES = EXTERNAL_LIMITS.files;
const TOKEN_DIAGNOSTICS = 200;
const clone = <T>(value: T): T => structuredClone(value);
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const frameKey = (owner: ExternalOwner) => `${owner.webContentsId}/${owner.frameProcessId}/${owner.frameRoutingId}`;
const sameOwner = (left: ExternalOwner, right: ExternalOwner) => frameKey(left) === frameKey(right) && left.generation === right.generation;
const failure = (code: ExternalSkillErrorCode, retryable = false, retryAt?: number): ExternalResult<never> => ({ ok: false, code, error: new ExternalFetchError(code).message, retryable, ...(retryAt === undefined ? {} : { retryAt }) });
const resultError = (error: unknown): ExternalResult<never> => error instanceof ExternalFetchError ? failure(error.code, error.retryable, error.retryAt)
  : error instanceof ExternalStorageError ? failure(error.code) : failure("STORAGE_FAILED");
function deny(code: ExternalSkillErrorCode, retryable = false): never { throw new ExternalFetchError(code, retryable); }
interface FrameLease { generation: number }
interface OwnerStamp { owner: ExternalOwner; frame: FrameLease }
interface Operation { stamp: OwnerStamp; controller: AbortController; kind: "read" | "prepare" | "commit"; operation: "list" | "detail" | "prepare" | "commit"; requestCount: number; sourceId?: ExternalSkillSourceId; snapshotKey?: string; prepareDeadline?: number; error?: ExternalFetchError }
interface Content { skill: ExternalSkill; payload: ReadonlyMap<string, Buffer> }
interface Snapshot {
  key: string; kind: ExternalSkillSelection["kind"]; pinnedCommit?: string;
  sourceId: ExternalSkillSourceId; controller: AbortController; ready: Promise<void>; tree?: ExternalTree;
  candidates: readonly ExternalSkill[]; declarations: Map<string, string>; content?: Content;
  pendingContent?: { id: string; promise: Promise<Content> };
  preview?: ExternalSkill;
  pendingPreview?: { id: string; promise: Promise<ExternalSkill> };
  pendingDeclaration?: { id: string; promise: Promise<ExternalSkill> };
}
interface Transaction {
  owner: ExternalOwner; op: Operation; sourceId: ExternalSkillSourceId; snapshot?: Snapshot;
  status: "downloading" | "ready" | "committing"; done?: Promise<unknown>; record?: ExternalSkillRecord;
  handle?: ExternalStageHandle; token?: string; expiresAt?: number; expiryTimer?: ReturnType<typeof setTimeout>;
}

/** Main-only service. Renderer supplies IDs/one-use credentials, never inventories, paths or approvals. */
export function createExternalSkillService(deps: ExternalServiceDeps) {
  const reviews = freeze(clone(deps.reviews));
  const state = new ExternalSkillStateStore(deps.storage, deps.host);
  const snapshots = new Map<string, Snapshot>(); // one latest and one reviewed snapshot per source: at most four
  const trees = new Map<ExternalSkillSourceId, ExternalTree>(); // one immutable tree per fixed source
  const blobs = new Map<string, Buffer>();
  const frames = new Map<string, FrameLease>(); // live frame leases only; invalidate releases the entry
  const invalidTokens = new Map<string, ExternalSkillErrorCode>();
  const operations = new Set<Operation>(), pending = new Set<Promise<unknown>>();
  const meters = new WeakMap<AbortSignal, Operation>();
  function diagnose(diagnostic: ExternalRequestDiagnostic, op?: Operation): void {
    try { deps.diagnose?.({ ...diagnostic, ...(op ? { operation: op.operation, requestCount: op.requestCount } : {}) }); } catch { /* Diagnostic sinks cannot change authority or results. */ }
  }
  let blobBytes = 0, activeRequests = 0, transaction: Transaction | undefined, disposed = false;
  let rateLimitedUntil = 0;
  let cooldownCause: Pick<ExternalRequestDiagnostic, "remaining" | "retryAfter" | "reset" | "serverTime" | "deadlineSource"> = {};
  function checkRateLimit(): void { if (deps.now() < rateLimitedUntil) throw new ExternalFetchError("RATE_LIMITED", true, { retryAt: rateLimitedUntil }); }
  let disposal: Promise<void> | undefined;
  let retainedStage: ExternalStageHandle | undefined; // at most one failed cleanup; preserve its exact authority
  const queue: Array<{ signal: AbortSignal; enter: () => void }> = [];

  function remember(token: string | undefined, code: ExternalSkillErrorCode): void {
    if (!token) return;
    invalidTokens.delete(token); invalidTokens.set(token, code);
    while (invalidTokens.size > TOKEN_DIAGNOSTICS) invalidTokens.delete(invalidTokens.keys().next().value!);
  }
  function abort(op: Operation, code: ExternalSkillErrorCode): void {
    if (op.kind === "commit" || op.error) return;
    op.error = new ExternalFetchError(code, code === "PREPARE_TIMEOUT"); op.controller.abort();
  }
  function check(op: Operation): void {
    if (op.error) throw op.error;
    if (op.prepareDeadline !== undefined && deps.now() >= op.prepareDeadline) { abort(op, "PREPARE_TIMEOUT"); throw op.error; }
    const current = frames.get(frameKey(op.stamp.owner));
    if (current !== op.stamp.frame || current.generation !== op.stamp.owner.generation) deny("STALE_SNAPSHOT");
    if (disposed && op.kind !== "commit") deny("FORBIDDEN");
  }
  function cleanup(tx: Transaction, code: ExternalSkillErrorCode): void {
    remember(tx.token, code); clearTimeout(tx.expiryTimer);
    try { if (tx.handle) discardExternalStage(deps.storage, tx.handle); }
    catch (error) { retainedStage = tx.handle; throw error; }
    finally { if (transaction === tx) transaction = undefined; }
  }
  function discardRetained(): void {
    if (retainedStage) { discardExternalStage(deps.storage, retainedStage); retainedStage = undefined; }
  }
  function invalidateOwner(owner: ExternalOwner): void {
    const current = frames.get(frameKey(owner));
    if (current?.generation === owner.generation) frames.delete(frameKey(owner));
    for (const op of operations) if (sameOwner(op.stamp.owner, owner)) abort(op, "STALE_SNAPSHOT");
    if (transaction && sameOwner(transaction.owner, owner) && transaction.status !== "committing") {
      remember(transaction.token, "STALE_SNAPSHOT");
      if (transaction.status === "ready") cleanup(transaction, "STALE_SNAPSHOT"); else abort(transaction.op, "STALE_SNAPSHOT");
    }
  }
  function begin(owner: ExternalOwner, kind: Operation["kind"], operation: Operation["operation"]): Operation {
    if (disposed) deny("FORBIDDEN");
    if (!owner || ![owner.webContentsId, owner.frameProcessId, owner.frameRoutingId, owner.generation].every(value => Number.isSafeInteger(value) && value >= 0)) deny("FORBIDDEN");
    const key = frameKey(owner), current = frames.get(key);
    if (current && owner.generation < current.generation) deny("STALE_SNAPSHOT");
    if (current && owner.generation > current.generation) invalidateOwner({ ...owner, generation: current.generation });
    if (!current || owner.generation > current.generation) frames.set(key, { generation: owner.generation });
    const op: Operation = { stamp: { owner: { ...owner }, frame: frames.get(key)! }, controller: new AbortController(), kind, operation, requestCount: 0 };
    meters.set(op.controller.signal, op); operations.add(op); return op;
  }
  function track<T>(promise: Promise<T>): Promise<T> {
    pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise;
  }
  function perform<T>(owner: ExternalOwner, kind: Operation["kind"], action: (op: Operation) => Promise<T>, operation: Operation["operation"] = kind === "read" ? "list" : kind): Promise<ExternalResult<T>> {
    let op: Operation;
    try { op = begin(owner, kind, operation); } catch (error) { return Promise.resolve(resultError(error)); }
    const promise = (async (): Promise<ExternalResult<T>> => {
      try { const output = await action(op); if (kind !== "commit") check(op); return { ok: true, value: output }; }
      catch (error) { return resultError(error instanceof ExternalStorageError ? error : op.error ?? error); }
      finally { operations.delete(op); }
    })();
    return track(promise);
  }
  function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new ExternalFetchError("CANCELLED"));
    return new Promise<T>((resolve, reject) => {
      const cancel = () => { reject(new ExternalFetchError("CANCELLED")); };
      signal.addEventListener("abort", cancel, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    });
  }
  async function slot(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) deny("CANCELLED");
    if (activeRequests >= EXTERNAL_LIMITS.concurrency) {
      await new Promise<void>((resolve, reject) => {
        const item = { signal, enter: () => { signal.removeEventListener("abort", cancel); resolve(); } };
        const cancel = () => { const index = queue.indexOf(item); if (index !== -1) queue.splice(index, 1); reject(new ExternalFetchError("CANCELLED")); };
        signal.addEventListener("abort", cancel, { once: true }); queue.push(item);
      });
    } else activeRequests++;
    if (signal.aborted) { releaseSlot(); deny("CANCELLED"); }
    return releaseSlot;
  }
  function releaseSlot(): void {
    const next = queue.shift(); if (next) next.enter(); else activeRequests--;
  }
  async function limited<T>(signal: AbortSignal, target: Pick<ExternalRequestDiagnostic, "sourceId" | "stage">, work: () => Promise<T>): Promise<T> {
    const release = await slot(signal);
    try { checkRateLimit(); return await work(); }
    catch (error) {
      if (error instanceof ExternalFetchError && error.code === "RATE_LIMITED" && error.retryAt !== undefined) {
        if (error.retryAt > rateLimitedUntil) {
          rateLimitedUntil = error.retryAt;
          const cause = error.diagnostic;
          cooldownCause = { remaining: cause?.remaining ?? null, retryAfter: cause?.retryAfter ?? null,
            reset: cause?.reset ?? null, serverTime: cause?.serverTime ?? null, deadlineSource: cause?.deadlineSource };
        }
        if (!error.diagnostic) {
          const diagnostic: ExternalRequestDiagnostic = { ...target, ...cooldownCause, status: null, contentType: "missing",
            bytes: 0, errorClass: "ExternalFetchError", code: "RATE_LIMITED", retryAt: rateLimitedUntil };
          // Discovery/declaration catch paths recognize this local diagnostic.
          error.diagnostic = diagnostic; diagnose(diagnostic, meters.get(signal));
        }
      }
      throw error;
    } finally { release(); }
  }
  const remote = createExternalFetcher(deps.fetch, { now: deps.now, beforeRequest: checkRateLimit,
    onRequest: signal => { const op = meters.get(signal); if (op && op.requestCount < Number.MAX_SAFE_INTEGER) op.requestCount++; },
    onDiagnostic: (diagnostic, signal) => diagnose(diagnostic, meters.get(signal)),
  });
  const fetcher: ExternalFetcher = {
    resolveCommit: (sourceId, signal) => limited(signal, { sourceId, stage: "metadata" }, () => remote.resolveCommit(sourceId, signal)),
    async readTree(sourceId, commit, signal) {
      if (signal.aborted) deny("CANCELLED");
      const existing = trees.get(sourceId); if (existing?.commit === commit) return existing;
      const tree = await limited(signal, { sourceId, stage: "tree" }, () => remote.readTree(sourceId, commit, signal));
      if (signal.aborted) deny("CANCELLED"); trees.set(sourceId, freeze(tree)); return tree;
    },
    async readBlob(sourceId, sha, limit, signal, stage) {
      if (signal.aborted) deny("CANCELLED");
      const key = sourceId + "/" + sha, cached = blobs.get(key);
      if (cached) { if (cached.length > limit) deny("LIMIT_EXCEEDED"); blobs.delete(key); blobs.set(key, cached); return Buffer.from(cached); }
      const bytes = await limited(signal, { sourceId, stage: stage ?? "blob" }, () => remote.readBlob(sourceId, sha, limit, signal, stage));
      if (signal.aborted) deny("CANCELLED");
      const previous = blobs.get(key); if (previous) { blobs.delete(key); blobBytes -= previous.length; }
      blobs.set(key, Buffer.from(bytes)); blobBytes += bytes.length;
      while (blobBytes > BLOB_CACHE_BYTES || blobs.size > BLOB_CACHE_ENTRIES) { const oldest = blobs.keys().next().value!; blobBytes -= blobs.get(oldest)!.length; blobs.delete(oldest); }
      return bytes;
    },
  };
  function source(sourceId: ExternalSkillSourceId): void {
    if (typeof sourceId !== "string" || !Object.hasOwn(EXTERNAL_SOURCES, sourceId)) deny("SOURCE_INVALID");
  }
  function checkSnapshot(snapshot: Snapshot, op: Operation): void {
    check(op); if (snapshots.get(snapshot.key) !== snapshot || snapshot.controller.signal.aborted) deny("STALE_SNAPSHOT");
  }
  function invalidateSnapshot(old: Snapshot): void {
    old.controller.abort(); if (snapshots.get(old.key) === old) snapshots.delete(old.key);
    for (const op of operations) if (op.snapshotKey === old.key) abort(op, "STALE_SNAPSHOT");
    old.content = undefined; old.pendingContent = undefined; old.preview = undefined; old.pendingPreview = undefined; old.pendingDeclaration = undefined;
    const tx = transaction;
    if (tx?.snapshot === old && tx.status !== "committing") {
      remember(tx.token, "STALE_SNAPSHOT"); if (tx.status === "ready") cleanup(tx, "STALE_SNAPSHOT"); else abort(tx.op, "STALE_SNAPSHOT");
    }
  }
  function refresh(sourceId: ExternalSkillSourceId): void {
    for (const old of snapshots.values()) if (old.sourceId === sourceId) invalidateSnapshot(old);
    for (const op of operations) if (op.sourceId === sourceId) abort(op, "STALE_SNAPSHOT");
  }
  async function snapshot(op: Operation, sourceId: ExternalSkillSourceId, selection?: ExternalSkillSelection, id?: string): Promise<Snapshot> {
    source(sourceId); check(op); op.sourceId = sourceId;
    if (selection !== undefined && !isExternalSkillSelection(selection)) deny("FORBIDDEN");
    const kind = selection?.kind ?? "latest", key = sourceId + "/" + kind;
    let pinnedCommit: string | undefined;
    if (kind === "reviewed") {
      const review = reviewedExternalSkill(sourceId, id ?? "", reviews); if (!review) deny("REVIEW_REQUIRED");
      if (selection!.commit !== review.commit) deny("STALE_SNAPSHOT"); pinnedCommit = review.commit;
    }
    let current = snapshots.get(key);
    if (current && current.pinnedCommit !== pinnedCommit) { invalidateSnapshot(current); current = undefined; }
    if (!current) {
      const controller = new AbortController();
      current = { key, kind, pinnedCommit, sourceId, controller, candidates: [], declarations: new Map(), ready: Promise.resolve() };
      const owned = current; snapshots.set(key, owned);
      const onAbort = () => controller.abort(); op.controller.signal.addEventListener("abort", onAbort, { once: true });
      // Discovery has its own child signal. Count actual requests for the operation
      // creating the snapshot, never for simultaneous readers waiting on that work.
      const counted = (signal: AbortSignal) => { meters.set(signal, op); return signal; };
      const capturing: ExternalFetcher = {
        resolveCommit: (id, signal) => fetcher.resolveCommit(id, counted(signal)),
        async readTree(id, commit, signal) { const tree = await fetcher.readTree(id, commit, counted(signal)); owned.tree = tree; return tree; },
        readBlob: (id, sha, limit, signal, stage) => fetcher.readBlob(id, sha, limit, counted(signal), stage),
      };
      owned.ready = (async () => {
        try {
          const candidates = await discoverExternalSkills(sourceId, capturing, controller.signal, owned.declarations, item => diagnose(item, op), pinnedCommit);
          checkSnapshot(owned, op); owned.candidates = freeze(candidates);
        } catch (error) { if (snapshots.get(key) === owned) snapshots.delete(key); throw error; }
        finally { op.controller.signal.removeEventListener("abort", onAbort); }
      })();
    }
    op.snapshotKey = key;
    try { await waitFor(current.ready, op.controller.signal); }
    catch (error) { check(op); if (snapshots.get(key) !== current) { if (current.controller.signal.aborted) deny("STALE_SNAPSHOT"); } throw error; }
    checkSnapshot(current, op);
    if (selection && current.tree?.commit !== selection.commit) deny("STALE_SNAPSHOT");
    return current;
  }
  /** A built-in Skill of the same name already exists; the market never installs a second copy. */
  const builtIn = (skill: Pick<ExternalSkill, "upstreamName">) => deps.builtInSkillIds?.().has(skill.upstreamName) === true;
  function present(skill: ExternalSkill, kind: ExternalSkillSelection["kind"]): ExternalSkill {
    const latest = snapshots.get(skill.sourceId + "/latest")?.candidates.find(item => item.id === skill.id);
    const reviewed = reviewedExternalSkill(skill.sourceId, skill.id, reviews);
    let installed: ExternalSkillRevisions["installed"], installedError: ExternalSkillRevisions["installedError"];
    const record = state.read(skill.id);
    if (record?.status === "committed") {
      try {
        const proofs = verifyExternalInstallation(deps.storage, record);
        for (const proof of proofs) assertExternalIdentity(proof, deps.storage.dataRoot);
        installed = { commit: record.skill.commit, contentSha256: record.contentSha256, enabled: record.enabled,
          ...(record.reviewPolicyVersion ? { policyVersion: record.reviewPolicyVersion } : {}) };
      } catch { installedError = "STATE_INVALID"; }
    } else if (record || state.getDiagnostic(skill.id)) installedError = "STATE_INVALID";
    return { ...clone(skill), ...(builtIn(skill) ? { builtIn: true as const } : {}), selection: { kind, commit: skill.commit }, revisions: {
      ...(latest ? { latest: { commit: latest.commit } } : {}),
      ...(reviewed ? { reviewed: { commit: reviewed.commit, contentSha256: reviewed.contentSha256, policyVersion: reviewed.policyVersion, reviewedAt: reviewed.reviewedAt } } : {}),
      ...(installed ? { installed } : {}), ...(installedError ? { installedError } : {}),
    } };
  }
  function candidate(snapshot: Snapshot, id: string): ExternalSkill {
    if (typeof id !== "string") deny("CATALOG_INVALID");
    const selected = snapshot.candidates.find(skill => skill.id === id); if (!selected) deny("CATALOG_INVALID"); return selected;
  }
  function inventoryFor(current: Snapshot, selected: ExternalSkill): ExternalTree["entries"] {
    const tree = current.tree; if (!tree || tree.commit !== selected.commit) deny("TREE_INVALID");
    const inventory = tree.entries.filter(entry => entry.type === "blob" && entry.path.startsWith(selected.path + "/"));
    if (!inventory.length) deny("TREE_INVALID");
    if (inventory.length > EXTERNAL_LIMITS.files) deny("LIMIT_EXCEEDED");
    let total = 0;
    for (const entry of inventory) { if (entry.size === undefined || entry.size > EXTERNAL_LIMITS.fileBytes) deny("LIMIT_EXCEEDED"); total += entry.size; }
    if (total > EXTERNAL_LIMITS.totalBytes) deny("LIMIT_EXCEEDED");
    return inventory;
  }
  async function declared(op: Operation, current: Snapshot, id: string): Promise<ExternalSkill> {
    checkSnapshot(current, op); const selected = candidate(current, id);
    if (selected.declaration !== "pending") return selected;
    if (current.pendingDeclaration) {
      if (current.pendingDeclaration.id !== id) deny("BUSY");
      const verified = await waitFor(current.pendingDeclaration.promise, op.controller.signal); checkSnapshot(current, op); return verified;
    }
    const tree = current.tree, root = current.declarations.get(id);
    if (!tree || tree.commit !== selected.commit || root === undefined) deny("TREE_INVALID");
    const work = (async () => {
      const verified = freeze(await verifyExternalSkillDeclaration(selected, root, tree, fetcher, op.controller.signal, item => diagnose(item, op)));
      checkSnapshot(current, op); current.candidates = freeze(current.candidates.map(skill => skill.id === id ? verified : skill)); return verified;
    })();
    current.pendingDeclaration = { id, promise: work };
    try { return await work; } finally { if (current.pendingDeclaration?.promise === work) current.pendingDeclaration = undefined; }
  }
  function introduction(skill: ExternalSkill, bytes: Buffer): ExternalSkill {
    const result = clone(skill);
    try {
      const data = parseSkillMatter(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).data;
      const label = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
      if (label(data.name)) result.upstreamName = data.name;
      if (label(data.description)) result.description = data.description;
      if (label(data.version)) result.version = data.version;
    } catch { result.blockers.push("DEPENDENCY_BLOCKED"); }
    return result;
  }
  async function preview(op: Operation, current: Snapshot, id: string): Promise<ExternalSkill> {
    checkSnapshot(current, op);
    if (current.preview?.id === id) return current.preview;
    if (current.pendingPreview) {
      if (current.pendingPreview.id !== id) deny("BUSY");
      const result = await waitFor(current.pendingPreview.promise, op.controller.signal); checkSnapshot(current, op); return result;
    }
    const work = (async () => {
      const selected = await declared(op, current, id); checkSnapshot(current, op);
      if (selected.review === "blocked") return selected;
      const inventory = inventoryFor(current, selected), entry = inventory.find(file => file.path === selected.path + "/SKILL.md");
      if (!entry) deny("TREE_INVALID");
      const complete = current.content?.skill.id === id ? current.content : undefined;
      const bytes = complete?.payload.get(entry.path) ?? await fetcher.readBlob(selected.sourceId, entry.sha, EXTERNAL_LIMITS.fileBytes, op.controller.signal);
      checkSnapshot(current, op); if (bytes.length !== entry.size) deny("BLOB_MISMATCH");
      // Introduction and tree metadata do not prove compatibility, license
      // coverage or the complete content digest. Only prepare performs that audit.
      const skill = introduction({ ...clone(selected), files: [], licenses: [], review: "unreviewed",
        dependencyIssues: complete?.skill.dependencyIssues ?? selected.dependencyIssues,
        blockers: [...new Set([...selected.blockers, ...(complete?.skill.blockers ?? []), "REVIEW_REQUIRED" as const])] }, bytes);
      const result = freeze({ ...skill, preview: { complete: false as const, files: inventory.length,
        bytes: inventory.reduce((sum, file) => sum + file.size!, 0),
        licenseFiles: inventory.filter(file => /(?:^|\/)(?:licen[cs]e|copying|notice)(?:\.[^/]+)?$/i.test(file.path))
          .map(file => ({ path: file.path, blobSha1: file.sha, bytes: file.size! })),
      } });
      checkSnapshot(current, op); current.preview = result; return result;
    })();
    current.pendingPreview = { id, promise: work };
    try { return await work; } finally { if (current.pendingPreview?.promise === work) current.pendingPreview = undefined; }
  }
  async function content(op: Operation, current: Snapshot, id: string): Promise<Content> {
    checkSnapshot(current, op); let selected = candidate(current, id);
    if (selected.review === "blocked") return { skill: selected, payload: new Map() };
    if (current.content?.skill.id === id) return current.content;
    if (current.pendingContent) {
      if (current.pendingContent.id !== id) deny("BUSY");
      const complete = await waitFor(current.pendingContent.promise, op.controller.signal); checkSnapshot(current, op); return complete;
    }
    const work = (async (): Promise<Content> => {
      selected = await declared(op, current, id); checkSnapshot(current, op);
      if (selected.declaration === "blocked") {
        const blocked = { skill: selected, payload: new Map<string, Buffer>() }; current.content = blocked; return blocked;
      }
      const inventory = inventoryFor(current, selected);
      const payload = new Map<string, Buffer>(); let next = 0, total = 0;
      async function worker(): Promise<void> {
        while (next < inventory.length) {
          checkSnapshot(current, op); const entry = inventory[next++];
          const bytes = await fetcher.readBlob(selected.sourceId, entry.sha, EXTERNAL_LIMITS.fileBytes, op.controller.signal);
          checkSnapshot(current, op); if (bytes.length !== entry.size) deny("BLOB_MISMATCH");
          total += bytes.length; if (total > EXTERNAL_LIMITS.totalBytes) deny("LIMIT_EXCEEDED"); payload.set(entry.path, bytes);
        }
      }
      try { await Promise.all(Array.from({ length: Math.min(EXTERNAL_LIMITS.concurrency, inventory.length) }, () => worker())); }
      catch (error) { if (!op.error) { op.error = error instanceof ExternalFetchError ? error : new ExternalFetchError("NETWORK_FAILED", true); op.controller.abort(); } throw error; }
      checkSnapshot(current, op);
      const files = inventory.map(entry => { const bytes = payload.get(entry.path)!; return { path: entry.path, blobSha1: entry.sha, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length }; });
      let skill = introduction({ ...clone(selected), files }, payload.get(selected.path + "/SKILL.md")!);
      const modes = inventory.filter(entry => entry.mode !== "100644");
      if (modes.length) {
        skill.blockers.push("DEPENDENCY_BLOCKED");
        skill = { ...skill, dependencyIssues: [...(skill.dependencyIssues ?? []), ...modes.map(entry => ({ kind: "file-mode" as const, path: entry.path }))].slice(0, EXTERNAL_LIMITS.files) };
      }
      // Ancestor evidence cannot be mapped safely into this MVP payload. Never silently omit it.
      if (reviews.some(review => review && review.sourceId === selected.sourceId && review.commit === selected.commit && review.path === selected.path &&
        Array.isArray(review.licenses) && review.licenses.some(license => license && typeof license.path === "string" &&
          (!license.path.startsWith(selected.path + "/") || Array.isArray(license.covers) && license.covers.some(path => typeof path === "string" && !path.startsWith(selected.path + "/")))))) skill.blockers.push("LICENSE_BLOCKED");
      skill = freeze(evaluateExternalSkill(skill, payload, reviews));
      const complete = { skill, payload }; checkSnapshot(current, op); current.content = complete; current.preview = undefined; return complete;
    })();
    current.pendingContent = { id, promise: work };
    try { return await work; } finally { if (current.pendingContent?.promise === work) current.pendingContent = undefined; }
  }
  function deadline(op: Operation): ReturnType<typeof setTimeout> {
    return setTimeout(() => abort(op, "PREPARE_TIMEOUT"), op.prepareDeadline === undefined ? EXTERNAL_LIMITS.prepareMs : Math.max(0, op.prepareDeadline - deps.now()));
  }
  function eligible(skill: ExternalSkill): void {
    if (skill.preview !== undefined) deny("REVIEW_REQUIRED");
    if (skill.declaration !== "verified") deny("DEPENDENCY_BLOCKED");
    if (skill.review !== "approved" || skill.blockers.length) deny(skill.blockers.find(code => code !== "REVIEW_REQUIRED") ?? "REVIEW_REQUIRED");
  }
  function expire(tx: Transaction): void {
    if (transaction !== tx || tx.status !== "ready") return;
    // Injected clock is authoritative; the one deadline is never slid or renewed.
    if (deps.now() >= tx.expiresAt!) cleanup(tx, "TOKEN_EXPIRED");
  }
  return {
    list(owner: ExternalOwner, sourceId: ExternalSkillSourceId, explicitRefresh = false): Promise<ExternalResult<ExternalSkill[]>> {
      return perform(owner, "read", async op => {
        source(sourceId); if (explicitRefresh) refresh(sourceId);
        const current = await snapshot(op, sourceId);
        const result = current.candidates.map(skill => present(current.content?.skill.id === skill.id ? current.content.skill : current.preview?.id === skill.id ? current.preview : skill, "latest"));
        const ids = new Set(result.map(skill => skill.id));
        for (const review of reviews) {
          if (review?.sourceId !== sourceId || typeof review.path !== "string") continue;
          const id = externalSkillId(sourceId, EXTERNAL_SOURCES[sourceId].repository, review.path);
          const approved = reviewedExternalSkill(sourceId, id, reviews);
          if (!approved || ids.has(id)) continue;
          if (result.length >= EXTERNAL_LIMITS.candidates) deny("LIMIT_EXCEEDED"); ids.add(id);
          const name = approved.path.split("/").at(-1)!;
          result.push(present({ id, sourceId, repository: EXTERNAL_SOURCES[sourceId].repository, path: approved.path, commit: approved.commit,
            upstreamName: name, description: "", bundle: { name }, files: [], licenses: [], review: "unreviewed", blockers: ["REVIEW_REQUIRED"] }, "reviewed"));
        }
        return result;
      });
    },
    detail(owner: ExternalOwner, sourceId: ExternalSkillSourceId, id: string, selection?: ExternalSkillSelection): Promise<ExternalResult<ExternalSkill>> {
      return perform(owner, "read", async op => { const timer = deadline(op); try {
        const current = await snapshot(op, sourceId, selection, id);
        return present(await preview(op, current, id), current.kind);
      } finally { clearTimeout(timer); } }, "detail");
    },
    prepare(owner: ExternalOwner, sourceId: ExternalSkillSourceId, id: string, selection?: ExternalSkillSelection): Promise<ExternalResult<ExternalPrepared>> {
      const startedAt = deps.now();
      if (!Number.isSafeInteger(startedAt) || startedAt < 0 || !Number.isSafeInteger(startedAt + EXTERNAL_LIMITS.prepareMs)) return Promise.resolve(failure("STATE_INVALID"));
      try { discardRetained(); if (transaction?.status === "ready") expire(transaction); } catch (error) { return Promise.resolve(resultError(error)); }
      if (transaction) return Promise.resolve(failure("BUSY"));
      let tx: Transaction | undefined;
      const promise = perform(owner, "prepare", async op => {
        op.prepareDeadline = startedAt + EXTERNAL_LIMITS.prepareMs; check(op);
        source(sourceId); state.assertWritable(deps.storage);
        tx = { owner: { ...owner }, op, sourceId, status: "downloading" }; transaction = tx;
        const timer = deadline(op);
        try {
          const current = await snapshot(op, sourceId, selection, id); tx.snapshot = current;
          const listed = current.candidates.find(skill => skill.id === id);
          if (listed && builtIn(listed)) deny("TARGET_EXISTS");
          const complete = await content(op, current, id);
          if (builtIn(complete.skill)) deny("TARGET_EXISTS"); checkSnapshot(current, op); eligible(complete.skill);
          state.assertWritable(deps.storage);
          // Declaration is a read-only DTO hint, never part of the strict persisted schema.
          const { declaration: _declaration, preview: _preview, selection: _selection, revisions: _revisions,
            dependencyIssues: _issues, compatibilityFormat: _format, ...persistedSkill } = complete.skill;
          const record: ExternalSkillRecord = freeze({ schema: 1, id: complete.skill.id, transactionId: randomUUID(), status: "prepared", enabled: false,
            skill: persistedSkill, contentSha256: digestExternalFiles(complete.skill.files), reviewPolicyVersion: reviewPolicyFor(sourceId) });
          tx.record = record; tx.handle = stageExternalSkill(deps.storage, record, complete.payload); checkSnapshot(current, op);
          const token = deps.randomToken(); if (!/^[a-f0-9]{64}$/.test(token) || invalidTokens.has(token)) deny("STATE_INVALID");
          const publicSkill = present(complete.skill, current.kind);
          const completedAt = deps.now();
          if (!Number.isSafeInteger(completedAt) || completedAt < 0 || !Number.isSafeInteger(completedAt + EXTERNAL_LIMITS.approvalMs)) deny("STATE_INVALID");
          check(op); op.prepareDeadline = undefined; // Preparation is complete; approval has its separate fixed TTL.
          tx.token = token; tx.expiresAt = completedAt + EXTERNAL_LIMITS.approvalMs; tx.status = "ready";
          tx.expiryTimer = setTimeout(() => { try { expire(tx!); } catch { remember(tx!.token, "ROLLBACK_FAILED"); /* Retain unknown/replaced bytes; never broaden cleanup authority. */ } }, EXTERNAL_LIMITS.approvalMs);
          tx.expiryTimer.unref?.();
          return { token, expiresAt: tx.expiresAt, skill: publicSkill, contentSha256: record.contentSha256 };
        } catch (error) { try { cleanup(tx, "TOKEN_INVALID"); } catch (cleanupError) { throw cleanupError; } throw error; }
        finally { clearTimeout(timer); }
      });
      if (tx) tx.done = promise; return promise;
    },
    commit(owner: ExternalOwner, token: string): Promise<ExternalResult<ExternalCommitted>> {
      if (disposed) return Promise.resolve(failure("FORBIDDEN"));
      const tx = transaction;
      if (!tx || tx.status !== "ready" || typeof token !== "string" || token !== tx.token || !sameOwner(tx.owner, owner)) return Promise.resolve(failure(typeof token === "string" && (!tx || token !== tx.token) ? invalidTokens.get(token) ?? "TOKEN_INVALID" : "TOKEN_INVALID"));
      try {
        checkSnapshot(tx.snapshot!, tx.op);
        if (deps.now() >= tx.expiresAt!) { cleanup(tx, "TOKEN_EXPIRED"); return Promise.resolve(failure("TOKEN_EXPIRED")); }
      } catch (error) { try { cleanup(tx, "STALE_SNAPSHOT"); } catch (cleanupError) { return Promise.resolve(resultError(cleanupError)); } return Promise.resolve(resultError(error)); }
      remember(token, "TOKEN_INVALID"); tx.token = undefined; clearTimeout(tx.expiryTimer); tx.status = "committing";
      const promise = perform(owner, "commit", async () => {
        try {
          const committed = await commitExternalSkill({ storage: deps.storage, stageRoot: tx.handle!.stageRoot, record: tx.record!, state });
          try { const count = deps.rescan(); if (!Number.isSafeInteger(count) || count < 0) throw new ExternalStorageError("STORAGE_FAILED"); }
          catch { rollbackExternalSkill({ storage: deps.storage, record: tx.record!, state }); throw new ExternalStorageError("STORAGE_FAILED"); }
          finalizeExternalSkillCommit({ storage: deps.storage, record: tx.record! });
          return committed;
        } finally { cleanup(tx, "TOKEN_INVALID"); }
      });
      tx.done = promise; return promise;
    },
    async cancel(owner: ExternalOwner): Promise<ExternalResult<{ status: "cancelled" | "idle" | "committing" }>> {
      const tx = transaction; if (!tx || !sameOwner(tx.owner, owner)) return { ok: true, value: { status: "idle" } };
      if (tx.status === "committing") return { ok: true, value: { status: "committing" } };
      try {
        if (tx.status === "ready") cleanup(tx, "TOKEN_INVALID");
        else { abort(tx.op, "CANCELLED"); await tx.done; }
        return { ok: true, value: { status: "cancelled" } };
      } catch (error) { return resultError(error); }
    },
    invalidate(owner: ExternalOwner): void { invalidateOwner(owner); },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposed = true;
      disposal = (async () => {
        for (const op of operations) abort(op, "CANCELLED");
        for (const current of snapshots.values()) current.controller.abort();
        let cleanupError: unknown;
        if (transaction?.status === "ready") { try { cleanup(transaction, "TOKEN_INVALID"); } catch (error) { cleanupError = error; } }
        while (pending.size) await Promise.allSettled([...pending]);
        try { discardRetained(); cleanupError = undefined; } catch (error) { cleanupError = error; }
        snapshots.clear(); trees.clear(); blobs.clear(); blobBytes = 0; frames.clear(); invalidTokens.clear();
        if (cleanupError) throw cleanupError;
      })();
      return disposal;
    },
  };
}
