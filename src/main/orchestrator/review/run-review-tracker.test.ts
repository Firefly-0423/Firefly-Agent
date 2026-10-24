import { beforeEach, afterEach, describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { RunReviewTracker } from "./run-review-tracker";
import type { ReviewSnapshot } from "../../../shared/review-types";

let directory: string, review: RunReviewTracker;
const runId = "calendar-review";
const source = "amber\ncedar\nbirch\n";
function file(name: string, content?: string | Buffer) {
  const absolute = path.join(directory, name);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  if (content !== undefined) fs.writeFileSync(absolute, content);
  return absolute;
}
function capture(name: string, content?: string | Buffer, run = runId) {
  const absolute = file(name, content); review.captureBefore(run, absolute, name); return absolute;
}
function snapshot(status: "completed" | "failed" = "completed"): ReviewSnapshot {
  const result = review.finalizeReview(runId, 84_000, status);
  expect(result).not.toBeNull(); return result!;
}
function baseline(run = runId) {
  const journal = review.readJournal(run);
  expect(journal).toHaveLength(1);
  expect(journal[0].type).toEqual("capture");
  if (journal[0].type !== "capture") throw Error("Expected a capture event");
  return journal[0];
}
beforeEach(() => { directory = fs.mkdtempSync(path.join(process.cwd(), ".tmp-agenda-review-")); review = new RunReviewTracker(directory); });
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe("Review baseline capture and journal", () => {
  it("captures text metadata once per run and keeps independent run baselines", () => {
    const absolute = capture("calendar/agenda.ts", source);
    expect(review.hasReviewData(runId)).toEqual(true);
    const original = baseline();
    expect(original).toMatchObject({ exists: true, fileKind: "text", size: 18, displayPath: "calendar/agenda.ts" });
    expect(original.contentHash).toBeTruthy();
    expect(review.readBeforeContent(runId, original.hash)).toEqual(source);
    fs.writeFileSync(absolute, "Updated calendar");
    review.captureBefore(runId, absolute, "calendar/agenda.ts");
    expect(review.readJournal(runId)).toHaveLength(1);
    expect(review.readBeforeContent(runId, original.hash)).toEqual(source);
    review.captureBefore("calendar-second-run", absolute, "calendar/agenda.ts");
    expect(review.readBeforeContent("calendar-second-run", baseline("calendar-second-run").hash)).toEqual("Updated calendar");
    expect(review.readBeforeContent(runId, original.hash)).toEqual(source);
    expect(review.hasReviewData("calendar-absent")).toEqual(false);
  });

  it("represents absent and binary files without storing baseline text", () => {
    capture("calendar-new.ts");
    const missing = baseline();
    expect(missing.exists).toEqual(false);
    expect(review.readBeforeContent(runId, missing.hash)).toBeNull();
    capture("calendar.bin", Buffer.from([9, 0, 8, 0, 7]), "calendar-binary");
    const binary = baseline("calendar-binary");
    expect(binary).toMatchObject({ exists: true, fileKind: "binary" });
    expect(review.readBeforeContent("calendar-binary", binary.hash)).toBeNull();
  });

  it("records absolute and display rename paths and skips damaged journal rows", () => {
    review.recordRename(runId, "/calendar/from.ts", "/calendar/to.ts", "calendar/from.ts", "calendar/to.ts");
    expect(review.readJournal(runId)).toHaveLength(1);
    expect(review.readJournal(runId)[0]).toMatchObject({ type: "rename", fromAbsPath: path.resolve("/calendar/from.ts"), toAbsPath: path.resolve("/calendar/to.ts"), fromDisplayPath: "calendar/from.ts", toDisplayPath: "calendar/to.ts" });
    const journal = path.join(directory, "firefly-runs", "reviews", "calendar-damaged", "journal.jsonl");
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    const row = (absPath: string) => JSON.stringify({ type: "capture", absPath, displayPath: absPath.slice(1), hash: "capture-" + absPath, exists: false, fileKind: "text", size: 0, contentHash: "", capturedAt: 840 });
    fs.writeFileSync(journal, row("/calendar-first") + "\n{ damaged calendar row\n" + row("/calendar-second") + "\n");
    const recovered = review.readJournal("calendar-damaged");
    expect(recovered).toHaveLength(2);
    expect(recovered[0]).toMatchObject({ type: "capture", absPath: "/calendar-first" });
  });
});

describe("Immutable review snapshots", () => {
  it("records a modified line with precise old and new numbering and persists run metadata", () => {
    const absolute = capture("calendar.ts", source);
    fs.writeFileSync(absolute, "amber\nmaple\nbirch\n");
    const result = snapshot("failed");
    expect(result.files).toHaveLength(1);
    const changed = result.files[0];
    expect(changed).toMatchObject({ kind: "modified", additions: 1, deletions: 1 });
    expect(changed.hunks).toBeDefined(); expect(changed.hunks!.length).toBeGreaterThan(0);
    const added = changed.hunks![0].lines.find(({ type }) => type === "add");
    const removed = changed.hunks![0].lines.find(({ type }) => type === "remove");
    expect(added).toBeDefined(); expect(removed).toBeDefined();
    expect(added).toMatchObject({ oldLine: null, newLine: 2, text: "maple" });
    expect(removed).toMatchObject({ oldLine: 2, newLine: null, text: "cedar" });
    expect(result.runId).toEqual(runId); expect(result.startedAt).toEqual(84_000); expect(result.status).toEqual("failed"); expect(result.endedAt).toBeGreaterThan(84_000);
    const loaded = review.loadReview(runId);
    expect(loaded).not.toBeNull(); expect(loaded).toMatchObject({ runId, startedAt: 84_000, status: "failed" });
    expect(loaded!.files).toHaveLength(1); expect(loaded!.files[0].kind).toEqual("modified");
  });

  it.each(["created", "deleted"] as const)("represents every line of a %s file", (kind) => {
    const absolute = capture("agenda.ts", kind === "deleted" ? "morning\nevening\n" : undefined);
    if (kind === "created") fs.writeFileSync(absolute, "morning\nevening\n"); else fs.unlinkSync(absolute);
    const result = snapshot();
    expect(result.files).toHaveLength(1);
    const changed = result.files[0];
    expect(changed.kind).toEqual(kind);
    expect(changed.additions).toEqual(kind === "created" ? 2 : 0);
    expect(changed.deletions).toEqual(kind === "deleted" ? 2 : 0);
    expect(changed.hunks).toBeDefined();
    expect(changed.hunks![0].lines.every(({ type }) => type === (kind === "created" ? "add" : "remove"))).toEqual(true);
    if (kind === "created") {
      expect(changed.hunks![0].lines).toHaveLength(2);
      expect(changed.hunks![0].lines.map(({ newLine }) => newLine)).toEqual([1, 2]);
    }
  });

  it("returns no snapshot for absent or unchanged review data", () => {
    expect(review.finalizeReview("calendar-absent", 840, "completed")).toBeNull();
    capture("unchanged-agenda.ts", "Tuesday\n");
    expect(review.finalizeReview(runId, 840, "completed")).toBeNull();
  });

  it.each([false, true])("reports rename with content modification=%s", (modified) => {
    const from = capture("calendar-before.ts", "morning\nevening\n"), to = file("calendar-after.ts");
    review.recordRename(runId, from, to, "calendar-before.ts", "calendar-after.ts");
    fs.renameSync(from, to);
    if (modified) fs.writeFileSync(to, "morning\nafternoon\n");
    const result = snapshot();
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ kind: "renamed", oldPath: "calendar-before.ts", newPath: "calendar-after.ts", additions: modified ? 1 : 0, deletions: modified ? 1 : 0 });
  });

  it("keeps binary changes as metadata and includes every changed file", () => {
    const binary = capture("agenda.bin", Buffer.from([9, 0, 8, 0, 7]));
    fs.writeFileSync(binary, Buffer.from([9, 0, 8, 0, 6]));
    const changed = snapshot().files[0];
    expect(changed.kind).toEqual("binary"); expect(changed.hunks).toBeUndefined();
    expect(changed.before).toBeDefined(); expect(changed.after).toBeDefined();
    expect(changed.before!.size).toEqual(5); expect(changed.after!.size).toEqual(5);
    const modified = capture("agenda-existing.ts", "Before\n", "calendar-multi");
    capture("agenda-created.ts", undefined, "calendar-multi");
    fs.writeFileSync(modified, "After\n"); fs.writeFileSync(path.join(directory, "agenda-created.ts"), "New\n");
    const result = review.finalizeReview("calendar-multi", 840, "completed")!;
    expect(result).not.toBeNull(); expect(result.files).toHaveLength(2);
    expect(result.files.map(({ kind }) => kind).sort()).toEqual(["created", "modified"]);
  });

  it("reuses a finished snapshot and finalizes a crash recovery only when data exists", () => {
    const absolute = capture("calendar.ts", "Before\n"); fs.writeFileSync(absolute, "After\n");
    expect(review.finalizeReview(runId, 840, "completed")).not.toBeNull();
    const cached = review.finalizeIfPending(runId, 840, "halted");
    expect(cached).not.toBeNull(); expect(cached!.status).toEqual("completed"); expect(cached!.startedAt).toEqual(840);
    const crash = capture("calendar-crash.ts", "Before crash\n", "calendar-crash"); fs.writeFileSync(crash, "After crash\n");
    const recovered = review.finalizeIfPending("calendar-crash", 1680, "halted");
    expect(recovered).not.toBeNull(); expect(recovered).toMatchObject({ status: "halted", startedAt: 1680 }); expect(recovered!.files[0].kind).toEqual("modified");
    expect(review.finalizeIfPending("calendar-absent", 0, "halted")).toBeNull();
  });
});

describe("Restoring run baselines", () => {
  it("restores changed and deleted text while deleting files introduced by the run", () => {
    const changed = capture("changed-calendar.ts", source);
    fs.writeFileSync(changed, "New calendar\n");
    expect(review.restoreRun(runId)).toMatchObject({ restored: 1, failed: [], skipped: [] });
    expect(fs.readFileSync(changed, "utf8")).toEqual(source);
    const deleted = capture("deleted-calendar.ts", "Saved agenda\n", "calendar-deleted"); fs.unlinkSync(deleted);
    expect(review.restoreRun("calendar-deleted").restored).toEqual(1); expect(fs.readFileSync(deleted, "utf8")).toEqual("Saved agenda\n");
    const created = capture("created-calendar.ts", undefined, "calendar-created"); fs.writeFileSync(created, "New agenda\n");
    expect(review.restoreRun("calendar-created").restored).toEqual(1); expect(fs.existsSync(created)).toEqual(false);
  });
  it("skips binary restoration without changing its current bytes and handles empty runs", () => {
    const absolute = capture("agenda.bin", Buffer.from([9, 0, 8, 0, 7]));
    const bytes = Buffer.from([6, 6]); fs.writeFileSync(absolute, bytes);
    const result = review.restoreRun(runId);
    expect(result.restored).toEqual(0); expect(result.skipped).toHaveLength(1); expect(result.skipped[0].path).toEqual("agenda.bin");
    expect(Buffer.compare(fs.readFileSync(absolute), bytes)).toEqual(0);
    expect(review.restoreRun("calendar-absent")).toEqual({ restored: 0, skipped: [], failed: [] });
  });
  it("restores the original renamed path, removes its destination and isolates individual failures", () => {
    const from = capture("calendar-before.ts", "Saved calendar\n"), to = file("calendar-after.ts");
    review.recordRename(runId, from, to, "calendar-before.ts", "calendar-after.ts"); fs.renameSync(from, to);
    const restored = review.restoreRun(runId);
    expect(restored.restored).toEqual(2); expect(restored.failed).toHaveLength(0);
    expect(fs.existsSync(to)).toEqual(false); expect(fs.readFileSync(from, "utf8")).toEqual("Saved calendar\n");
    const good = capture("good-calendar.ts", "Good baseline\n", "calendar-isolation"); fs.writeFileSync(good, "Changed\n");
    const bad = capture("bad-calendar.ts", "Bad baseline\n", "calendar-isolation"); fs.unlinkSync(bad); fs.mkdirSync(bad);
    const partial = review.restoreRun("calendar-isolation");
    expect(partial.failed).toHaveLength(1); expect(partial.failed[0].path).toEqual("bad-calendar.ts"); expect(partial.failed[0].reason).toBeTruthy();
    expect(fs.readFileSync(good, "utf8")).toEqual("Good baseline\n");
  });
});

describe("Review retention quotas", () => {
  function directoryFor(run: string, age = 0) {
    const root = path.join(directory, "firefly-runs", "reviews", run);
    fs.mkdirSync(path.join(root, "before"), { recursive: true });
    fs.writeFileSync(path.join(root, "journal.jsonl"), "");
    fs.writeFileSync(path.join(root, "before", "calendar-baseline"), "schedule");
    const at = (Date.now() - age) / 1000; fs.utimesSync(root, at, at); return root;
  }
  it("keeps all directories while every quota is satisfied and accepts an absent root", () => {
    expect(review.cleanupOldReviews()).toEqual([]);
    const first = directoryFor("calendar-blue"), second = directoryFor("calendar-gold");
    expect(review.cleanupOldReviews()).toEqual([]);
    expect(fs.existsSync(first)).toEqual(true); expect(fs.existsSync(second)).toEqual(true);
  });
  it("removes over-age data while retaining recent directories", () => {
    const old = directoryFor("calendar-expired", 31 * 24 * 60 * 60 * 1000), recent = directoryFor("calendar-recent");
    expect(review.cleanupOldReviews()).toEqual([old]);
    expect(fs.existsSync(old)).toEqual(false); expect(fs.existsSync(recent)).toEqual(true);
  });
  it("evicts oldest first for directory count and exact byte quota", () => {
    const first = directoryFor("calendar-one", 3000), second = directoryFor("calendar-two", 2000), third = directoryFor("calendar-three", 1000);
    expect(review.cleanupOldReviews({ maxDirs: 2, maxAgeDays: 365, maxBytes: 1024 ** 3 })).toEqual([first]);
    expect(fs.existsSync(first)).toEqual(false); expect(fs.existsSync(second)).toEqual(true); expect(fs.existsSync(third)).toEqual(true);
    expect(review.cleanupOldReviews({ maxBytes: 8, maxAgeDays: 365, maxDirs: 200 })).toEqual([second]);
    expect(fs.existsSync(second)).toEqual(false); expect(fs.existsSync(third)).toEqual(true);
  });
});
