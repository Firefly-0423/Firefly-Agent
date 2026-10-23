import * as fs from "fs";
import { fireflyDataDirectory } from "../../firefly-data-paths";
import * as path from "path";
import { createHash } from "node:crypto";
import { logger, LogTag } from "../../logger";
import { structuredPatch } from "diff";
import type { WorkspaceSnapshot } from "../tools/workspace-handle";
import type { WorkspaceIdentity } from "../tools/workspace-handle";
import type { ToolContext } from "../tools/registry/tool-context";
import { getCurrentLevel } from "../../permission";
import { readWorkspaceReviewSource, reviewIdentityKey } from "./workspace-review-source";
import type {
  ReviewSnapshot,
  ReviewFileChange,
  ReviewHunk,
  ReviewLine,
  ReviewRunStatus,
  ReviewFileMeta,
  ReviewRestoreDetail,
  ReviewRestoreOutcome,
} from "../../../shared/review-types";

type CapturedFileKind = "text" | "large-text" | "binary";
interface JournalCaptureEvent {
  capturedAt: number; contentHash: string; size: number; fileKind: CapturedFileKind;
  exists: boolean; hash: string; displayPath: string; absPath: string; type: "capture";
  identity?: WorkspaceIdentity | null;
  fileAccessLevel?: ToolContext["fileAccessLevel"];
  permissionMode?: ToolContext["permissionMode"];
}
interface JournalRenameEvent {
  at: number; toDisplayPath: string; fromDisplayPath: string; toAbsPath: string; fromAbsPath: string; type: "rename";
}
interface JournalHandleEvent { type: "handle-after"; absPath: string }
interface JournalAliasEvent { type: "handle-alias"; absPath: string; capturePath: string }
export type JournalEvent = JournalCaptureEvent | JournalRenameEvent | JournalHandleEvent | JournalAliasEvent;
interface FileObservation { exists: boolean; content: string | null; meta?: ReviewFileMeta; identity?: WorkspaceIdentity | null }
type RestoreAccounting = { restored: number; skipped: ReviewRestoreDetail[]; failed: ReviewRestoreDetail[] };

function sha256(value: string | Buffer): string {
  const hash = createHash("sha256");
  return (typeof value === "string" ? hash.update(value, "utf8") : hash.update(value)).digest("hex");
}
function errorMessage(err: unknown): string { return err instanceof Error ? err.message : String(err); }
function detectCapturedBytes(data: Buffer, bytes = data.length): { kind: CapturedFileKind; content: Buffer | null; size: number; contentHash: string } {
  if (bytes > 5 * 1024 * 1024) return { kind: "binary", content: null, size: bytes, contentHash: sha256(data) };
  const prefix = data.subarray(0, 8192);
  if (prefix.includes(0)) return { kind: "binary", content: null, size: bytes, contentHash: sha256(data) };
  return { kind: bytes > 1 * 1024 * 1024 ? "large-text" : "text", content: data, size: bytes, contentHash: sha256(data) };
}
function groupJournal(events: JournalEvent[]): { captures: Map<string, JournalCaptureEvent>; renames: JournalRenameEvent[] } {
  const captures = new Map<string, JournalCaptureEvent>();
  const renames: JournalRenameEvent[] = [];
  for (const event of events) { if (event.type === "capture") captures.set(event.hash, event); else if (event.type === "rename") renames.push(event); }
  return { captures, renames };
}
function capturedObservation(bytes: Buffer, identity?: WorkspaceIdentity | null): FileObservation {
  const detected = detectCapturedBytes(bytes);
  return { exists: true, content: detected.content?.toString("utf8") ?? null, meta: { size: bytes.length, hash: sha256(bytes) }, identity };
}

export class RunReviewTracker {
  private readonly root: string;
  constructor(userDataRoot: string) {
    this.root = path.join(fireflyDataDirectory(userDataRoot, "runs"), "reviews");
    try { this.cleanupOldReviews(); } catch { /* 历史目录故障不影响新运行。 */ }
  }
  captureBefore(runId: string, absPath: string, displayPath?: string, snapshot?: WorkspaceSnapshot, context?: ToolContext): void {
    const requested = path.resolve(absPath), display = displayPath || requested;
    if (snapshot) this.appendJournal(runId, { type: "handle-after", absPath: requested });
    let absolute = this.resolveObservationPath(runId, requested, snapshot);
    const captured = (file: string): boolean => {
      const baseline = this.getBeforePath(runId, sha256(file));
      return fs.existsSync(baseline) || fs.existsSync(baseline + ".absent") || fs.existsSync(baseline + ".binary");
    };
    if (captured(absolute)) {
      if (snapshot) this.recordHandleAfter(runId, requested, snapshot);
      else this.persistAfter(runId, absolute, null);
      return;
    }
    const observed = snapshot ?? readWorkspaceReviewSource(requested, context, 5 * 1024 * 1024);
    absolute = this.resolveObservationPath(runId, requested, observed);
    if (captured(absolute)) {
      if (snapshot) this.recordHandleAfter(runId, requested, snapshot);
      else this.persistAfter(runId, absolute, null);
      return;
    }
    const identity = sha256(absolute), baseline = this.getBeforePath(runId, identity);
    fs.mkdirSync(path.dirname(baseline), { recursive: true });
    let detected: ReturnType<typeof detectCapturedBytes> = { kind: "text", content: null, size: 0, contentHash: "" };
    if (!observed.exists) fs.writeFileSync(baseline + ".absent", "", "utf8");
    else {
      if (observed.kind !== "file") throw new Error("Invalid review preimage");
      detected = observed.bytes ? detectCapturedBytes(observed.bytes) : { kind: "binary", content: null, size: observed.size, contentHash: "" };
      if (detected.kind === "binary") fs.writeFileSync(baseline + ".binary", JSON.stringify({ size: detected.size, hash: detected.contentHash }), "utf8");
      else fs.writeFileSync(baseline, detected.content!);
    }
    this.appendJournal(runId, { type: "capture", absPath: absolute, displayPath: display, hash: identity,
      exists: observed.exists, fileKind: detected.kind, size: detected.size, contentHash: detected.contentHash, capturedAt: Date.now(),
      identity: observed.identity, ...(context?.fileAccessLevel ? { fileAccessLevel: context.fileAccessLevel, permissionMode: context.permissionMode } : {}) });
    // Persist unknown before mutation; a crash must not expose an older after-image.
    if (snapshot) this.recordHandleAfter(runId, requested, snapshot);
    else this.persistAfter(runId, absolute, null);
  }
  private aliasTarget(runId: string, file: string): string {
    const aliases = new Map<string, string>();
    for (const event of this.readJournal(runId)) if (event.type === "handle-alias") aliases.set(event.absPath, event.capturePath);
    let target = path.resolve(file);
    for (let index = 0; index <= aliases.size; index++) {
      const next = aliases.get(target);
      if (!next || next === target) return target;
      target = next;
    }
    throw new Error("Review alias cycle");
  }
  private usesCapturedAfter(runId: string): boolean {
    const journal = this.readJournal(runId);
    return journal.some(event => event.type === "handle-after") || journal.some(event => event.type === "capture" && event.fileAccessLevel !== undefined &&
      (event.fileAccessLevel === "project-read-only" || (event.permissionMode !== "allow_all" && getCurrentLevel() === "project-read-only")));
  }
  private resolveObservationPath(runId: string, file: string, snapshot?: WorkspaceSnapshot): string {
    const requested = path.resolve(file), mapped = this.aliasTarget(runId, requested);
    if (mapped !== requested || !this.usesCapturedAfter(runId)) return mapped;
    const spelling = (value: string): string => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    const canonical = snapshot?.canonicalPath ?? requested, identity = reviewIdentityKey(snapshot?.identity);
    const captures = this.readJournal(runId).filter((event): event is JournalCaptureEvent => event.type === "capture" && this.aliasTarget(runId, event.absPath) === event.absPath);
    const identities = identity ? captures.filter(capture => (process.platform !== "win32" || path.parse(capture.absPath).root.toLowerCase() === path.parse(canonical).root.toLowerCase()) &&
      identity === reviewIdentityKey(this.readHandleAfterDirect(runId, capture.absPath)?.identity ?? capture.identity)) : [];
    const spellings = captures.filter(capture => spelling(capture.absPath) === spelling(canonical) || spelling(capture.absPath) === spelling(requested));
    const target = identities[0]?.absPath ?? spellings[0]?.absPath ?? path.resolve(canonical);
    for (const alias of new Set([requested, ...identities.map(capture => capture.absPath), ...spellings.map(capture => capture.absPath)])) {
      if (alias !== target && this.aliasTarget(runId, alias) !== target) this.appendJournal(runId, { type: "handle-alias", absPath: alias, capturePath: target });
    }
    return target;
  }
  recordHandleAfter(runId: string, absPath: string, snapshot?: WorkspaceSnapshot): void {
    const absolute = this.resolveObservationPath(runId, absPath, snapshot);
    let observation: FileObservation | null = null;
    if (snapshot && !snapshot.exists) observation = { exists: false, content: null, identity: null };
    else if (snapshot?.kind === "file" && snapshot.bytes) observation = capturedObservation(snapshot.bytes, snapshot.identity);
    this.persistAfter(runId, absolute, observation);
  }
  recordAfterBatch(runId: string, absPath: string, read: () => WorkspaceSnapshot | Buffer | undefined): void {
    let absolute = this.resolveObservationPath(runId, absPath);
    if (!fs.existsSync(this.getAfterPath(runId, absolute)) && !this.usesCapturedAfter(runId)) return;
    let observed: WorkspaceSnapshot | Buffer | undefined;
    try { observed = read(); } catch { /* A denied or failed read stays unknown. */ }
    if (Buffer.isBuffer(observed)) this.persistAfter(runId, absolute, capturedObservation(observed));
    else {
      absolute = this.resolveObservationPath(runId, absPath, observed);
      this.recordHandleAfter(runId, absolute, observed);
    }
  }
  private getAfterPath(runId: string, absPath: string): string {
    return path.join(this.getRunDir(runId), "after", sha256(path.resolve(absPath)) + ".json");
  }
  private persistAfter(runId: string, absolute: string, observation: FileObservation | null): void {
    const location = this.getAfterPath(runId, absolute), pending = `${location}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(location), { recursive: true });
    fs.writeFileSync(pending, JSON.stringify(observation), "utf8");
    fs.renameSync(pending, location);
  }
  private readHandleAfter(runId: string, absPath: string): FileObservation | undefined {
    return this.readHandleAfterDirect(runId, this.aliasTarget(runId, absPath));
  }
  private readHandleAfterDirect(runId: string, absPath: string): FileObservation | undefined {
    try {
      const value = JSON.parse(fs.readFileSync(this.getAfterPath(runId, absPath), "utf8")) as FileObservation | null;
      if (!value || typeof value.exists !== "boolean" || (value.content !== null && typeof value.content !== "string") ||
        (value.exists && (!value.meta || !Number.isSafeInteger(value.meta.size) || value.meta.size < 0 || (value.meta.hash !== "" && !/^[a-f0-9]{64}$/.test(value.meta.hash))))) return undefined;
      if (value.identity && (!/^[a-f0-9]{32}$/.test(value.identity.deviceId) || !/^[a-f0-9]{32}$/.test(value.identity.fileId))) return undefined;
      return value;
    } catch { return undefined; }
  }
  recordRename(runId: string, fromAbsPath: string, toAbsPath: string, fromDisplayPath?: string, toDisplayPath?: string): void {
    const source = path.resolve(fromAbsPath);
    const destination = path.resolve(toAbsPath);
    const sourceLabel = fromDisplayPath || source;
    const destinationLabel = toDisplayPath || destination;
    this.appendJournal(runId, { type: "rename", fromAbsPath: source, toAbsPath: destination,
      fromDisplayPath: sourceLabel, toDisplayPath: destinationLabel, at: Date.now() });
    logger.info(LogTag.Runtime, `[ReviewTracker] rename: ${sourceLabel} → ${destinationLabel}`);
  }
  readJournal(runId: string): JournalEvent[] {
    const location = this.getJournalPath(runId);
    if (!fs.existsSync(location)) return [];
    const serialized = fs.readFileSync(location, "utf8");
    const journal: JournalEvent[] = [];
    for (const row of serialized.split("\n")) {
      const json = row.trim();
      if (!json) continue;
      try { journal.push(JSON.parse(json) as JournalEvent); } catch { /* 保留其它完整记录。 */ }
    }
    return journal;
  }
  readBeforeContent(runId: string, fileHash: string): string | null {
    const baseline = this.getBeforePath(runId, fileHash);
    const absent = baseline + ".absent", binary = baseline + ".binary";
    if (fs.existsSync(absent)) return null;
    if (fs.existsSync(binary)) return null;
    return fs.existsSync(baseline) ? fs.readFileSync(baseline, "utf8") : null;
  }
  hasReviewData(runId: string): boolean { return this.readJournal(runId).length > 0; }
  finalizeReview(runId: string, startedAt: number, status: ReviewRunStatus): ReviewSnapshot | null {
    const journal = this.readJournal(runId);
    if (journal.length === 0) return null;
    const { captures, renames } = groupJournal(journal);
    const capturedAfter = this.usesCapturedAfter(runId);
    for (const [identity, capture] of captures) if (this.aliasTarget(runId, capture.absPath) !== capture.absPath) captures.delete(identity);
    const changes: ReviewFileChange[] = [];
    const handled = new Set<string>();
    for (const rename of renames) {
      const source = this.aliasTarget(runId, rename.fromAbsPath), destination = this.aliasTarget(runId, rename.toAbsPath);
      const identity = sha256(source);
      const capture = captures.get(identity);
      const before = capture ? this.readBeforeContent(runId, identity) : null;
      const after = capturedAfter ? this.readHandleAfter(runId, destination) : this.readFileSafe(rename.toAbsPath);
      if (!after) continue;
      const change = this.buildFileChange(capture ?? null, before, after, rename.fromDisplayPath, rename.toDisplayPath, rename.toAbsPath, "renamed");
      if (change) { changes.push(change); handled.add(source); handled.add(destination); }
    }
    for (const [identity, capture] of captures) {
      if (handled.has(capture.absPath)) continue;
      const before = this.readBeforeContent(runId, identity);
      const after = capturedAfter ? this.readHandleAfter(runId, capture.absPath) : this.readFileSafe(capture.absPath);
      if (!after) continue;
      let operation: ReviewFileChange["kind"];
      if (!capture.exists && after.exists) operation = "created";
      else if (capture.exists && !after.exists) operation = "deleted";
      else if (capture.exists && after.exists) {
        if (capture.fileKind === "binary" && capture.contentHash) {
          if (capture.contentHash === (after.meta ?? this.computeFileMeta(capture.absPath)).hash) continue;
        } else if (capture.fileKind !== "binary" && before === after.content) continue;
        operation = "modified";
      } else continue;
      const change = this.buildFileChange(capture, before, after, capture.displayPath, capture.displayPath, capture.absPath, operation);
      if (change) changes.push(change);
    }
    if (changes.length === 0) return null;
    const snapshot: ReviewSnapshot = { runId, startedAt, endedAt: Date.now(), status, files: changes };
    this.atomicWriteSnapshot(runId, snapshot);
    logger.info(LogTag.Runtime, `[ReviewTracker] finalized: runId=${runId} files=${changes.length} status=${status}`);
    return snapshot;
  }
  loadReview(runId: string): ReviewSnapshot | null {
    const location = this.getSnapshotPath(runId);
    if (!fs.existsSync(location)) return null;
    try { return JSON.parse(fs.readFileSync(location, "utf8")) as ReviewSnapshot; } catch { return null; }
  }
  finalizeIfPending(runId: string, startedAt: number, status: ReviewRunStatus): ReviewSnapshot | null {
    const snapshot = this.loadReview(runId);
    if (snapshot) return snapshot;
    if (!this.hasReviewData(runId)) return null;
    return this.finalizeReview(runId, startedAt, status);
  }
  restoreRun(runId: string): Omit<ReviewRestoreOutcome, "ok"> {
    const accounting: RestoreAccounting = { restored: 0, skipped: [], failed: [] };
    const journal = this.readJournal(runId);
    if (journal.length === 0) return accounting;
    const captures = new Map<string, JournalCaptureEvent>();
    const renames: JournalRenameEvent[] = [];
    for (const event of journal) { if (event.type === "capture") captures.set(event.hash, event); else if (event.type === "rename") renames.push(event); }
    for (const capture of captures.values()) this.restoreCapture(runId, capture, accounting);
    for (const rename of renames) {
      try { if (fs.existsSync(rename.toAbsPath)) { fs.unlinkSync(rename.toAbsPath); accounting.restored += 1; } }
      catch (failure) { accounting.failed.push({ path: rename.toDisplayPath, reason: errorMessage(failure) }); }
    }
    logger.info(LogTag.Runtime, `[ReviewTracker] restore: runId=${runId} restored=${accounting.restored} skipped=${accounting.skipped.length} failed=${accounting.failed.length}`);
    return accounting;
  }
  private restoreCapture(runId: string, cap: JournalCaptureEvent, outcome: RestoreAccounting): void {
    const baseline = this.getBeforePath(runId, cap.hash);
    const absent = baseline + ".absent", binary = baseline + ".binary";
    try {
      if (fs.existsSync(absent)) { if (fs.existsSync(cap.absPath)) { fs.unlinkSync(cap.absPath); outcome.restored += 1; } return; }
      if (fs.existsSync(binary)) { outcome.skipped.push({ path: cap.displayPath, reason: "二进制文件基线只存元数据，无法恢复内容" }); return; }
      if (fs.existsSync(baseline)) { fs.writeFileSync(cap.absPath, fs.readFileSync(baseline)); outcome.restored += 1; return; }
      outcome.skipped.push({ path: cap.displayPath, reason: "基线数据缺失" });
    } catch (failure) { outcome.failed.push({ path: cap.displayPath, reason: errorMessage(failure) }); }
  }
  cleanupOldReviews(options?: { maxAgeDays?: number; maxDirs?: number; maxBytes?: number }): string[] {
    const days = options?.maxAgeDays ?? 30;
    const directories = options?.maxDirs ?? 200;
    const bytes = options?.maxBytes ?? 500 * 1024 * 1024;
    if (!fs.existsSync(this.root)) return [];
    const candidates: { dirPath: string; mtime: number; size: number }[] = [];
    for (const child of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const location = path.join(this.root, child.name);
      try { candidates.push({ dirPath: location, mtime: fs.statSync(location).mtimeMs, size: this.dirSize(location) }); }
      catch { /* 目录暂不可读时保留。 */ }
    }
    candidates.sort((a, b) => a.mtime - b.mtime);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let total = candidates.reduce((sum, candidate) => sum + candidate.size, 0);
    let count = candidates.length;
    const removed: string[] = [];
    for (const candidate of candidates) {
      if (candidate.mtime >= cutoff && count <= directories && total <= bytes) break;
      try {
        fs.rmSync(candidate.dirPath, { recursive: true, force: true });
        removed.push(candidate.dirPath);
        count -= 1;
        total -= candidate.size;
      } catch { /* 继续尝试其它到期目录。 */ }
    }
    if (removed.length > 0) logger.info(LogTag.Runtime, `[ReviewTracker] cleanup: removed ${removed.length} review dir(s)`);
    return removed;
  }
  private dirSize(dirPath: string): number {
    let bytes = 0;
    const walk = (directory: string): void => {
      for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
        const location = path.join(directory, child.name);
        if (child.isDirectory()) walk(location);
        else if (child.isFile()) { try { bytes += fs.statSync(location).size; } catch { /* 文件可能已移走。 */ } }
      }
    };
    walk(dirPath);
    return bytes;
  }
  private readFileSafe(absPath: string): FileObservation {
    try { const text = fs.readFileSync(absPath, "utf8"); return { exists: true, content: text }; }
    catch { return { exists: false, content: null }; }
  }
  private buildFileChange(cap: JournalCaptureEvent | null, beforeContent: string | null, after: FileObservation,
    oldDisplayPath: string, newDisplayPath: string, afterAbsPath: string, kind: ReviewFileChange["kind"]): ReviewFileChange | null {
    const existed = cap?.exists ?? false;
    const existsNow = after.exists;
    const category = cap?.fileKind;
    if (category === "binary" || (existsNow && after.content === null && after.meta) || category === "large-text") return {
      kind: category === "binary" || (existsNow && after.content === null && after.meta) ? "binary" : "large-text", oldPath: oldDisplayPath, newPath: newDisplayPath, additions: 0, deletions: 0,
      before: existed && cap ? { size: cap.size, hash: cap.contentHash } : undefined,
      after: existsNow ? (after.meta ?? this.computeFileMeta(afterAbsPath)) : undefined,
    };
    if (kind === "created" && after.content !== null) {
      const patch = this.buildFullFileHunks(after.content, "add");
      return { kind: "created", oldPath: oldDisplayPath, newPath: newDisplayPath, additions: patch.additions, deletions: 0, hunks: patch.hunks };
    }
    if (kind === "deleted" && beforeContent !== null) {
      const patch = this.buildFullFileHunks(beforeContent, "remove");
      return { kind: "deleted", oldPath: oldDisplayPath, newPath: newDisplayPath, additions: 0, deletions: patch.deletions, hunks: patch.hunks };
    }
    if (beforeContent === null || after.content === null) return null;
    const patch = this.diffTexts(beforeContent, after.content);
    if (kind === "renamed" && patch.additions === 0 && patch.deletions === 0) return { kind: "renamed", oldPath: oldDisplayPath, newPath: newDisplayPath, additions: 0, deletions: 0 };
    return { kind, oldPath: oldDisplayPath, newPath: newDisplayPath, additions: patch.additions, deletions: patch.deletions, hunks: patch.hunks };
  }
  private diffTexts(before: string, after: string): { hunks: ReviewHunk[]; additions: number; deletions: number } {
    const patch = structuredPatch("", "", before, after, "", "", { context: 3 });
    let added = 0, removed = 0;
    const hunks: ReviewHunk[] = patch.hunks.map((section) => {
      let oldNumber = section.oldStart, newNumber = section.newStart;
      const lines: ReviewLine[] = [];
      for (const encoded of section.lines) {
        const marker = encoded[0], body = encoded.slice(1);
        switch (marker) {
          case "+": lines.push({ type: "add", oldLine: null, newLine: newNumber, text: body }); newNumber += 1; added += 1; break;
          case "-": lines.push({ type: "remove", oldLine: oldNumber, newLine: null, text: body }); oldNumber += 1; removed += 1; break;
          case " ": lines.push({ type: "context", oldLine: oldNumber, newLine: newNumber, text: body }); oldNumber += 1; newNumber += 1; break;
        }
      }
      return { oldStart: section.oldStart, oldLines: section.oldLines, newStart: section.newStart, newLines: section.newLines, lines };
    });
    return { hunks, additions: added, deletions: removed };
  }
  private buildFullFileHunks(content: string, type: "add" | "remove"): { hunks: ReviewHunk[]; additions: number; deletions: number } {
    const rows = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
    const lines: ReviewLine[] = rows.map((text, offset) => type === "add" ? { type: "add", oldLine: null, newLine: offset + 1, text } : { type: "remove", oldLine: offset + 1, newLine: null, text });
    return { hunks: [{ oldStart: type === "add" ? 0 : 1, oldLines: type === "add" ? 0 : rows.length,
      newStart: type === "add" ? 1 : 0, newLines: type === "add" ? rows.length : 0, lines }],
      additions: type === "add" ? rows.length : 0, deletions: type === "remove" ? rows.length : 0 };
  }
  private computeFileMeta(absPath: string): ReviewFileMeta { const bytes = fs.readFileSync(absPath); return { size: bytes.length, hash: sha256(bytes) }; }
  private atomicWriteSnapshot(runId: string, snapshot: ReviewSnapshot): void {
    const location = this.getSnapshotPath(runId);
    const pending = `${location}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(location), { recursive: true });
    fs.writeFileSync(pending, JSON.stringify(snapshot, null, 2), "utf8");
    fs.renameSync(pending, location);
  }
  private getRunDir(runId: string): string { return path.join(this.root, runId); }
  private getBeforePath(runId: string, fileHash: string): string { return path.join(this.getRunDir(runId), "before", fileHash); }
  private getJournalPath(runId: string): string { return path.join(this.getRunDir(runId), "journal.jsonl"); }
  getSnapshotPath(runId: string): string { return path.join(this.getRunDir(runId), "snapshot.json"); }
  private appendJournal(runId: string, event: JournalEvent): void {
    const location = this.getJournalPath(runId);
    fs.mkdirSync(path.dirname(location), { recursive: true });
    fs.appendFileSync(location, JSON.stringify(event) + "\n", "utf8");
  }
}
const trackers = new Map<string, RunReviewTracker>();
export function getRunReviewTracker(userDataRoot: string): RunReviewTracker {
  const root = path.resolve(userDataRoot);
  let existing = trackers.get(root);
  if (!existing) { existing = new RunReviewTracker(root); trackers.set(root, existing); }
  return existing;
}
