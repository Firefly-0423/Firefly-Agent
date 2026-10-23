import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RunReviewTracker } from "./run-review-tracker";
import type { WorkspaceSnapshot } from "../tools/workspace-handle";
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-review-large-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
function snapshot(file: string, bytes: Buffer): WorkspaceSnapshot {
  return { exists: true, kind: "file", size: bytes.length, canonicalPath: file, bytes,
    identity: { deviceId: "00000000000000000000000000000007", fileId: "00000000000000000000000000000042" } };
}
it.each([false, true])("existing native files over 5 MiB changed=%s retain exact hash evidence", changed => {
  const file = path.join(root, "large.bin"), before = Buffer.alloc(6 * 1024 * 1024, 65), after = changed ? Buffer.alloc(before.length, 66) : before;
  const tracker = new RunReviewTracker(root);
  tracker.captureBefore("large", file, undefined, snapshot(file, before));
  tracker.recordHandleAfter("large", file, snapshot(file, after));
  const review = new RunReviewTracker(root).finalizeReview("large", 1, "completed");
  if (!changed) expect(review).toBeNull();
  else expect(review?.files[0]).toMatchObject({ kind: "binary",
    before: { size: before.length, hash: createHash("sha256").update(before).digest("hex") },
    after: { size: after.length, hash: createHash("sha256").update(after).digest("hex") } });
  expect(fs.existsSync(file)).toBe(false); // Neither baseline nor finalization may open the original target.
});
